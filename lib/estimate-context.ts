/** 估算页与 AI 分析接口共用的数据装载：责任清单、比例、条款页码与原文。 */

import type { DatabaseSync } from "node:sqlite";
import {
  buildPlan,
  type ClauseRef,
  type CoverageRowInput,
  type EstimateBenefit,
  type EstimateRefs,
} from "./estimate";
import type { ClaimClause } from "./ai/claim";

export const REF_CLAUSES = ["附表1", "2.3", "2.4", "2.5", "2.6", "3.1"] as const;

export type EstimateContext = {
  document: { id: number; filename: string };
  /** 保单上的正式名称，界面上优先显示它而不是文件名 */
  productName: string | null;
  insurer: string | null;
  policyId: number | null;
  benefits: EstimateBenefit[];
  notes: string[];
  refs: EstimateRefs;
  annualLimit: number | null;
  waitingDays: number | null;
  exclusions: { id: number; text: string; page: number | null }[];
  clauses: ClaimClause[];
  /** 附表里是否真的出现了这些条款，用来给 AI 提示上下文是否完整 */
  clauseCount: number;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadEstimateContext(db: DatabaseSync, documentId: number): EstimateContext | null {
  const document = db
    .prepare("SELECT id, filename FROM document WHERE id = ?")
    .get(documentId) as { id: number; filename: string } | undefined;
  if (!document) return null;

  const policyRow = db
    .prepare(
      "SELECT id, insurer, product_name, data FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(documentId) as
    | { id: number; insurer: string | null; product_name: string | null; data: string }
    | undefined;

  const policy = policyRow
    ? parseJson<{
        waiting_days?: number | null;
        benefit_table?: { annual_limit?: number | null; waiting_days?: number | null };
      }>(policyRow.data, {})
    : {};

  const coverageRows: CoverageRowInput[] = policyRow
    ? (
        db
          .prepare("SELECT name, data FROM coverage WHERE policy_id = ? ORDER BY id")
          .all(policyRow.id) as unknown as { name: string | null; data: string }[]
      ).map((row) => {
        const parsed = parseJson<{
          hospital_scope?: string | null;
          tiers?: { when: string; ratio: number }[];
          annual_limit?: number | null;
        }>(row.data, {});
        return {
          name: row.name,
          hospital_scope: parsed.hospital_scope ?? null,
          tiers: parsed.tiers ?? [],
          annual_limit: parsed.annual_limit ?? null,
        };
      })
    : [];

  const clauseRows = (
    db
      .prepare(
        `SELECT clause_no, page_from, text FROM clause
         WHERE document_id = ? AND clause_no IN (${REF_CLAUSES.map(() => "?").join(",")})
         ORDER BY seq`,
      )
      .all(documentId, ...REF_CLAUSES) as unknown as { clause_no: string; page_from: number; text: string }[]
  ).map((row) => ({ clauseNo: row.clause_no, page: Number(row.page_from), text: row.text }));

  const tableText = clauseRows.find((row) => row.clauseNo === "附表1")?.text ?? null;
  const plan = buildPlan({ coverage: coverageRows, benefitTableText: tableText });

  const refOf = (clauseNo: string): ClauseRef | null => {
    const row = clauseRows.find((item) => item.clauseNo === clauseNo);
    return row ? { clauseNo: row.clauseNo, page: row.page } : null;
  };

  const refs: EstimateRefs = {
    benefitTable: refOf("附表1"),
    liability: refOf("2.5"),
    limit: refOf("2.3"),
    compensation: refOf("2.6"),
    waiting: refOf("2.4"),
    exclusion: refOf("3.1"),
  };

  const exclusions = policyRow
    ? (
        db
          .prepare(
            "SELECT e.id, e.text, c.page_from FROM exclusion e LEFT JOIN clause c ON c.id = e.citation_clause_id WHERE e.policy_id = ? ORDER BY e.id",
          )
          .all(policyRow.id) as unknown as { id: number; text: string | null; page_from: number | null }[]
      ).map((row) => ({
        id: row.id,
        text: row.text ?? "免责情形",
        page: row.page_from === null ? null : Number(row.page_from),
      }))
    : [];

  return {
    document,
    productName: policyRow?.product_name ?? null,
    insurer: policyRow?.insurer ?? null,
    policyId: policyRow?.id ?? null,
    benefits: plan.benefits,
    notes: plan.notes,
    refs,
    annualLimit: policy.benefit_table?.annual_limit ?? null,
    waitingDays: policy.benefit_table?.waiting_days ?? policy.waiting_days ?? null,
    exclusions,
    clauses: clauseRows,
    clauseCount: clauseRows.length,
  };
}
