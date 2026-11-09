/**
 * AI 增补：把本地规则切出来的条款送去结构化，结果只做「补充」不做「覆盖」。
 *
 * 三条硬规则（docs/PLAN.md §8.1 / P2）：
 * 1. 送出去之前整体脱敏，仍有标识符就整批阻断（宁可不抽）；
 * 2. 模型给的每条 quote 必须在（脱敏后的）条款原文里对得上，对不上直接丢；
 * 3. 模型只补字段，不改条款号/页码/正文——本地切分的结构始终为准。
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db";
import { findEntityLeaks, findLeaks, redactDocument, type RedactionEntry } from "../redact";
import { DEEPSEEK_MODEL, deepseekConfigured, deepseekJson, type ChatMessage } from "./deepseek";

const KEY_CATEGORIES = new Set([
  "coverage",
  "exclusion",
  "limit",
  "waiting_period",
  "renewal",
  "definition",
]);

const PRIORITY = ["coverage", "exclusion", "limit", "waiting_period", "renewal", "definition"];
const MAX_CLAUSES = 12;
const PER_BATCH = 3;
const MAX_CHARS = 2600;
const BUDGET_MS = 45_000;
const SEP = "\n<<<CLAUSE>>>\n";

const KINDS = new Set([
  "coverage",
  "exclusion",
  "limit",
  "waiting_period",
  "renewal",
  "definition",
  "premium",
  "termination",
  "claims",
  "other",
]);

export type AiFact = {
  type: string;
  label: string;
  value: string;
  unit: string;
  condition: string;
  quote: string;
};

export type EnrichSummary = {
  status: "succeeded" | "partial" | "failed" | "skipped";
  clauses: number;
  facts: number;
  rejected: number;
  tokens: number;
  error?: string;
};

type ClauseRow = {
  id: number;
  seq: number;
  clause_no: string | null;
  heading_path: string | null;
  category: string | null;
  text: string;
  page_from: number;
};

export function normalizeForQuote(text: string): string {
  return text
    .replace(/[\s\u00a0\u3000]/g, "")
    .replace(/[，。；：、,.;:!?！？"'“”‘’（）()《》【】]/g, "");
}

function bigrams(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const key = text.slice(i, i + 2);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** 引文反查：包含即可；不包含时用 bigram Dice 系数，阈值 0.9。 */
export function quoteMatches(clauseText: string, quote: string): boolean {
  const text = normalizeForQuote(clauseText);
  const target = normalizeForQuote(quote);
  if (target.length < 4) return false;
  if (text.includes(target)) return true;

  const a = bigrams(text);
  const b = bigrams(target);
  if (b.size === 0) return false;

  let overlap = 0;
  for (const [key, count] of b) overlap += Math.min(count, a.get(key) ?? 0);

  const total = [...a.values()].reduce((sum, n) => sum + n, 0) + [...b.values()].reduce((sum, n) => sum + n, 0);
  return total > 0 && (2 * overlap) / total >= 0.9;
}

/** 选送模型的条款：先按类别优先级，再按顺序，且限制条数。 */
export function selectClauses(rows: ClauseRow[], max = MAX_CLAUSES): ClauseRow[] {
  const eligible = rows.filter((row) => KEY_CATEGORIES.has(row.category ?? "other"));
  const ordered = [...eligible].sort((a, b) => {
    const pa = PRIORITY.indexOf(a.category ?? "other");
    const pb = PRIORITY.indexOf(b.category ?? "other");
    return pa === pb ? a.seq - b.seq : pa - pb;
  });
  return ordered.slice(0, max).sort((a, b) => a.seq - b.seq);
}

function systemPrompt(): string {
  return [
    "你是保险条款结构化抽取器。只输出一个 JSON 对象，不要解释。",
    "你的抽取结果会作为主结果展示，本地规则只补你没覆盖到的条款；所以宁少勿错，但该给的字段要给全。",
    "输入是一个条款数组，每项含 clause_no、heading、text。",
    "对每一条输出：kind（条款类别）、summary（不超过 40 字）、facts（最多 8 条关键事实）。",
    "kind 只能取：coverage/exclusion/limit/waiting_period/renewal/definition/premium/termination/claims/other。",
    "facts 每项含：type（limit|ratio|deductible|waiting_period|scope|condition|period|other）、label、value、unit、condition、quote。",
    "quote 必须逐字摘自该条款 text，不得改写、不得拼接；找不到原文就整条 facts 不输出。",
    "value 只填数字或最短陈述；条件写进 condition（如「未以社保身份就诊」）。",
    "条款没写的内容一律不要补；不确定就少给字段。",
    "输出格式：{\"clauses\":[{\"clause_no\":\"2.5\",\"kind\":\"coverage\",\"summary\":\"...\",\"facts\":[{\"type\":\"limit\",\"label\":\"年度给付限额\",\"value\":\"400\",\"unit\":\"万元\",\"condition\":\"\",\"quote\":\"...\"}]}]}",
  ].join("\n");
}

type RawFact = Partial<Record<keyof AiFact, unknown>>;
type RawClause = { clause_no?: unknown; kind?: unknown; summary?: unknown; facts?: unknown };

function asText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function normalizeAiClauses(
  data: unknown,
  clauses: ClauseRow[],
  redactedByNo: Map<string, string>,
  restore: (value: string) => string,
): { rows: { clause: ClauseRow; kind: string; summary: string; facts: AiFact[]; review: "ok" | "needs_review" }[]; rejected: number } {
  const payload = data as { clauses?: unknown };
  const list = Array.isArray(payload?.clauses) ? (payload.clauses as RawClause[]) : [];
  const byNo = new Map(clauses.map((clause) => [clause.clause_no ?? "", clause]));

  const rows: { clause: ClauseRow; kind: string; summary: string; facts: AiFact[]; review: "ok" | "needs_review" }[] = [];
  let rejected = 0;

  for (const raw of list) {
    const no = asText(raw?.clause_no, 20);
    const clause = byNo.get(no);
    if (!clause) {
      rejected += 1;
      continue;
    }

    const redacted = redactedByNo.get(no) ?? "";
    const rawFacts = Array.isArray(raw?.facts) ? (raw.facts as RawFact[]).slice(0, 8) : [];
    const facts: AiFact[] = [];

    for (const fact of rawFacts) {
      const quote = asText(fact?.quote, 400);
      // 反查不过就是幻觉，直接丢（P2）
      if (!quote || !quoteMatches(redacted, quote)) {
        rejected += 1;
        continue;
      }
      facts.push({
        type: asText(fact?.type, 24) || "other",
        label: restore(asText(fact?.label, 40)),
        value: restore(asText(fact?.value, 60)),
        unit: restore(asText(fact?.unit, 12)),
        condition: restore(asText(fact?.condition, 80)),
        quote: restore(quote),
      });
    }

    const kindRaw = asText(raw?.kind, 24);
    rows.push({
      clause,
      kind: KINDS.has(kindRaw) ? kindRaw : (clause.category ?? "other"),
      summary: restore(asText(raw?.summary, 120)),
      facts,
      review: facts.length > 0 ? "ok" : "needs_review",
    });
  }

  return { rows, rejected };
}

export type AiClauseRow = {
  clause_id: number;
  kind: string;
  review_status: string;
  facts: AiFact[];
};

const TERM_TYPES = new Set(["limit", "ratio", "deductible", "waiting_period", "period"]);

export type StructuredPlan = {
  exclusions: { category: string; text: string; citation_clause_id: number; confidence: number; review_status: string }[];
  terms: { kind: string; value: string; citation_clause_id: number; confidence: number; review_status: string }[];
};

/**
 * 把 AI 要点落到责任/免责表：免责条款的事实进 exclusion，带数值条件的事实进 term。
 * 只做“把话说全”的拼接，不新增原文没有的内容。
 */
export function planStructuredRows(rows: AiClauseRow[]): StructuredPlan {
  const plan: StructuredPlan = { exclusions: [], terms: [] };

  for (const row of rows) {
    for (const fact of row.facts) {
      const tail = [fact.value, fact.unit, fact.condition].filter(Boolean).join(" ");
      const text = fact.label ? `${fact.label}：${tail}` : tail;

      if (row.kind === "exclusion") {
        plan.exclusions.push({
          category: fact.type,
          text,
          citation_clause_id: row.clause_id,
          confidence: 0.75,
          review_status: row.review_status,
        });
      }

      if (TERM_TYPES.has(fact.type)) {
        plan.terms.push({
          kind: fact.type,
          value: tail,
          citation_clause_id: row.clause_id,
          confidence: 0.75,
          review_status: row.review_status,
        });
      }
    }
  }

  return { exclusions: plan.exclusions.slice(0, 60), terms: plan.terms.slice(0, 80) };
}

function persistStructured(db: DatabaseSync, documentId: number, plan: StructuredPlan): void {
  const policy = db
    .prepare("SELECT id FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1")
    .get(documentId) as { id: number } | undefined;
  if (!policy) return;

  // 重跑时只换掉上一轮的 AI 行，本地规则行不动
  db.prepare("DELETE FROM exclusion WHERE policy_id = ? AND source = 'ai'").run(policy.id);
  db.prepare("DELETE FROM term WHERE policy_id = ? AND source = 'ai'").run(policy.id);

  const insertExclusion = db.prepare(
    "INSERT INTO exclusion (policy_id, category, text, citation_clause_id, confidence, review_status, source) VALUES (?, ?, ?, ?, ?, ?, 'ai')",
  );
  for (const row of plan.exclusions) {
    insertExclusion.run(policy.id, row.category, row.text, row.citation_clause_id, row.confidence, row.review_status);
  }

  const insertTerm = db.prepare(
    "INSERT INTO term (policy_id, kind, value, citation_clause_id, confidence, review_status, source) VALUES (?, ?, ?, ?, ?, ?, 'ai')",
  );
  for (const row of plan.terms) {
    insertTerm.run(policy.id, row.kind, row.value, row.citation_clause_id, row.confidence, row.review_status);
  }
}

export async function enrichDocument(documentId: number): Promise<EnrichSummary> {
  if (!deepseekConfigured()) {
    return { status: "skipped", clauses: 0, facts: 0, rejected: 0, tokens: 0 };
  }

  const db = getDb();
  const all = db
    .prepare(
      "SELECT id, seq, clause_no, heading_path, category, text, page_from FROM clause WHERE document_id = ? ORDER BY seq",
    )
    .all(documentId) as unknown as ClauseRow[];

  const selected = selectClauses(all);
  if (selected.length === 0) {
    return { status: "skipped", clauses: 0, facts: 0, rejected: 0, tokens: 0 };
  }

  // 一次性脱敏，保证同一实体在各批次里占位符一致
  const joined = selected.map((clause) => clause.text).join(SEP);
  const redaction = redactDocument(joined);
  const parts = redaction.text.split(SEP);
  const redactedByNo = new Map<string, string>();
  selected.forEach((clause, index) => {
    redactedByNo.set(clause.clause_no ?? "", parts[index] ?? "");
  });

  const leaks = [
    ...findLeaks(redaction.text),
    ...findEntityLeaks(redaction.text, redaction.entries),
  ];
  if (leaks.length > 0) {
    recordRun(db, documentId, "failed", 0, "redaction_blocked");
    return { status: "failed", clauses: 0, facts: 0, rejected: 0, tokens: 0, error: "redaction_blocked" };
  }

  saveRedactionMap(db, documentId, redaction.entries);

  const structured: AiClauseRow[] = [];

  const startedAt = Date.now();
  let tokens = 0;
  let rejected = 0;
  let clauseCount = 0;
  let factCount = 0;
  let failedBatches = 0;
  let batches = 0;

  for (let i = 0; i < selected.length; i += PER_BATCH) {
    if (Date.now() - startedAt > BUDGET_MS) break;

    const batch = selected.slice(i, i + PER_BATCH);
    const payload = {
      clauses: batch.map((clause) => ({
        clause_no: clause.clause_no,
        heading: clause.heading_path ?? "",
        text: (redactedByNo.get(clause.clause_no ?? "") ?? "").slice(0, MAX_CHARS),
      })),
    };

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: JSON.stringify(payload) },
    ];

    batches += 1;
    try {
      const result = await deepseekJson(messages, { timeoutMs: 20_000 });
      tokens += result.tokens;

      const normalized = normalizeAiClauses(result.data, batch, redactedByNo, redaction.restore);
      rejected += normalized.rejected;

      const insert = db.prepare(
        "INSERT OR REPLACE INTO clause_ai (clause_id, model, kind, summary, data, confidence, review_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of normalized.rows) {
        insert.run(
          row.clause.id,
          DEEPSEEK_MODEL,
          row.kind,
          row.summary,
          JSON.stringify({ facts: row.facts }),
          row.facts.length > 0 ? 0.75 : 0.3,
          row.review,
        );
        clauseCount += 1;
        factCount += row.facts.length;
        structured.push({
          clause_id: row.clause.id,
          kind: row.kind,
          review_status: row.review,
          facts: row.facts,
        });
      }
    } catch (cause) {
      failedBatches += 1;
      if (failedBatches === batches) {
        const message = cause instanceof Error ? cause.message : String(cause);
        recordRun(db, documentId, "failed", tokens, message);
        return {
          status: "failed",
          clauses: clauseCount,
          facts: factCount,
          rejected,
          tokens,
          error: message,
        };
      }
    }
  }

  if (structured.length > 0) persistStructured(db, documentId, planStructuredRows(structured));

  const status = failedBatches > 0 ? "partial" : "succeeded";
  recordRun(db, documentId, status, tokens);
  return { status, clauses: clauseCount, facts: factCount, rejected, tokens };
}

function saveRedactionMap(db: DatabaseSync, documentId: number, entries: RedactionEntry[]): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO redaction_map (document_id, placeholder, entity_type, entity_value) VALUES (?, ?, ?, ?)",
  );
  for (const entry of entries) {
    insert.run(documentId, entry.placeholder, entry.entity_type, entry.entity_value);
  }
}

function recordRun(
  db: DatabaseSync,
  documentId: number,
  status: string,
  tokens: number,
  error?: string,
): void {
  db.prepare(
    "INSERT INTO extraction_run (document_id, stage, engine, model, tokens, status, error, finished_at) VALUES (?, 'ai_enrich', 'deepseek', ?, ?, ?, ?, datetime('now'))",
  ).run(documentId, DEEPSEEK_MODEL, tokens, status, error ?? null);
}
