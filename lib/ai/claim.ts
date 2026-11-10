/**
 * AI 理赔分析：把「本次情况 + 条款原文」交给模型独立判断能不能赔、大概赔多少。
 *
 * 和 `estimate.ts` 的分工：
 * - `estimate.ts` 是确定性算术，只认条款里的比例与限额，结果可复现；
 * - 这里让模型读同一份条款独立给结论，用作交叉核对。
 *
 * 硬规则沿用项目既有约定（docs/PLAN.md §8.1）：
 * 1. 送出去之前脱敏，仍命中标识符就整批阻断；
 * 2. 每条 citation 的 quote 必须能在条款原文里反查到，反查不过直接丢；
 * 3. 模型不能改条款号/页码，引用只认本地切分出来的那些条款。
 *
 * 故意不把本地算出的金额放进提示词：避免模型照抄，两个结果才有的对照。
 */

import { findEntityLeaks, findLeaks, redactDocument, type RedactionEntry } from "../redact";
import type { EstimateInput } from "../estimate";
import { DEEPSEEK_MODEL, deepseekConfigured, deepseekJson, type ChatMessage } from "./deepseek";
import { quoteMatches } from "./enrich";

const MAX_CLAUSE_CHARS = 3200;
const MAX_QUOTE_CHARS = 400;
const MAX_REASONING = 8;
const MAX_CITATIONS = 10;

const VERDICTS = new Set(["covered", "partly", "not_covered", "uncertain"]);

export type ClaimVerdict = "covered" | "partly" | "not_covered" | "uncertain";

export type ClaimClause = { clauseNo: string; page: number; text: string };

export type ClaimContext = {
  benefitName: string;
  scopes: string[];
  clauses: ClaimClause[];
};

export type ClaimCitation = {
  clauseNo: string;
  page: number | null;
  quote: string;
  /** quote 是否在本地条款原文里反查通过（不通过的不会出现在结果里） */
  verified: boolean;
};

export type ClaimAnalysis = {
  verdict: ClaimVerdict;
  payable: number | null;
  reasoning: string[];
  conditions: string[];
  citations: ClaimCitation[];
  /** 推理里最后算出的金额；与 payable 不一致时，界面要提示以推理为准核对 */
  payableInReasoning: number | null;
  /** 引文反查失败被丢弃的条数 */
  rejected: number;
  tokens: number;
  model: string;
};

export class ClaimAnalysisError extends Error {
  readonly code: "missing_api_key" | "redaction_leak" | "bad_response" | "upstream";

  constructor(code: ClaimAnalysisError["code"], message?: string) {
    super(message ?? code);
    this.name = "ClaimAnalysisError";
    this.code = code;
  }
}

function systemPrompt(): string {
  return [
    "你是保险条款理赔分析助手。只输出一个 JSON 对象，不要解释。",
    "你会收到一份保单的条款原文（已脱敏）和投保人的实际情况。请只依据条款判断这次能不能赔、大概赔多少。",
    "必须遵守：",
    "1. 只用给出的条款原文，不得引入条款以外的知识，不得假设没给出的信息（如医院等级、是否合理且必要）；",
    "2. 金额一律用人民币元、只填数字；推不出确切金额就填 null，不要编；",
    "3. 每条结论都要有 citations，quote 必须逐字摘自条款原文，不得改写、不得拼接；找不到原文就别写这条结论；",
    "4. 分段比例必须逐段算（如余额 20000 元：5000×80% + 15000×100%），payable 必须等于推理里最后算出的数字；两者不一致会被判为无效；",
    "5. 条款信息不足或互相矛盾时，verdict 用 uncertain，并在 reasoning 里写清楚缺什么；",
    "6. 不做医疗建议，不评价产品好坏。",
    "verdict 只能取：covered（可以赔）、partly（部分可赔或有扣减）、not_covered（不赔）、uncertain（条款不足以判断）。",
    '输出格式：{"verdict":"partly","payable":19000,"reasoning":["..."],"conditions":["..."],"citations":[{"clause_no":"附表1","quote":"..."}]}',
  ].join("\n");
}

function money(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function situationBlock(input: EstimateInput, context: ClaimContext): string {
  const lines = [
    `- 保险责任：${context.benefitName}（条款允许的就诊范围：${context.scopes.join("、") || "未识别"}）`,
    `- 本次就诊范围：${input.scope}`,
    `- 责任范围内医疗费用：${money(input.totalCost)} 元`,
    `- 社保 / 公费 / 补充医疗已补偿：${money(input.socialPaid)} 元`,
    `- 其他途径（单位、其他商业保险）已补偿：${money(input.otherPaid)} 元`,
    `- 是否以社保身份就诊：${input.usedSocial ? "是" : "否"}`,
    `- 费用中属于医保目录内的金额：${
      input.catalogCost === null ? "未提供" : `${money(input.catalogCost)} 元`
    }`,
    `- 费用发生时间：${input.inWaiting ? "等待期内" : "等待期后"}`,
    `- 是否命中责任免除：${input.exclusion ?? "否"}`,
    `- 本保险期间已累计赔付：${money(input.paidThisYear)} 元`,
  ];
  if (input.annualLimit !== null) lines.push(`- 每一保险期间累计给付限额：${money(input.annualLimit)} 元`);

  // 分项限额和给付比例表也要告诉模型，否则两边算出来的口径对不上
  for (const item of input.subLimits ?? []) {
    if (item.amount <= 0 || item.limit <= 0) continue;
    lines.push(`- 分项限额：${item.label} 合同单独限额 ${money(item.limit)} 元，本次该类费用 ${money(item.amount)} 元`);
  }
  if (typeof input.flatRatio === "number") {
    lines.push(`- 给付比例表：投保人按条款附表查到的比例是 ${input.flatRatio}%（按保额 × 比例给付）`);
  }

  return ["【本次情况】", ...lines].join("\n");
}

export type PreparedClaimPrompt = {
  messages: ChatMessage[];
  redactedByNo: Map<string, string>;
  restore: (value: string) => string;
  entries: RedactionEntry[];
};

/** 组装提示词并脱敏；仍有标识符泄漏时抛 redaction_leak，绝不发出去。 */
export function prepareClaimMessages(input: EstimateInput, context: ClaimContext): PreparedClaimPrompt {
  const entries: RedactionEntry[] = [];
  const redactedByNo = new Map<string, string>();

  const blocks = context.clauses.map((clause) => {
    const redacted = redactDocument(clause.text.slice(0, MAX_CLAUSE_CHARS));
    entries.push(...redacted.entries);
    redactedByNo.set(clause.clauseNo, redacted.text);
    return `<<<CLAUSE ${clause.clauseNo} · P${clause.page}>>>\n${redacted.text}`;
  });

  const user = [
    situationBlock(input, context),
    "【条款原文】（每条前面的编号与页码是本地切分结果，引用时照抄）",
    blocks.join("\n\n"),
    "请按条款给出判断，并给出可反查的引文。",
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: user },
  ];

  const sent = messages.map((message) => message.content).join("\n");
  const leaks = [...findLeaks(sent), ...findEntityLeaks(sent, entries)];
  if (leaks.length > 0) {
    throw new ClaimAnalysisError("redaction_leak", `leaks:${leaks.map((leak) => leak.type).join(",")}`);
  }

  const restore = (value: string): string =>
    entries.reduce((acc, entry) => acc.split(entry.placeholder).join(entry.entity_value), value);

  return { messages, redactedByNo, restore, entries };
}

function asText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** 推理里最后提到的金额（「400万元」这种带万字的不算，避免把限额当成结论）。 */
export function lastAmountInReasoning(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const matches = [...lines[i].matchAll(/(\d[\d,]*(?:\.\d+)?)\s*元/g)];
    const last = matches[matches.length - 1];
    if (last) return Number(last[1].replace(/,/g, ""));
  }
  return null;
}

function asList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asText(item, 240))
    .filter((item) => item.length > 0)
    .slice(0, limit);
}

export function normalizeClaimAnalysis(
  data: unknown,
  context: ClaimContext,
  redactedByNo: Map<string, string>,
  restore: (value: string) => string,
  maxPayable: number,
): Omit<ClaimAnalysis, "tokens" | "model"> {
  const payload = (data ?? {}) as {
    verdict?: unknown;
    payable?: unknown;
    reasoning?: unknown;
    conditions?: unknown;
    citations?: unknown;
  };

  const verdictRaw = asText(payload.verdict, 20);
  const verdict = (VERDICTS.has(verdictRaw) ? verdictRaw : "uncertain") as ClaimVerdict;

  const payableRaw = Number(payload.payable);
  const payable =
    payload.payable === null || payload.payable === undefined || !Number.isFinite(payableRaw)
      ? null
      : Math.max(0, Math.min(Math.round(payableRaw * 100) / 100, Math.max(0, maxPayable)));

  const reasoning = asList(payload.reasoning, MAX_REASONING).map(restore);
  const conditions = asList(payload.conditions, MAX_REASONING).map(restore);

  const byNo = new Map(context.clauses.map((clause) => [clause.clauseNo, clause]));
  const citations: ClaimCitation[] = [];
  let rejected = 0;

  const rawCitations = Array.isArray(payload.citations) ? payload.citations.slice(0, MAX_CITATIONS * 2) : [];
  for (const raw of rawCitations) {
    const item = (raw ?? {}) as { clause_no?: unknown; quote?: unknown };
    const clauseNo = asText(item.clause_no, 20).replace(/^第?/, "");
    const clause = byNo.get(clauseNo);
    const quote = asText(item.quote, MAX_QUOTE_CHARS);
    if (!clause || !quote) {
      rejected += 1;
      continue;
    }

    const source = redactedByNo.get(clause.clauseNo) ?? "";
    if (!quoteMatches(source, quote)) {
      rejected += 1;
      continue;
    }

    if (citations.length >= MAX_CITATIONS) break;
    citations.push({
      clauseNo: clause.clauseNo,
      page: clause.page,
      quote: restore(quote),
      verified: true,
    });
  }

  const reasoningAmount = lastAmountInReasoning(reasoning);
  // 模型自己前后不一致时不要替它圆场，交给界面提示对照
  const payableInReasoning =
    payable !== null && reasoningAmount !== null && Math.abs(payable - reasoningAmount) > 0.5
      ? reasoningAmount
      : null;

  return { verdict, payable, reasoning, conditions, citations, rejected, payableInReasoning };
}

export async function analyzeClaim(input: EstimateInput, context: ClaimContext): Promise<ClaimAnalysis> {
  if (!deepseekConfigured()) throw new ClaimAnalysisError("missing_api_key");

  const prepared = prepareClaimMessages(input, context);

  let result: { data: unknown; tokens: number };
  try {
    result = await deepseekJson(prepared.messages, { timeoutMs: 45_000, retries: 1 });
  } catch (cause) {
    throw new ClaimAnalysisError(
      "upstream",
      cause instanceof Error ? cause.message : "network_error",
    );
  }

  if (!result.data || typeof result.data !== "object") {
    throw new ClaimAnalysisError("bad_response");
  }

  const analysis = normalizeClaimAnalysis(
    result.data,
    context,
    prepared.redactedByNo,
    prepared.restore,
    input.totalCost,
  );

  return { ...analysis, tokens: result.tokens, model: DEEPSEEK_MODEL };
}
