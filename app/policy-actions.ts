"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import { getDb } from "@/lib/db";
import { startExtraction } from "@/lib/extract-job";
import { isIsoDate } from "@/lib/family";
import {
  deletePolicyDocument,
  isCategory,
  resolveElement,
  updatePolicyMeta,
  type ElementReviewAction,
  type PolicyPatch,
} from "@/lib/policy-store";

function text(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 只补期限：抽不到到期日的保单，在家庭总览里直接填，不必展开首页的大表单。
 * 空值表示改回「未识别」；日期必须是 YYYY-MM-DD，写错就退回原页面带上错误提示。
 */
export async function setExpiryAction(form: FormData): Promise<void> {
  const policyId = Number(form.get("policyId"));
  if (!Number.isInteger(policyId) || policyId <= 0) redirect("/family?expiry_error=bad_policy");

  const rawFrom = text(form, "effectiveFrom") ?? "";
  const rawTo = text(form, "effectiveTo") ?? "";
  for (const value of [rawFrom, rawTo]) {
    if (value !== "" && !isIsoDate(value)) redirect("/family?expiry_error=bad_date");
  }

  const db = getDb();
  const row = db.prepare("SELECT data FROM policy WHERE id = ?").get(policyId) as { data: string } | undefined;
  if (!row) redirect("/family?expiry_error=not_found");

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    data = {};
  }
  data.effective_from = rawFrom === "" ? null : rawFrom;
  data.effective_to = rawTo === "" ? null : rawTo;

  db.prepare("UPDATE policy SET data = ? WHERE id = ?").run(JSON.stringify(data), policyId);

  revalidatePath("/");
  revalidatePath("/family");
  revalidatePath(`/documents/${form.get("documentId") ?? ""}`);
  redirect(`/family?expiry_saved=${policyId}`);
}

export async function savePolicyAction(form: FormData): Promise<void> {
  const policyId = Number(form.get("policyId"));
  if (!Number.isInteger(policyId) || policyId <= 0) redirect("/?error=bad_policy");

  const category = text(form, "category") ?? "unknown";
  if (!isCategory(category)) redirect("/?error=bad_category");

  for (const name of ["effectiveFrom", "effectiveTo"]) {
    const value = text(form, name);
    if (value !== null && !isIsoDate(value)) redirect("/?error=bad_date");
  }

  const patch: PolicyPatch = {
    category,
    insurer: text(form, "insurer"),
    productName: text(form, "productName"),
    policyNo: text(form, "policyNo"),
    holderName: text(form, "holderName"),
    insuredName: text(form, "insuredName"),
    effectiveFrom: text(form, "effectiveFrom"),
    effectiveTo: text(form, "effectiveTo"),
  };

  const saved = updatePolicyMeta(getDb(), policyId, patch);
  revalidatePath("/");
  redirect(saved ? `/?saved=${policyId}` : "/?error=not_found");
}

export async function deletePolicyAction(form: FormData): Promise<void> {
  const documentId = Number(form.get("documentId"));
  if (!Number.isInteger(documentId) || documentId <= 0) redirect("/?error=bad_document");

  const deleted = deletePolicyDocument(getDb(), documentId);
  revalidatePath("/");
  redirect(deleted ? "/?deleted=1" : "/?error=not_found");
}

/** 待复核要素的人工出口：确认 / 忽略 / 修正后确认。 */
export async function resolveElementAction(form: FormData): Promise<void> {
  const documentId = Number(form.get("documentId"));
  const elementId = Number(form.get("elementId"));
  const actionRaw = String(form.get("action") ?? "");
  if (!Number.isInteger(documentId) || documentId <= 0 || !Number.isInteger(elementId)) {
    redirect("/?error=bad_document");
  }
  if (actionRaw !== "confirm" && actionRaw !== "ignore" && actionRaw !== "save") {
    redirect(`/documents/${documentId}?error=bad_action`);
  }
  const action: ElementReviewAction = actionRaw;

  // 修正允许把值改成空（原条款本来就是空），所以这里不用 text() 的空串变 null
  const raw = (name: string): string => String(form.get(name) ?? "").trim();

  const ok = resolveElement(getDb(), {
    documentId,
    elementId,
    action,
    label: raw("label"),
    value: raw("value"),
    unit: raw("unit"),
    condition: raw("condition"),
  });

  // 集中复核页处理完还要回到队列里下一条，所以允许指定站内回跳地址
  const back = String(form.get("returnTo") ?? "");
  const safeBack = back.startsWith("/") && !back.startsWith("//") ? back : null;

  revalidatePath("/");
  revalidatePath("/review");
  revalidatePath(`/documents/${documentId}`);
  if (!ok) redirect(`/documents/${documentId}?error=not_found#review`);
  redirect(safeBack ?? `/documents/${documentId}?reviewed=1#review`);
}

/** AI 提要点出问题时不阻塞管理页，只把状态写回 URL。 */
export async function rerunAiAction(form: FormData): Promise<void> {
  const documentId = Number(form.get("documentId"));
  if (!Number.isInteger(documentId) || documentId <= 0) redirect("/?error=bad_document");
  if (!deepseekConfigured()) redirect("/?error=no_api_key");

  // 抽取放到后台跑，页面先回去看进度；已经跑着的就不重复起
  const started = startExtraction(documentId);

  revalidatePath("/");
  revalidatePath(`/documents/${documentId}`);
  redirect(`/documents/${documentId}${started ? "?ai=started" : "?ai=running"}`);
}
