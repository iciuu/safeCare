"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { extractPolicyElements } from "@/lib/ai/extract";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import { getDb } from "@/lib/db";
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

export async function savePolicyAction(form: FormData): Promise<void> {
  const policyId = Number(form.get("policyId"));
  if (!Number.isInteger(policyId) || policyId <= 0) redirect("/?error=bad_policy");

  const category = text(form, "category") ?? "unknown";
  if (!isCategory(category)) redirect("/?error=bad_category");

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

  revalidatePath("/");
  revalidatePath(`/documents/${documentId}`);
  redirect(`/documents/${documentId}${ok ? "?reviewed=1" : "?error=not_found"}#review`);
}

/** AI 提要点出问题时不阻塞管理页，只把状态写回 URL。 */
export async function rerunAiAction(form: FormData): Promise<void> {
  const documentId = Number(form.get("documentId"));
  if (!Number.isInteger(documentId) || documentId <= 0) redirect("/?error=bad_document");
  if (!deepseekConfigured()) redirect("/?error=no_api_key");

  let result = "done";
  try {
    const summary = await extractPolicyElements(documentId);
    if (summary.status === "failed" || summary.status === "skipped") result = "failed";
  } catch {
    result = "failed";
  }

  revalidatePath("/");
  revalidatePath(`/documents/${documentId}`);
  redirect(`/?ai=${result}`);
}
