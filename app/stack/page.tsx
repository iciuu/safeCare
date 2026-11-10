import Link from "next/link";
import { getDb } from "@/lib/db";
import { loadEstimateContext } from "@/lib/estimate-context";
import { computeEstimate, formatMoney, SCOPE_OPTIONS, toAmount } from "@/lib/estimate";
import { classifyBenefit, combineStack, fixedHighlights, pickIndemnityBenefit, type StackEntry } from "@/lib/stacking";

export const dynamic = "force-dynamic";

const fieldClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-sky-500";

type PolicyRow = {
  documentId: number;
  productName: string | null;
  insurer: string | null;
  filename: string;
  data: string;
};

function insuredOf(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { insured_name?: string | null };
    return parsed.insured_name?.trim() || null;
  } catch {
    return null;
  }
}

export default async function StackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  const query = await searchParams;
  const field = (name: string): string => {
    const value = query[name];
    return typeof value === "string" ? value : "";
  };

  const policies = db
    .prepare(
      "SELECT p.document_id AS documentId, p.product_name AS productName, p.insurer AS insurer, d.filename AS filename, p.data AS data FROM policy p JOIN document d ON d.id = p.document_id ORDER BY p.id",
    )
    .all() as unknown as PolicyRow[];

  const byInsured = new Map<string, PolicyRow[]>();
  for (const policy of policies) {
    const name = insuredOf(policy.data);
    if (!name) continue;
    byInsured.set(name, [...(byInsured.get(name) ?? []), policy]);
  }

  const names = [...byInsured.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const selected = names.includes(field("name")) ? field("name") : (names[0] ?? "");
  const group = byInsured.get(selected) ?? [];

  const cost = toAmount(field("cost"));
  const social = toAmount(field("social"));
  const other = toAmount(field("other"));
  const usedSocial = field("usedSocial") !== "no";
  const scope = field("scope") || SCOPE_OPTIONS[0].value;
  const inWaiting = field("waiting") === "before";
  const submitted = query.cost !== undefined && cost > 0;
  const selfPay = Math.max(0, cost - social - other);

  const entries: StackEntry[] = [];
  const notes: string[] = [];
  const highlights: { name: string; cap: number; documentId: number; productName: string | null }[] = [];

  for (const policy of group) {
    const context = loadEstimateContext(db, policy.documentId);
    if (!context) continue;

    for (const item of fixedHighlights(context.benefits)) {
      highlights.push({ ...item, documentId: policy.documentId, productName: policy.productName });
    }

    const benefit = pickIndemnityBenefit(context.benefits);
    if (!benefit) {
      notes.push(`${policy.productName ?? policy.filename}：没识别到可以按费用估算的责任。`);
      continue;
    }

    const result = computeEstimate(
      {
        benefitKey: benefit.key,
        scope,
        totalCost: cost,
        socialPaid: social,
        otherPaid: other,
        usedSocial,
        catalogCost: null,
        inWaiting,
        exclusion: null,
        paidThisYear: 0,
        annualLimit: context.annualLimit,
      },
      benefit,
      context.refs,
    );

    entries.push({
      documentId: policy.documentId,
      productName: policy.productName ?? policy.filename,
      insurer: policy.insurer,
      benefitName: benefit.name,
      kind: classifyBenefit(benefit.name),
      payable: result.payable,
      cap: benefit.cap ?? null,
      blocked: result.blockers[0]?.title ?? null,
    });
  }

  const summary = combineStack(entries, selfPay);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-xs text-slate-500 hover:text-slate-900">
        ← 返回保单管理
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-lg font-semibold tracking-tight">几张保单一起算</h1>
        <p className="mt-1.5 text-xs leading-6 text-slate-500">
          同一个被保险人的多张保单，按同样一笔医疗费用分别算一遍：报销型的加起来不会超过实际自付，定额给付型（重疾、身故、残疾、津贴）通常各自独立。
          分摊顺序、重复保险比例分摊这些规则没建模，结果只作量级参考，不构成理赔结论。
        </p>
      </header>

      {names.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center text-sm text-slate-500">
          还没有解析出被保险人，先上传保单。
        </p>
      ) : (
        <>
          <form method="get" className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-600">
                被保险人
                <select name="name" defaultValue={selected} className={fieldClass}>
                  {names.map((name) => (
                    <option key={name} value={name}>
                      {name}（{byInsured.get(name)?.length ?? 0} 份）
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-slate-600">
                就诊范围
                <select name="scope" defaultValue={scope} className={fieldClass}>
                  {SCOPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-slate-600">
                责任范围内医疗费用（元）
                <input name="cost" type="text" inputMode="decimal" defaultValue={field("cost")} className={fieldClass} />
              </label>

              <label className="text-xs text-slate-600">
                社保 / 公费已报（元）
                <input name="social" type="text" inputMode="decimal" defaultValue={field("social")} className={fieldClass} />
              </label>

              <label className="text-xs text-slate-600">
                其他途径已赔（元）
                <input name="other" type="text" inputMode="decimal" defaultValue={field("other")} className={fieldClass} />
              </label>

              <label className="text-xs text-slate-600">
                是否以社保身份就诊
                <select name="usedSocial" defaultValue={usedSocial ? "yes" : "no"} className={fieldClass}>
                  <option value="yes">是，走了社保结算</option>
                  <option value="no">否，没用社保</option>
                </select>
              </label>

              <label className="text-xs text-slate-600">
                费用发生时间
                <select name="waiting" defaultValue={inWaiting ? "before" : "after"} className={fieldClass}>
                  <option value="after">等待期后</option>
                  <option value="before">等待期内</option>
                </select>
              </label>
            </div>
            <button type="submit" className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white">
              一起算
            </button>
          </form>

          {submitted && entries.length > 0 ? (
            <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">{selected} 的 {entries.length} 项责任</h2>
                <p className="text-xs text-slate-500">
                  自付 {formatMoney(selfPay)}（费用 {formatMoney(cost)} − 社保 {formatMoney(social)} − 其他 {formatMoney(other)}）
                </p>
              </div>

              <table className="mt-3 w-full text-left text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="pb-1 font-normal">保单 / 责任</th>
                    <th className="pb-1 font-normal">类型</th>
                    <th className="pb-1 text-right font-normal">按条款算出</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  {entries.map((entry) => (
                    <tr key={`${entry.documentId}-${entry.benefitName}`} className="border-t border-slate-100">
                      <td className="py-2 pr-3">
                        <Link href={`/documents/${entry.documentId}`} className="text-slate-800 hover:underline">
                          {entry.productName}
                        </Link>
                        <p className="mt-0.5 text-slate-400">{entry.benefitName}</p>
                        {entry.blocked ? <p className="mt-0.5 text-amber-600">不赔：{entry.blocked}</p> : null}
                      </td>
                      <td className="py-2 pr-3 text-slate-500">
                        {entry.kind === "indemnity" ? "报销型" : "定额型"}
                      </td>
                      <td className="py-2 text-right tabular-nums text-slate-900">
                        {formatMoney(entry.payable)}
                        {entry.cap ? <span className="ml-1 text-slate-400">/ 上限 {formatMoney(entry.cap)}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <dl className="mt-4 grid gap-2 border-t border-slate-100 pt-3 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-slate-400">报销型合计</dt>
                  <dd className="text-slate-900">{formatMoney(summary.indemnityTotal)}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">定额型合计</dt>
                  <dd className="text-slate-900">{formatMoney(summary.fixedTotal)}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">参考合计</dt>
                  <dd className="font-medium text-slate-900">{formatMoney(summary.total)}</dd>
                </div>
              </dl>

              {summary.capped ? (
                <p className="mt-2 text-xs leading-6 text-amber-700">
                  报销型各项加起来是 {formatMoney(summary.indemnityGross)}，超过自付的 {formatMoney(selfPay)}：实际不可能靠多份保单赚到钱，
                  合计按自付封顶。先报哪家、怎么分摊要问保险公司。
                </p>
              ) : null}
              <p className="mt-2 text-xs leading-6 text-slate-500">
                报销型是「把你花掉的钱补回来」，几张保单不能重复赔同一笔费用；定额型看的是是否符合约定事件，与花多少钱无关。
              </p>
            </section>
          ) : null}

          {highlights.length > 0 ? (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">另有定额给付（不按医疗费用算）</h2>
              <p className="mt-1 text-xs text-slate-500">
                这些要符合合同里的疾病或事故定义才给，金额是保额；与上面按费用算的结果通常是叠加关系。
              </p>
              <ul className="mt-2 space-y-1.5">
                {highlights.map((item) => (
                  <li key={`${item.documentId}-${item.name}`} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 text-slate-700">
                      <Link href={`/documents/${item.documentId}`} className="hover:underline">
                        {item.productName}
                      </Link>
                      <span className="mx-1 text-slate-300">·</span>
                      {item.name.length > 28 ? `${item.name.slice(0, 28)}…` : item.name}
                    </span>
                    <span className="tabular-nums text-slate-900">{formatMoney(item.cap)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {notes.length > 0 ? (
            <ul className="mt-4 space-y-1 text-xs text-amber-700">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}

          <p className="mt-6 text-xs leading-6 text-slate-400">
            这是把几份合同的条款各自算了一遍再加总，没有考虑重复保险的分摊约定、社保先行、免赔额累计等细节；实际以保险公司核定为准。
          </p>
        </>
      )}
    </main>
  );
}
