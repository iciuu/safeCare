/**
 * 条款检索：SQLite FTS5 + 自建 bigram 索引（docs/PLAN.md §6 的第一步）。
 *
 * 为什么自己切 bigram：FTS5 自带的 unicode61 / simple 分词器把一长串汉字当成
 * 一个 token，「住院」搜不到「住院前后门急诊」。中文按二元组切开、用空格连成
 * 一串再交给 unicode61 索引，既不用装扩展，也不用重新编译 SQLite。
 *
 * 索引按 document 惰性对齐：重解、换切分规则、删保单之后，第一次检索会自动
 * 重建那一份的索引，不需要额外的迁移脚本或「重建索引」按钮。
 */

import type { DatabaseSync } from "node:sqlite";

const MAX_QUERY_TOKENS = 40;
/** 检索给 AI 的条款数；再多提示词就装不下了 */
export const MAX_HITS = 8;
const MAX_RELATED = 5;

export type RelatedClause = {
  clauseId: number;
  documentId: number;
  clauseNo: string;
  heading: string;
  page: number;
  productName: string | null;
  insurer: string | null;
  /** 命中位置附近的一小段原文，只用来给列表看一眼，不参与结论 */
  snippet: string;
  /** 0 = 最相关 */
  rank: number;
};

export type SearchHit = RelatedClause & { text: string };

/**
 * 中文按二元组、英文数字按整段切开。
 * 「住院前的门诊」→ 住院 院前 前的 的门 门诊；「400 万元」→ 400 万元 万元。
 */
export function searchTokens(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9%]+/gu, " ");

  const tokens: string[] = [];
  for (const chunk of normalized.match(/\p{Script=Han}+|[a-z0-9%]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      if (chunk.length === 1) {
        tokens.push(chunk);
        continue;
      }
      for (let i = 0; i < chunk.length - 1; i += 1) tokens.push(chunk.slice(i, i + 2));
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

function unique(tokens: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/** 建索引时保留重复（BM25 需要词频），查询时去重。 */
function indexText(text: string): string {
  return searchTokens(text).join(" ");
}

export function ensureClauseIndex(db: DatabaseSync): void {
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS clause_fts USING fts5(bigrams, clause_id UNINDEXED, document_id UNINDEXED, tokenize = 'unicode61')",
  );

  // 删掉的保单，条款已经级联清了，索引里的行也要跟着走
  db.exec("DELETE FROM clause_fts WHERE document_id NOT IN (SELECT id FROM document)");

  const counts = db
    .prepare(
      `SELECT d.id AS id,
              (SELECT COUNT(*) FROM clause WHERE document_id = d.id) AS clauses,
              (SELECT COUNT(*) FROM clause_fts WHERE document_id = d.id) AS indexed
         FROM document d`,
    )
    .all() as unknown as { id: number; clauses: number; indexed: number }[];

  const stale = counts.filter((row) => row.clauses !== row.indexed);
  if (stale.length === 0) return;

  const drop = db.prepare("DELETE FROM clause_fts WHERE document_id = ?");
  const insert = db.prepare("INSERT INTO clause_fts (bigrams, clause_id, document_id) VALUES (?, ?, ?)");
  const select = db.prepare("SELECT id, text, heading_path FROM clause WHERE document_id = ?");

  for (const row of stale) {
    drop.run(row.id);
    if (row.clauses === 0) continue;
    const clauses = select.all(row.id) as unknown as {
      id: number;
      text: string;
      heading_path: string | null;
    }[];
    for (const clause of clauses) {
      insert.run(indexText(`${clause.heading_path ?? ""}\n${clause.text}`), clause.id, row.id);
    }
  }
}

/** 命中位置附近的一小段原文；找不到就取开头。 */
export function bestSnippet(text: string, tokens: string[], width = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let at = -1;
  for (const token of tokens) {
    const found = flat.indexOf(token);
    if (found === -1) continue;
    if (at === -1 || found < at) at = found;
  }
  const start = at <= 24 ? 0 : at - 24;
  const slice = flat.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${slice}${start + width < flat.length ? "…" : ""}`;
}

function matchRows(
  db: DatabaseSync,
  tokens: string[],
  mode: "and" | "or",
  documentId: number | null,
  limit: number,
): { id: number; score: number }[] {
  const query = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(mode === "and" ? " AND " : " OR ");
  const sql = documentId
    ? "SELECT clause_id AS id, bm25(clause_fts) AS score FROM clause_fts WHERE clause_fts MATCH ? AND document_id = ? ORDER BY score LIMIT ?"
    : "SELECT clause_id AS id, bm25(clause_fts) AS score FROM clause_fts WHERE clause_fts MATCH ? ORDER BY score LIMIT ?";

  try {
    const rows = documentId
      ? db.prepare(sql).all(query, documentId, limit)
      : db.prepare(sql).all(query, limit);
    return rows as unknown as { id: number; score: number }[];
  } catch {
    // 查询里出现无法解析的 token 时不要整页挂掉，当作没命中
    return [];
  }
}

type ClauseRow = {
  id: number;
  document_id: number;
  clause_no: string | null;
  heading_path: string | null;
  text: string;
  page_from: number;
};

/**
 * 按问题检索条款。先 AND（所有二元组都要出现），命中太少再退 OR 并按命中词数过滤，
 * 避免「能报吗」这类虚词把整本条款都捞回来。
 */
export function searchClauses(
  db: DatabaseSync,
  question: string,
  options: { documentId?: number | null; limit?: number } = {},
): SearchHit[] {
  const tokens = unique(searchTokens(question), MAX_QUERY_TOKENS);
  if (tokens.length === 0) return [];

  ensureClauseIndex(db);

  const limit = Math.max(1, Math.min(options.limit ?? MAX_HITS, 20));
  const documentId = options.documentId ?? null;
  const wanted = Math.min(3, limit);

  let rows = matchRows(db, tokens, "and", documentId, limit * 4);
  if (rows.length < wanted) {
    const fallback = matchRows(db, tokens, "or", documentId, limit * 4);
    if (fallback.length > rows.length) rows = fallback;
  }

  const seen = new Set<number>();
  const candidates: ClauseRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const clause = db
      .prepare("SELECT id, document_id, clause_no, heading_path, text, page_from FROM clause WHERE id = ?")
      .get(row.id) as unknown as ClauseRow | undefined;
    if (clause) candidates.push(clause);
  }

  const policies = new Map<number, { product_name: string | null; insurer: string | null }>();
  const policyOf = (id: number) => {
    if (!policies.has(id)) {
      const row = db
        .prepare("SELECT product_name, insurer FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1")
        .get(id) as unknown as { product_name: string | null; insurer: string | null } | undefined;
      policies.set(id, { product_name: row?.product_name ?? null, insurer: row?.insurer ?? null });
    }
    return policies.get(id) as { product_name: string | null; insurer: string | null };
  };

  const minimumOverlap = Math.min(2, tokens.length);
  const hits: SearchHit[] = [];

  for (const clause of candidates) {
    const haystack = `${clause.heading_path ?? ""}\n${clause.text}`.toLowerCase();
    const overlap = tokens.filter((token) => haystack.includes(token)).length;
    if (overlap < minimumOverlap) continue;

    const policy = policyOf(clause.document_id);
    hits.push({
      clauseId: clause.id,
      documentId: clause.document_id,
      clauseNo: clause.clause_no ?? "未编号",
      heading: (clause.heading_path ?? "").split(" > ").pop() ?? "",
      page: clause.page_from,
      productName: policy.product_name,
      insurer: policy.insurer,
      snippet: bestSnippet(clause.text, tokens),
      rank: hits.length,
      text: clause.text,
    });
    if (hits.length >= limit) break;
  }

  return hits;
}

/** 检索结果里去掉正文，给页面/客户端用。 */
export function toRelated(hits: SearchHit[]): RelatedClause[] {
  return hits.slice(0, MAX_RELATED).map((hit) => ({
    clauseId: hit.clauseId,
    documentId: hit.documentId,
    clauseNo: hit.clauseNo,
    heading: hit.heading,
    page: hit.page,
    productName: hit.productName,
    insurer: hit.insurer,
    snippet: hit.snippet,
    rank: hit.rank,
  }));
}
