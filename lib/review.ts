import type { DatabaseSync } from "node:sqlite";

/**
 * 待复核队列：把所有保单里 review_status='needs_review' 的要素一次取出来。
 * 详情页一次只能处理一份保单，逐份点进去改 20 多条太慢，这里按页码顺序排成一条队列。
 */

export type PendingElement = {
  id: number;
  documentId: number;
  product: string;
  insurer: string | null;
  category: string;
  kind: string;
  label: string;
  value: string;
  unit: string;
  condition: string;
  quote: string;
  pageNo: number;
  clauseNo: string | null;
};

const LIMIT = 300;

export function listPendingElements(db: DatabaseSync): PendingElement[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.document_id, e.kind, e.label, e.value, e.unit, e.condition, e.quote,
              e.page_no, e.clause_no,
              d.filename,
              (SELECT p.product_name FROM policy p WHERE p.document_id = e.document_id ORDER BY p.id DESC LIMIT 1) AS product_name,
              (SELECT p.insurer FROM policy p WHERE p.document_id = e.document_id ORDER BY p.id DESC LIMIT 1) AS insurer,
              (SELECT p.category FROM policy p WHERE p.document_id = e.document_id ORDER BY p.id DESC LIMIT 1) AS category
       FROM policy_element e
       JOIN document d ON d.id = e.document_id
       WHERE e.review_status = 'needs_review'
       ORDER BY e.document_id, e.page_no, e.id
       LIMIT ?`,
    )
    .all(LIMIT) as unknown as {
    id: number;
    document_id: number;
    kind: string;
    label: string;
    value: string;
    unit: string;
    condition: string;
    quote: string;
    page_no: number;
    clause_no: string | null;
    filename: string;
    product_name: string | null;
    insurer: string | null;
    category: string | null;
  }[];

  return rows.map((row) => ({
    id: Number(row.id),
    documentId: Number(row.document_id),
    product: row.product_name ?? row.filename,
    insurer: row.insurer,
    category: row.category ?? "unknown",
    kind: row.kind,
    label: row.label,
    value: row.value,
    unit: row.unit,
    condition: row.condition,
    quote: row.quote,
    pageNo: Number(row.page_no),
    clauseNo: row.clause_no,
  }));
}
