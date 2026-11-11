/**
 * 一句话问条款（docs/PLAN.md §6）：检索 → 组织证据 → 生成 → 引用校验。
 *
 * 固定四步，任何一步不过就退化成「列出相关条款原文」，不给结论：
 * 1. 本地 FTS5 检索，一条都没命中就直接拒答（不花模型的钱）；
 * 2. 送出去之前脱敏，出口仍有标识符就整批阻断；
 * 3. 模型只能引用本地检索到的条款（送进去的是 C1…Cn），引文必须能反查原文；
 * 4. 模型自己说「条款不足以回答」、或者引文一条都没通过，就只展示原文，不展示结论。
 *
 * 和估算页的分工：估算回答「这个情况大概报多少」，这里回答「条款怎么写的、依据哪一条」，
 * 不判断保险公司实际赔不赔。
 */

import type { DatabaseSync } from "node:sqlite";
import { findEntityLeaks, findLeaks, redactDocument, type RedactionEntry } from "./redact";
import { DEEPSEEK_MODEL, deepseekConfigured, deepseekJson, type ChatMessage } from "./ai/deepseek";
import { quoteMatches } from "./ai/enrich";
import { searchClauses, toRelated, type RelatedClause, type SearchHit } from "./search";

// 改了 systemPrompt 的字段或规则就跟着改，记进 qa_log，事后能对上是哪一版答的
export const QA_PROMPT_VERSION = "qa-v1";

const MAX_REF_CHARS = 4000;
const MAX_POINTS = 6;
const MAX_CITATIONS = 8;
const MAX_LISTS = 6;
const MAX_QUOTE_CHARS = 400;

export type QaReason =
  | "no-match"
  | "insufficient"
  | "unverified"
  | "missing-key"
  | "upstream"
  | "redaction";

export type QaCitation = {
  ref: string;
  documentId: number;
  clauseNo: string;
  page: number;
  quote: string;
  productName: string | null;
};

export type QaAnswer = {
  question: string;
  /** answered = 有结论且引文通过；related-only = 只列原文；refused = 没检索到 */
  kind: "answered" | "related-only" | "refused";
  reason: QaReason | null;
  points: string[];
  calculation: string | null;
  conditions: string[];
  missing: string[];
  citations: QaCitation[];
  related: RelatedClause[];
  rejected: number;
  tokens: number;
  model: string;
};

export type QaPrep = {
  messages: ChatMessage[];
  /** C1… → 脱敏后的条款正文；引文反查对着它做 */
  redacted: Map<string, string>;
  restore: (value: string) => string;
};

function systemPrompt(): string {
  return [
    "你是家庭保单的条款速查助手。只输出一个 JSON 对象，不要 markdown、不要解释。",
    "你会收到一个问题（已脱敏）和若干条从保单里检索出来的条款原文。只能依据这些条款回答。",
    "必须遵守：",
    "1. 不得引入条款以外的知识（不说「一般保险公司会…」），不得假设没给出的信息；",
    "2. 只回答「条款怎么规定、依据哪一条」，不判断保险公司实际会不会赔；",
    "3. 每条结论都要有 citations：ref 填条款编号（C1、C2…，照抄输入），quote 必须逐字摘自该条款原文，不得改写、不得拼接；",
    "4. 条款没写清楚的、需要投保人自己确认的（医院等级、合理且必要、既往症事实等）写进 missing，不要猜；",
    "5. 涉及金额时，把算式写在 calculation 里；条款推不出确切金额就填 null；",
    "6. 检索到的条款不足以回答问题时，sufficient 填 false，points 留空，不要硬答。",
    '输出格式：{"sufficient":true,"points":["…"],"calculation":"…"或null,"conditions":["…"],"citations":[{"ref":"C1","quote":"…"}],"missing":["…"]}',
  ].join("\n");
}

function asText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function asList(value: unknown, limit: number, maxItems = MAX_LISTS): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asText(item, limit))
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

export function prepareQaMessages(question: string, hits: SearchHit[]): QaPrep {
  const entries: RedactionEntry[] = [];
  const redacted = new Map<string, string>();

  const blocks = hits.map((hit, index) => {
    const ref = `C${index + 1}`;
    const result = redactDocument(hit.text.slice(0, MAX_REF_CHARS));
    entries.push(...result.entries);
    redacted.set(ref, result.text);
    const head = [
      ref,
      hit.productName ? `产品：${hit.productName}` : "",
      `条款 ${hit.clauseNo}`,
      `P${hit.page}`,
    ]
      .filter(Boolean)
      .join(" · ");
    return `<<<${head}>>>\n${result.text}`;
  });

  const safeQuestion = redactDocument(question);
  entries.push(...safeQuestion.entries);

  const user = [
    `【问题】\n${safeQuestion.text}`,
    "【检索到的条款】（前面方括号里是引用编号，引用时填 C1 这种编号）",
    blocks.join("\n\n"),
    "请只依据上面的条款回答，并给出能逐字反查的引文。",
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: user },
  ];

  const sent = messages.map((message) => message.content).join("\n");
  const leaks = [...findLeaks(sent), ...findEntityLeaks(sent, entries)];
  if (leaks.length > 0) {
    throw new QaError("redaction", `leaks:${leaks.map((leak) => leak.type).join(",")}`);
  }

  const restore = (value: string): string =>
    entries.reduce((acc, entry) => acc.split(entry.placeholder).join(entry.entity_value), value);

  return { messages, redacted, restore };
}

export class QaError extends Error {
  readonly code: "redaction" | "bad_response";

  constructor(code: QaError["code"], message?: string) {
    super(message ?? code);
    this.name = "QaError";
    this.code = code;
  }
}

/**
 * 引文校验的宽容度：先按模型说的 ref 查；查不到再在其它检索结果里找同一句原文。
 * 找得到就归到真正包含它的那条条款上（quote 是真的）；哪里都没有才算丢弃。
 */
export function normalizeQaAnswer(
  data: unknown,
  hits: SearchHit[],
  redacted: Map<string, string>,
  restore: (value: string) => string,
): Omit<QaAnswer, "question" | "related" | "tokens" | "model" | "kind" | "reason"> & {
  sufficient: boolean;
} {
  const payload = (data ?? {}) as {
    sufficient?: unknown;
    points?: unknown;
    calculation?: unknown;
    conditions?: unknown;
    citations?: unknown;
    missing?: unknown;
  };

  const byRef = new Map<string, SearchHit>(
    hits.map((hit, index) => [`C${index + 1}`, hit] as [string, SearchHit]),
  );
  const citations: QaCitation[] = [];
  const used = new Set<string>();
  let rejected = 0;

  const rawCitations = Array.isArray(payload.citations) ? payload.citations.slice(0, MAX_CITATIONS * 2) : [];
  for (const raw of rawCitations) {
    const item = (raw ?? {}) as { ref?: unknown; quote?: unknown };
    const ref = asText(item.ref, 8).toUpperCase().replace(/^第?/, "");
    const quote = asText(item.quote, MAX_QUOTE_CHARS);
    if (!quote) {
      rejected += 1;
      continue;
    }

    let hit = byRef.get(ref);
    let matched = hit ? quoteMatches(redacted.get(ref) ?? hit.text, quote) : false;

    if (!matched) {
      for (const [otherRef, other] of byRef) {
        if (otherRef === ref) continue;
        if (quoteMatches(redacted.get(otherRef) ?? other.text, quote)) {
          hit = other;
          matched = true;
          break;
        }
      }
    }

    if (!matched || !hit) {
      rejected += 1;
      continue;
    }

    const key = `${hit.clauseId}\u0000${quote}`;
    if (used.has(key)) continue;
    used.add(key);

    citations.push({
      ref: ref || `C${hits.indexOf(hit) + 1}`,
      documentId: hit.documentId,
      clauseNo: hit.clauseNo,
      page: hit.page,
      quote: restore(quote),
      productName: hit.productName,
    });
    if (citations.length >= MAX_CITATIONS) break;
  }

  const points = asList(payload.points, 300, MAX_POINTS).map(restore);
  const sufficient = payload.sufficient === true;

  return {
    sufficient,
    points: sufficient ? points : [],
    calculation: sufficient ? (asText(payload.calculation, 600) || null) : null,
    conditions: asList(payload.conditions, 160).map(restore),
    missing: asList(payload.missing, 200).map(restore),
    citations,
    rejected,
  };
}

function baseAnswer(question: string, related: RelatedClause[]): QaAnswer {
  return {
    question,
    kind: "refused",
    reason: "no-match",
    points: [],
    calculation: null,
    conditions: [],
    missing: [],
    citations: [],
    related,
    rejected: 0,
    tokens: 0,
    model: DEEPSEEK_MODEL,
  };
}

export function logQa(db: DatabaseSync, answer: QaAnswer): void {
  db.prepare("INSERT INTO qa_log (question, answer, citations) VALUES (?, ?, ?)").run(
    answer.question,
    JSON.stringify({
      prompt: QA_PROMPT_VERSION,
      kind: answer.kind,
      reason: answer.reason,
      points: answer.points,
      calculation: answer.calculation,
      conditions: answer.conditions,
      missing: answer.missing,
      rejected: answer.rejected,
      tokens: answer.tokens,
      model: answer.model,
    }),
    JSON.stringify(answer.citations),
  );
}

/** 只做本地检索（免费、同步），页面先拿它决定「有没有东西可答」。 */
export function retrieveClauses(db: DatabaseSync, question: string): RelatedClause[] {
  if (question.trim().length < 2) return [];
  return toRelated(searchClauses(db, question));
}

export async function answerQuestion(
  db: DatabaseSync,
  question: string,
  options: { documentId?: number | null } = {},
): Promise<QaAnswer> {
  const hits = searchClauses(db, question, { documentId: options.documentId ?? null });
  const related = toRelated(hits);

  // 一条都没命中：不花模型的钱，直接说不回答
  if (hits.length === 0) return baseAnswer(question, related);

  if (!deepseekConfigured()) {
    return { ...baseAnswer(question, related), reason: "missing-key" };
  }

  let prepared: QaPrep;
  try {
    prepared = prepareQaMessages(question, hits);
  } catch (cause) {
    const reason = cause instanceof QaError ? "redaction" : "upstream";
    return { ...baseAnswer(question, related), reason };
  }

  let result: { data: unknown; tokens: number };
  try {
    result = await deepseekJson(prepared.messages, { timeoutMs: 45_000, retries: 1 });
  } catch {
    return { ...baseAnswer(question, related), reason: "upstream" };
  }

  if (!result.data || typeof result.data !== "object") {
    return { ...baseAnswer(question, related), reason: "upstream" };
  }

  const normalized = normalizeQaAnswer(result.data, hits, prepared.redacted, prepared.restore);

  // 引文一条都没通过、或者模型自己说不够：只给原文，不给结论
  let kind: QaAnswer["kind"] = "answered";
  let reason: QaReason | null = null;
  if (normalized.citations.length === 0) {
    kind = "related-only";
    reason = "unverified";
  } else if (!normalized.sufficient || normalized.points.length === 0) {
    kind = "related-only";
    reason = "insufficient";
  }

  const answer: QaAnswer = {
    question,
    kind,
    reason,
    points: normalized.points,
    calculation: normalized.calculation,
    conditions: normalized.conditions,
    missing: normalized.missing,
    citations: normalized.citations,
    related,
    rejected: normalized.rejected,
    tokens: result.tokens,
    model: DEEPSEEK_MODEL,
  };

  logQa(db, answer);
  return answer;
}
