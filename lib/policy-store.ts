/** 保单管理的数据层：一份保单 = 一条 document + 一条 policy + 其下的责任/免责/条款要点。 */

import { unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { uploadPathFor } from "./db";
import type { PolicyCategory } from "./policy-meta";

export const CATEGORY_LABELS: Record<PolicyCategory, string> = {
  medical: "医疗险",
  critical_illness: "重疾险",
  accident: "意外险",
  life: "寿险",
  unknown: "未识别险种",
};

export const CATEGORY_ORDER: PolicyCategory[] = ["medical", "critical_illness", "accident", "life", "unknown"];

export function isCategory(value: string): value is PolicyCategory {
  return (CATEGORY_ORDER as string[]).includes(value);
}

type StoredPolicy = {
  insurer?: string | null;
  product_name?: string | null;
  policy_no?: string | null;
  holder_name?: string | null;
  insured_name?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  premium?: number | null;
  waiting_days?: number | null;
  benefit_table?: { annual_limit?: number | null; waiting_days?: number | null };
};

export type ManagedPolicy = {
  documentId: number;
  policyId: number | null;
  filename: string;
  category: PolicyCategory;
  insurer: string | null;
  productName: string | null;
  policyNo: string | null;
  holderName: string | null;
  insuredName: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  premium: number | null;
  waitingDays: number | null;
  annualLimit: number | null;
  pageCount: number;
  clauseCount: number;
  coverageCount: number;
  exclusionCount: number;
  aiFacts: number;
  needsReview: number;
  aiStatus: string | null;
  createdAt: string;
  hasTextLayer: boolean;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function listPolicies(db: DatabaseSync): ManagedPolicy[] {
  const documents = db
    .prepare(
      "SELECT id, filename, page_count, clause_count, has_text_layer, created_at FROM document ORDER BY id DESC",
    )
    .all() as unknown as {
    id: number;
    filename: string;
    page_count: number;
    clause_count: number;
    has_text_layer: number;
    created_at: string;
  }[];

  const policies = db
    .prepare(
      "SELECT id, document_id, category, insurer, product_name, policy_no, data FROM policy ORDER BY id DESC",
    )
    .all() as unknown as {
    id: number;
    document_id: number;
    category: string;
    insurer: string | null;
    product_name: string | null;
    policy_no: string | null;
    data: string;
  }[];

  const policyCounts = db
    .prepare(
      `SELECT p.id AS policy_id,
         (SELECT COUNT(*) FROM coverage c WHERE c.policy_id = p.id) AS coverage_count,
         (SELECT COUNT(*) FROM policy_element e WHERE e.document_id = p.document_id AND e.kind = 'exclusion' AND e.review_status <> 'ignored') AS exclusion_count,
         (SELECT COUNT(*) FROM coverage c WHERE c.policy_id = p.id AND c.review_status = 'needs_review') AS needs_review
       FROM policy p`,
    )
    .all() as unknown as {
    policy_id: number;
    coverage_count: number;
    exclusion_count: number;
    needs_review: number;
  }[];

  const documentCounts = db
    .prepare(
      `SELECT d.id AS document_id,
         (SELECT COUNT(*) FROM policy_element e WHERE e.document_id = d.id AND e.source = 'ai' AND e.review_status <> 'ignored') AS ai_facts,
         (SELECT COUNT(*) FROM policy_element e WHERE e.document_id = d.id AND e.review_status = 'needs_review') AS element_review,
         (SELECT COUNT(*) FROM clause_ai a JOIN clause cl ON cl.id = a.clause_id
            WHERE cl.document_id = d.id AND a.review_status = 'needs_review') AS clause_review,
         (SELECT status FROM extraction_run r WHERE r.document_id = d.id AND r.stage IN ('ai_extract', 'ai_enrich')
            ORDER BY r.id DESC LIMIT 1) AS ai_status
       FROM document d`,
    )
    .all() as unknown as {
    document_id: number;
    ai_facts: number;
    element_review: number;
    clause_review: number;
    ai_status: string | null;
  }[];

  const policyByDocument = new Map(policies.map((row) => [row.document_id, row]));
  const policyCountById = new Map(policyCounts.map((row) => [row.policy_id, row]));
  const documentCountById = new Map(documentCounts.map((row) => [row.document_id, row]));

  return documents.map((document) => {
    const policy = policyByDocument.get(document.id);
    const data = policy ? parseJson<StoredPolicy>(policy.data, {}) : {};
    const counts = policy ? policyCountById.get(policy.id) : undefined;
    const docCounts = documentCountById.get(document.id);
    const category = policy && isCategory(policy.category) ? policy.category : "unknown";

    return {
      documentId: document.id,
      policyId: policy?.id ?? null,
      filename: document.filename,
      category,
      insurer: policy?.insurer ?? data.insurer ?? null,
      productName: policy?.product_name ?? data.product_name ?? null,
      policyNo: policy?.policy_no ?? data.policy_no ?? null,
      holderName: data.holder_name ?? null,
      insuredName: data.insured_name ?? null,
      effectiveFrom: data.effective_from ?? null,
      effectiveTo: data.effective_to ?? null,
      premium: typeof data.premium === "number" ? data.premium : null,
      // 0 天等于没有等待期，界面上显示「未识别」比显示 0 天准确
      waitingDays: (data.benefit_table?.waiting_days ?? data.waiting_days ?? null) || null,
      annualLimit: data.benefit_table?.annual_limit ?? null,
      pageCount: document.page_count,
      clauseCount: document.clause_count,
      coverageCount: counts?.coverage_count ?? 0,
      exclusionCount: counts?.exclusion_count ?? 0,
      aiFacts: docCounts?.ai_facts ?? 0,
      // 待复核口径与详情页一致：有要素就只看要素冲突；老数据回退到责任行 + 条款要点
      needsReview:
        (docCounts?.ai_facts ?? 0) > 0
          ? (docCounts?.element_review ?? 0)
          : (counts?.needs_review ?? 0) + (docCounts?.clause_review ?? 0),
      aiStatus: docCounts?.ai_status ?? null,
      createdAt: document.created_at,
      hasTextLayer: document.has_text_layer === 1,
    };
  });
}

export type PolicyPatch = {
  category: PolicyCategory;
  insurer: string | null;
  productName: string | null;
  policyNo: string | null;
  holderName: string | null;
  insuredName: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

/** 手工修正的字段覆盖抽取结果：列同步更新，其余保留在 data JSON 里。 */
export function updatePolicyMeta(db: DatabaseSync, policyId: number, patch: PolicyPatch): boolean {
  const row = db.prepare("SELECT data FROM policy WHERE id = ?").get(policyId) as
    | { data: string }
    | undefined;
  if (!row) return false;

  const data = {
    ...parseJson<StoredPolicy>(row.data, {}),
    holder_name: patch.holderName,
    insured_name: patch.insuredName,
    effective_from: patch.effectiveFrom,
    effective_to: patch.effectiveTo,
  };

  db.prepare(
    "UPDATE policy SET category = ?, insurer = ?, product_name = ?, policy_no = ?, data = ? WHERE id = ?",
  ).run(
    patch.category,
    patch.insurer,
    patch.productName,
    patch.policyNo,
    JSON.stringify(data),
    policyId,
  );

  return true;
}

export type ElementReviewAction = "confirm" | "ignore" | "save";

/**
 * 待复核的出口：确认（原样认可）、忽略（不计入速查卡和计数）、修正（改完就算确认）。
 * 改动前后的值另存 element_review，重跑 AI 覆盖要素时也能查到当时人工认过什么。
 */
export function resolveElement(
  db: DatabaseSync,
  input: {
    documentId: number;
    elementId: number;
    action: ElementReviewAction;
    label?: string | null;
    value?: string | null;
    unit?: string | null;
    condition?: string | null;
  },
): boolean {
  const row = db
    .prepare(
      "SELECT id, document_id, label, value, unit, condition, review_status FROM policy_element WHERE id = ?",
    )
    .get(input.elementId) as
    | {
        id: number;
        document_id: number;
        label: string;
        value: string;
        unit: string;
        condition: string;
        review_status: string;
      }
    | undefined;
  if (!row || row.document_id !== input.documentId) return false;

  const next = {
    label: input.action === "save" ? (input.label ?? row.label) : row.label,
    value: input.action === "save" ? (input.value ?? row.value) : row.value,
    unit: input.action === "save" ? (input.unit ?? row.unit) : row.unit,
    condition: input.action === "save" ? (input.condition ?? row.condition) : row.condition,
    review_status: input.action === "ignore" ? "ignored" : "ok",
  };

  db.prepare(
    "UPDATE policy_element SET label = ?, value = ?, unit = ?, condition = ?, review_status = ? WHERE id = ?",
  ).run(next.label, next.value, next.unit, next.condition, next.review_status, row.id);

  db.prepare(
    "INSERT INTO element_review (element_id, action, before_json, after_json) VALUES (?, ?, ?, ?)",
  ).run(
    row.id,
    input.action,
    JSON.stringify({
      label: row.label,
      value: row.value,
      unit: row.unit,
      condition: row.condition,
      review_status: row.review_status,
    }),
    JSON.stringify(next),
  );

  return true;
}

/** 删掉一份保单：库里按外键级联清掉条款/责任/要点，磁盘上的 PDF 也一起删。 */
export function deletePolicyDocument(db: DatabaseSync, documentId: number): boolean {
  const row = db.prepare("SELECT id FROM document WHERE id = ?").get(documentId) as
    | { id: number }
    | undefined;
  if (!row) return false;

  db.prepare("DELETE FROM document WHERE id = ?").run(documentId);

  try {
    unlinkSync(uploadPathFor(documentId));
  } catch {
    // 文件可能已经被手动删掉；库里清干净就算成功
  }

  return true;
}
