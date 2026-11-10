import Link from "next/link";
import { notFound } from "next/navigation";
import { AiClaim } from "@/components/ai-claim";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import type { ClaimRequest } from "@/lib/claim-request";
import { getDb } from "@/lib/db";
import {
  computeEstimate,
  formatMoney,
  SCOPE_OPTIONS,
  toAmount,
  type ClauseRef,
} from "@/lib/estimate";
import { loadEstimateContext } from "@/lib/estimate-context";

export const dynamic = "force-dynamic";

function RefLink({ id, target }: { id: number; target: ClauseRef | null }) {
  if (!target) return null;
  return (
    <a
      href={`/documents/${id}?p=${target.page}#doc`}
      className="text-sky-700 underline decoration-dotted underline-offset-2"
    >
      {target.clauseNo} · P{target.page}
    </a>
  );
}

export default async function EstimatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isInteger(documentId) || documentId <= 0) notFound();

  const context = loadEstimateContext(getDb(), documentId);
  if (!context) notFound();

  const query = await searchParams;
  const field = (name: string): string => {
    const value = query[name];
    return typeof value === "string" ? value : "";
  };

  const submitted = query.cost !== undefined;
  const benefit =
    context.benefits.find((item) => item.key === field("benefit")) ?? context.benefits[0] ?? null;
  const scopeValue = field("scope") || benefit?.scopes[0] || "";
  const usedSocial = field("usedSocial") !== "no";
  const catalogText = field("catalog").trim();
  const exclusionValue = field("exclusion");
  const exclusionIndex = exclusionValue === "" ? null : Number(exclusionValue);
  // 分项限额：只取合同里真解析出来的类别，金额由用户按本次费用拆分填
  const subLimitRows = context.subLimits.slice(0, 4).map((item, index) => ({
    label: item.label,
    limit: item.limit,
    kind: item.kind,
    page: item.page,
    clauseNo: item.clauseNo,
    amount: toAmount(field(`sub${index}`)),
  }));
  const subLimitsFilled = subLimitRows
    .filter((item) => item.kind === "total" && item.amount > 0)
    .map((item) => ({ label: item.label, limit: item.limit, amount: item.amount }));

  // 骨折、关节脱位、残疾、烧伤这类责任按《给付比例表》乘保额，比例表通常不在正文里
  const ratioTableBenefit = /骨折|关节脱位|残疾|烧伤|伤残/.test(benefit?.name ?? "");
  const flatRatioText = field("flatRatio").trim();
  const flatRatio = flatRatioText === "" ? null : toAmount(flatRatioText);

  const exclusionText =
    exclusionIndex === null || !Number.isInteger(exclusionIndex)
      ? null
      : (context.exclusions[exclusionIndex]?.text ?? null);
  const inWaiting = field("waiting") === "before";

  const result =
    submitted && benefit
      ? computeEstimate(
          {
            benefitKey: benefit.key,
            scope: scopeValue,
            totalCost: toAmount(field("cost")),
            socialPaid: toAmount(field("social")),
            otherPaid: toAmount(field("other")),
            usedSocial,
            catalogCost: usedSocial || catalogText === "" ? null : toAmount(catalogText),
            inWaiting,
            exclusion: exclusionText,
            paidThisYear: toAmount(field("paid")),
            annualLimit: context.annualLimit,
            subLimits: subLimitsFilled,
            flatRatio,
          },
          benefit,
          context.refs,
        )
      : null;

  const aiRequest: ClaimRequest | null =
    result && benefit
      ? {
          benefit: benefit.key,
          scope: scopeValue,
          cost: toAmount(field("cost")),
          social: toAmount(field("social")),
          other: toAmount(field("other")),
          usedSocial,
          catalog: usedSocial || catalogText === "" ? null : toAmount(catalogText),
          waiting: inWaiting,
          exclusionIndex: exclusionIndex !== null && Number.isInteger(exclusionIndex) ? exclusionIndex : null,
          paid: toAmount(field("paid")),
          subLimits: subLimitsFilled,
          flatRatio,
        }
      : null;

  const fieldClass =
    "mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-sky-500";

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href={`/documents/${documentId}`} className="text-xs text-slate-500 hover:text-slate-900">
        ← 返回 {context.productName ?? context.document.filename}
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-lg font-semibold tracking-tight">按条款算一笔</h1>
        <p className="mt-1.5 text-xs text-slate-500">
          填这次的实际花费和就诊情况，按条款逐段算预估可赔金额，再让 AI 独立判一次，两个结果放在一起看。都只是参考，不构成理赔结论，最终以保险公司核定为准。
        </p>
      </header>

      {context.benefits.length === 0 ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
          {context.notes[0] ?? "这份文档里没识别到可估算的保险责任。"}
        </p>
      ) : (
        <>
          <form method="get" className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-600">
                保险责任
                <select name="benefit" defaultValue={benefit?.key} className={fieldClass}>
                  {context.benefits.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name}
                      {item.source === "builtin" ? "（内置规则）" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-slate-600">
                就诊范围
                <select name="scope" defaultValue={scopeValue} className={fieldClass}>
                  {SCOPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-slate-600">
                责任范围内医疗费用（元）
                <input
                  name="cost"
                  defaultValue={field("cost")}
                  inputMode="decimal"
                  placeholder="例如 32000"
                  className={fieldClass}
                />
              </label>

              <label className="text-xs text-slate-600">
                社保 / 公费 / 补充医疗已报（元）
                <input
                  name="social"
                  defaultValue={field("social")}
                  inputMode="decimal"
                  placeholder="例如 12000"
                  className={fieldClass}
                />
              </label>

              <label className="text-xs text-slate-600">
                其他途径已赔（单位、其他商业保险，元）
                <input
                  name="other"
                  defaultValue={field("other")}
                  inputMode="decimal"
                  placeholder="没有就留空"
                  className={fieldClass}
                />
              </label>

              <label className="text-xs text-slate-600">
                是否以社保身份就诊
                <select name="usedSocial" defaultValue={usedSocial ? "yes" : "no"} className={fieldClass}>
                  <option value="yes">是，走了社保结算</option>
                  <option value="no">否，没用社保</option>
                </select>
              </label>

              <label className="text-xs text-slate-600">
                其中医保目录内费用（元）
                <input
                  name="catalog"
                  defaultValue={field("catalog")}
                  inputMode="decimal"
                  placeholder="没用社保时填，留空按全额目录内算"
                  className={fieldClass}
                />
              </label>

              <label className="text-xs text-slate-600">
                费用发生时间
                <select name="waiting" defaultValue={inWaiting ? "before" : "after"} className={fieldClass}>
                  <option value="after">
                    等待期后
                    {context.waitingDays ? `（已过 ${context.waitingDays} 天）` : "（这份保单没有疾病等待期）"}
                  </option>
                  {context.waitingDays ? (
                    <option value="before">等待期内（含投保后 {context.waitingDays} 天内发病）</option>
                  ) : null}
                </select>
              </label>

              <label className="text-xs text-slate-600 sm:col-span-2">
                是否命中责任免除
                <select name="exclusion" defaultValue={exclusionValue} className={fieldClass}>
                  <option value="">没有命中任何免责情形</option>
                  {context.exclusions.map((row, index) => (
                    <option key={row.id} value={String(index)}>
                      {row.text.split("：")[0]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-slate-600">
                本保险期间已累计赔付（元）
                <input
                  name="paid"
                  defaultValue={field("paid") || "0"}
                  inputMode="decimal"
                  className={fieldClass}
                />
              </label>

              {ratioTableBenefit ? (
                <label className="text-xs text-slate-600">
                  按《给付比例表》查到的比例（%）
                  <input
                    name="flatRatio"
                    defaultValue={field("flatRatio")}
                    inputMode="decimal"
                    placeholder="如 10"
                    className={fieldClass}
                  />
                  <span className="mt-0.5 block text-[11px] text-slate-400">
                    这项按「保额 × 比例」给，比例表在条款附表里，这里不替你猜
                  </span>
                </label>
              ) : null}

              {subLimitRows.map((item, index) =>
                item.kind === "total" ? (
                  <label key={item.label} className="text-xs text-slate-600">
                    其中：{item.label}（元）
                    <input
                      name={`sub${index}`}
                      defaultValue={field(`sub${index}`)}
                      inputMode="decimal"
                      className={fieldClass}
                    />
                    <span className="mt-0.5 block text-[11px] text-slate-400">
                      合同对这一项单独限额 {formatMoney(item.limit)} 元 · P{item.page}
                      {item.clauseNo ? ` · ${item.clauseNo}` : ""}
                    </span>
                  </label>
                ) : null,
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                算预估金额
              </button>
              <span className="text-xs text-slate-400">
                {context.annualLimit === null
                  ? "未识别每一保险期间的累计给付限额"
                  : `每一保险期间累计给付限额 ${formatMoney(context.annualLimit)} 元`}
              </span>
            </div>
          </form>

          {result ? (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">按条款计算</h2>
                <span className="text-xs text-slate-400">
                  {benefit?.name} · {scopeValue}
                </span>
              </div>

              <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">
                ¥ {formatMoney(result.payable)}
              </p>

              {result.blockers.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {result.blockers.map((blocker) => (
                    <li
                      key={blocker.title}
                      className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
                    >
                      <span className="font-medium">{blocker.title}</span>
                      <span className="ml-1">{blocker.detail}</span>
                      <span className="ml-1">
                        <RefLink id={documentId} target={blocker.ref} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    <p>
                      责任范围内费用 {formatMoney(toAmount(field("cost")))} 元
                      {toAmount(field("social")) > 0 ? ` − 社保已报 ${formatMoney(toAmount(field("social")))} 元` : ""}
                      {toAmount(field("other")) > 0 ? ` − 其他途径 ${formatMoney(toAmount(field("other")))} 元` : ""}
                      {" = "}
                      <span className="font-medium text-slate-900">基数 {formatMoney(result.base)} 元</span>
                      {context.refs.compensation ? (
                        <span className="ml-1">
                          依据 <RefLink id={documentId} target={context.refs.compensation} />
                        </span>
                      ) : null}
                    </p>
                  </div>

                  {result.parts.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-400">
                          <th className="pb-1 font-normal">分段</th>
                          <th className="pb-1 text-right font-normal">金额</th>
                          <th className="pb-1 text-right font-normal">比例</th>
                          <th className="pb-1 text-right font-normal">给付</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {result.parts.map((part, index) => (
                          <tr key={`${part.label}-${index}`} className="border-t border-slate-100">
                            <td className="py-1 text-slate-700">{part.label}</td>
                            <td className="py-1 text-right text-slate-700">{formatMoney(part.portion)}</td>
                            <td className="py-1 text-right text-slate-700">
                              {Math.round(part.ratio * 100)}%
                            </td>
                            <td className="py-1 text-right text-slate-900">{formatMoney(part.amount)}</td>
                          </tr>
                        ))}
                        <tr className="border-t border-slate-200">
                          <td className="py-1 text-slate-500" colSpan={3}>
                            按比例合计
                          </td>
                          <td className="py-1 text-right font-medium text-slate-900">
                            {formatMoney(result.gross)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ) : null}

                  {context.refs.benefitTable || (context.annualLimit !== null && context.refs.limit) ? (
                    <p className="text-xs text-slate-500">
                      {context.refs.benefitTable ? (
                        <>比例依据 <RefLink id={documentId} target={context.refs.benefitTable} /></>
                      ) : null}
                      {context.annualLimit !== null && context.refs.limit ? (
                        <>
                          {context.refs.benefitTable ? " · " : null}限额依据{" "}
                          <RefLink id={documentId} target={context.refs.limit} />
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              )}

              {result.notes.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs text-amber-700">
                  {result.notes.map((note) => (
                    <li key={note}>· {note}</li>
                  ))}
                </ul>
              ) : null}

              <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-400">
                只按条款文字算：医院等级、合理且必要性的核定没建模；分项限额只认合同里明写的那几项，没填金额的类别没扣。实际赔付以保险公司核定为准。
              </p>
            </section>
          ) : null}

          {result && aiRequest ? (
            <AiClaim
              documentId={documentId}
              request={aiRequest}
              deterministicPayable={result.payable}
              configured={deepseekConfigured()}
            />
          ) : null}

          {context.notes.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-slate-500">
              {context.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </main>
  );
}
