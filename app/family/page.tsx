import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/estimate";
import { expiryLabel, expiryOf, groupByInsured, remindersOf } from "@/lib/family";
import { CATEGORY_LABELS, listPolicies } from "@/lib/policy-store";

export const dynamic = "force-dynamic";

const EXPIRY_STYLE: Record<string, string> = {
  expired: "border-rose-200 bg-rose-50 text-rose-700",
  soon: "border-amber-200 bg-amber-50 text-amber-800",
  ok: "border-slate-200 bg-white text-slate-500",
  unknown: "border-slate-200 bg-white text-slate-400",
};

export default async function FamilyPage() {
  const policies = listPolicies(getDb());
  const members = groupByInsured(policies);
  const { due, unknown } = remindersOf(policies);

  const totalPremium = policies.reduce((sum, policy) => sum + (policy.premium ?? 0), 0);
  const totalReview = policies.reduce((sum, policy) => sum + policy.needsReview, 0);
  const withoutPremium = policies.filter((policy) => policy.premium === null).length;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-xs text-slate-500 hover:text-slate-900">
        ← 返回保单管理
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-lg font-semibold tracking-tight">家庭总览</h1>
        <p className="mt-1.5 text-xs leading-6 text-slate-500">
          {members.length} 位被保险人 · {policies.length} 份保单
          {totalPremium > 0 ? ` · 已识别保费合计 ${formatMoney(totalPremium)}` : ""}
          {withoutPremium > 0 ? `（另有 ${withoutPremium} 份未识别保费，不计入合计）` : ""}
          {totalReview > 0 ? ` · ${totalReview} 处待复核` : ""}
        </p>
      </header>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">到期提醒</h2>
          <p className="text-xs text-slate-400">
            60 天内到期或已经过期 · 期限没识别的 {unknown} 份不算在内
          </p>
        </div>

        {due.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">近期没有需要续保的保单。</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {due.map(({ policy, insured, expiry }) => (
              <li
                key={policy.documentId}
                className={`flex flex-wrap items-baseline justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${EXPIRY_STYLE[expiry.status]}`}
              >
                <span className="min-w-0">
                  <Link href={`/documents/${policy.documentId}`} className="font-medium hover:underline">
                    {policy.productName ?? policy.filename}
                  </Link>
                  <span className="mx-1 opacity-50">·</span>
                  {insured}
                  <span className="mx-1 opacity-50">·</span>
                  {policy.effectiveTo ?? "期限未识别"}
                </span>
                <span className="shrink-0 font-medium">{expiryLabel(expiry)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {members.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center text-sm text-slate-500">
          还没有保单，先上传一份。
        </p>
      ) : (
        <div className="space-y-4">
          {members.map((member) => (
            <section key={member.name} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  {member.name}
                  <span className="ml-2 font-normal text-slate-400">{member.policies.length} 份保单</span>
                </h2>
                <p className="flex flex-wrap items-center gap-x-3 text-xs text-slate-400">
                  {member.premium > 0 ? <span>保费 {formatMoney(member.premium)}</span> : null}
                  {member.needsReview > 0 ? <span className="text-amber-700">{member.needsReview} 处待复核</span> : null}
                  <Link
                    href={`/stack?name=${encodeURIComponent(member.name)}`}
                    className="text-sky-700 underline decoration-dotted underline-offset-2"
                  >
                    一起算
                  </Link>
                </p>
              </div>

              <ul className="mt-3 divide-y divide-slate-100">
                {member.policies.map((policy) => {
                  const expiry = expiryOf(policy.effectiveTo);
                  return (
                    <li
                      key={policy.documentId}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-xs"
                    >
                      <span className="min-w-0">
                        <Link href={`/documents/${policy.documentId}`} className="text-slate-800 hover:underline">
                          {policy.productName ?? policy.filename}
                        </Link>
                        <span className="ml-2 text-slate-400">{policy.insurer ?? "保险公司未识别"}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 text-slate-500">
                        <span className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600">
                          {CATEGORY_LABELS[policy.category]}
                        </span>
                        <span>
                          {policy.effectiveFrom ?? "起期未识别"} ~ {policy.effectiveTo ?? "止期未识别"}
                        </span>
                        <span
                          className={
                            expiry.status === "expired"
                              ? "text-rose-600"
                              : expiry.status === "soon"
                                ? "text-amber-700"
                                : "text-slate-400"
                          }
                        >
                          {expiryLabel(expiry)}
                        </span>
                        <span className="tabular-nums text-slate-600">
                          {policy.premium === null ? "保费未识别" : formatMoney(policy.premium)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="mt-6 text-xs leading-6 text-slate-400">
        期限和保费都来自保单原文抽取，识别不出来的显示「未识别」，不会替你猜一个日期。
      </p>
    </main>
  );
}
