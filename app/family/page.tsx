import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/estimate";
import {
  activeOnly,
  archiveOf,
  expiryLabel,
  expiryOf,
  groupByInsured,
  insuredNamesOf,
  isSharedPolicy,
  remindersOf,
  termKindLabel,
  termKindOf,
} from "@/lib/family";
import { CATEGORY_LABELS, listPolicies } from "@/lib/policy-store";
import { setExpiryAction } from "@/app/policy-actions";

export const dynamic = "force-dynamic";

const EXPIRY_STYLE: Record<string, string> = {
  expired: "border-rose-200 bg-rose-50 text-rose-700",
  soon: "border-amber-200 bg-amber-50 text-amber-800",
  ok: "border-slate-200 bg-white text-slate-500",
  unknown: "border-slate-200 bg-white text-slate-400",
};

const EXPIRY_ERROR_TEXT: Record<string, string> = {
  bad_date: "日期要写成 2026-05-31 这样的格式，且必须是真实存在的日期。",
  bad_policy: "参数不对，没有保存。",
  not_found: "这份保单已经不在库里了。",
};

export default async function FamilyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const all = listPolicies(getDb());
  // 过期的单独按年份归档：提醒、保费合计、分组都不再算它们
  const policies = activeOnly(all);
  const archive = archiveOf(all);
  const archived = archive.reduce((sum, group) => sum + group.policies.length, 0);
  const members = groupByInsured(policies);
  const { due, unknown } = remindersOf(policies);
  // 抽不到止期的保单：提醒、归档都靠日期，这里直接让人补一个
  const missingExpiry = policies.filter((policy) => !policy.effectiveTo);

  const flash =
    typeof query.expiry_error === "string"
      ? { kind: "error" as const, text: EXPIRY_ERROR_TEXT[query.expiry_error] ?? "没有保存。" }
      : typeof query.expiry_saved === "string"
        ? { kind: "ok" as const, text: "到期日已保存，提醒和归档已按新日期重算。" }
        : null;

  const dateField =
    "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 outline-none focus:border-sky-500";

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
          {members.length} 位被保险人 · 在保 {policies.length} 份
          {totalPremium > 0 ? ` · 已识别保费合计 ${formatMoney(totalPremium)}` : ""}
          {withoutPremium > 0 ? `（另有 ${withoutPremium} 份未识别保费，不计入合计）` : ""}
          {totalReview > 0 ? ` · ${totalReview} 处待复核` : ""}
          {archived > 0 ? ` · 已过期 ${archived} 份（见文末归档，不参与计算）` : ""}
        </p>
      </header>

      {flash ? (
        <p
          className={`mb-4 rounded-lg px-3 py-2 text-xs ${
            flash.kind === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {flash.text}
        </p>
      ) : null}

      {missingExpiry.length > 0 ? (
        <section className="mb-6 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">待补到期日 · {missingExpiry.length} 份</h2>
            <p className="text-xs text-slate-500">合同原文没写清止期，填上后才会进到期提醒和归档</p>
          </div>
          <div className="mt-2 space-y-2">
            {missingExpiry.map((policy) => (
              <form
                key={policy.documentId}
                action={setExpiryAction}
                className="flex flex-wrap items-end gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2"
              >
                <input type="hidden" name="policyId" value={policy.policyId ?? ""} />
                <input type="hidden" name="documentId" value={policy.documentId} />
                <div className="min-w-0 flex-1 text-xs text-slate-700">
                  <Link href={`/documents/${policy.documentId}`} className="hover:underline">
                    {policy.productName ?? policy.filename}
                  </Link>
                  <p className="text-[11px] text-slate-400">
                    {policy.insuredName ?? "未识别被保险人"} · 起期 {policy.effectiveFrom ?? "未识别"}
                  </p>
                </div>
                <label className="w-32 text-[11px] text-slate-500">
                  起期（可选）
                  <input
                    name="effectiveFrom"
                    defaultValue={policy.effectiveFrom ?? ""}
                    placeholder="2025-06-01"
                    inputMode="numeric"
                    className={dateField}
                  />
                </label>
                <label className="w-32 text-[11px] text-slate-500">
                  到期日
                  <input name="effectiveTo" placeholder="2026-05-31" inputMode="numeric" className={dateField} />
                </label>
                <button
                  type="submit"
                  disabled={policy.policyId === null}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  保存
                </button>
              </form>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">到期提醒</h2>
          <p className="text-xs text-slate-400">
            60 天内到期 · 期限没识别的 {unknown} 份不算在内 · 已过期的{archived > 0 ? `在文末归档` : "不提醒"}
          </p>
        </div>

        {due.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">近期没有需要续保或期满的保单。</p>
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
                <span className="shrink-0 font-medium">
                  {expiryLabel(expiry)}
                  <span className="ml-1 font-normal opacity-70">
                    {termKindLabel(termKindOf(policy.effectiveFrom, policy.effectiveTo))}
                  </span>
                </span>
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
                  {member.shared > 0 ? <span>另有 {member.shared} 份共同被保（保费已计入对方）</span> : null}
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
                        {isSharedPolicy(policy) ? (
                          <span
                            className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700"
                            title={`这张保单同时以 ${insuredNamesOf(policy).join("、")} 为被保险人`}
                          >
                            共同被保 · {insuredNamesOf(policy).join("、")}
                          </span>
                        ) : null}
                        <span className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500">
                          {termKindLabel(termKindOf(policy.effectiveFrom, policy.effectiveTo))}
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

      {archive.length > 0 ? (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">已过期 · 按到期年份归档</h2>
            <p className="text-xs text-slate-400">{archived} 份 · 不进到期提醒，也不参与叠加计算</p>
          </div>

          <div className="mt-2 space-y-2">
            {archive.map((group) => (
              <details key={group.year} className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-2 text-xs text-slate-700">
                  {group.year} 年到期
                  <span className="ml-2 text-slate-400">{group.policies.length} 份</span>
                </summary>
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {group.policies.map((policy) => (
                    <li
                      key={policy.documentId}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs"
                    >
                      <span className="min-w-0">
                        <Link href={`/documents/${policy.documentId}`} className="text-slate-700 hover:underline">
                          {policy.productName ?? policy.filename}
                        </Link>
                        <span className="mx-1 text-slate-300">·</span>
                        {policy.insuredName ?? "未识别被保险人"}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 text-slate-500">
                        <span>{termKindLabel(termKindOf(policy.effectiveFrom, policy.effectiveTo))}</span>
                        <span>{policy.effectiveTo ?? "止期未识别"}</span>
                        <span>{expiryLabel(expiryOf(policy.effectiveTo))}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      <p className="mt-6 text-xs leading-6 text-slate-400">
        期限和保费都来自保单原文抽取，识别不出来的显示「未识别」，不会替你猜一个日期。过了止期的保单按到期年份归档，不再计入到期提醒、保费合计和叠加计算。
      </p>
    </main>
  );
}
