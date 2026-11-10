import { NextResponse } from "next/server";
import { analyzeClaim, ClaimAnalysisError } from "@/lib/ai/claim";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import type { ClaimRequest } from "@/lib/claim-request";
import { getDb } from "@/lib/db";
import { computeEstimate, toAmount, type EstimateInput } from "@/lib/estimate";
import { loadEstimateContext } from "@/lib/estimate-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const context = loadEstimateContext(getDb(), documentId);
  if (!context) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Partial<ClaimRequest> | null;
  if (!body) return NextResponse.json({ error: "bad_body" }, { status: 400 });

  const benefit = context.benefits.find((item) => item.key === body.benefit) ?? context.benefits[0];
  if (!benefit) return NextResponse.json({ error: "no_benefit" }, { status: 400 });

  const num = (value: unknown): number => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
    return toAmount(typeof value === "string" ? value : null);
  };

  const exclusionIndex =
    typeof body.exclusionIndex === "number" && Number.isInteger(body.exclusionIndex)
      ? body.exclusionIndex
      : null;

  const input: EstimateInput = {
    benefitKey: benefit.key,
    scope: typeof body.scope === "string" && body.scope ? body.scope : benefit.scopes[0],
    totalCost: num(body.cost),
    socialPaid: num(body.social),
    otherPaid: num(body.other),
    usedSocial: body.usedSocial !== false,
    catalogCost: body.catalog === null || body.catalog === undefined ? null : num(body.catalog),
    inWaiting: body.waiting === true,
    exclusion:
      exclusionIndex === null ? null : (context.exclusions[exclusionIndex]?.text ?? null),
    paidThisYear: num(body.paid),
    annualLimit: context.annualLimit,
    subLimits: Array.isArray(body.subLimits)
      ? body.subLimits
          .filter((item) => item && typeof item.label === "string")
          .map((item) => ({ label: item.label, limit: num(item.limit), amount: num(item.amount) }))
      : [],
    flatRatio: typeof body.flatRatio === "number" && Number.isFinite(body.flatRatio) ? body.flatRatio : null,
  };

  if (!deepseekConfigured()) {
    return NextResponse.json({ error: "missing_api_key" }, { status: 503 });
  }

  const deterministic = computeEstimate(input, benefit, context.refs);

  try {
    const analysis = await analyzeClaim(input, {
      benefitName: benefit.name,
      scopes: benefit.scopes,
      clauses: context.clauses.map((clause) => ({
        clauseNo: clause.clauseNo,
        page: clause.page,
        text: clause.text,
      })),
    });

    return NextResponse.json({
      analysis,
      deterministic: { payable: deterministic.payable, base: deterministic.base },
    });
  } catch (cause) {
    if (cause instanceof ClaimAnalysisError) {
      const status =
        cause.code === "missing_api_key" ? 503 : cause.code === "redaction_leak" ? 422 : 502;
      return NextResponse.json({ error: cause.code }, { status });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
