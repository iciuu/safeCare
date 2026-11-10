import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { UploadForm } from "@/components/upload-form";
import { getDb } from "@/lib/db";
import { formatMoney } from "@/lib/estimate";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  listPolicies,
  type ManagedPolicy,
} from "@/lib/policy-store";
import { deletePolicyAction, rerunAiAction, savePolicyAction } from "./policy-actions";

export const dynamic = "force-dynamic";

const CATEGORY_STYLE: Record<ManagedPolicy["category"], string> = {
  medical: "bg-emerald-50 text-emerald-700 border-emerald-200",
  critical_illness: "bg-violet-50 text-violet-700 border-violet-200",
  accident: "bg-sky-50 text-sky-700 border-sky-200",
  life: "bg-amber-50 text-amber-700 border-amber-200",
  unknown: "bg-slate-100 text-slate-600 border-slate-200",
};

const ERROR_TEXT: Record<string, string> = {
  bad_policy: "没找到这份保单，可能已经被删除。",
  bad_category: "险种选择无效。",
  bad_document: "参数不对，操作没有执行。",
  not_found: "这份保单已经不在库里了。",
  no_api_key: "没有配置 DEEPSEEK_API_KEY，没法重跑 AI 提要点。",
};

const AI_STATUS_TEXT: Record<string, string> = {
  succeeded: "AI 要点已更新",
  failed: "重跑 AI 失败，原有要点保留",
};

const fieldClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-sky-500";

function formatDate(value: string | null): string {
  return value ?? "未识别";
}

export default async function PolicyManagementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const filter = typeof query.category === "string" ? query.category : "";
  const keyword = typeof query.q === "string" ? query.q.trim() : "";
  const policies = listPolicies(getDb());
  const needle = keyword.toLowerCase();
  const visible = policies.filter((item) => {
    if (filter && item.category !== filter) return false;
    if (!needle) return true;
    return [item.productName, item.insurer, item.policyNo, item.insuredName, item.filename]
      .filter(Boolean)
      .some((value) => (value as string).toLowerCase().includes(needle));
  });

  const totalPages = policies.reduce((sum, item) => sum + item.pageCount, 0);
  const totalReview = policies.reduce((sum, item) => sum + item.needsReview, 0);
  const counts = new Map<string, number>();
  for (const item of policies) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);

  const flash = (() => {
    if (typeof query.saved === "string") return { kind: "ok" as const, text: "保单信息已保存。" };
    if (typeof query.deleted === "string") return { kind: "ok" as const, text: "保单已删除，条款和 PDF 文件一并清掉。" };
    if (typeof query.ai === "string") {
      return {
        kind: query.ai === "done" ? ("ok" as const) : ("warn" as const),
        text: AI_STATUS_TEXT[query.ai] ?? "AI 重跑结束。",
      };
    }
    if (typeof query.error === "string") {
      return { kind: "error" as const, text: ERROR_TEXT[query.error] ?? "操作没有完成。" };
    }
    return null;
  })();

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-700">safeCare</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">保单管理</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          上传过的保单都存在本机 SQLite 里，PDF 原件也一起留着；每份保单可回看速查卡、按实际情况估算，也能修正抽取错的字段。
          所有数据只在 <code className="rounded bg-slate-200/70 px-1 py-0.5 text-xs">data/</code> 目录，不上传任何地方。
        </p>
      </header>

      <UploadForm />

      {flash ? (
        <p
          className={`mt-4 rounded-lg px-3 py-2 text-xs ${
            flash.kind === "error"
              ? "bg-rose-50 text-rose-700"
              : flash.kind === "warn"
                ? "bg-amber-50 text-amber-800"
                : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {flash.text}
        </p>
      ) : null}

      <section className="mt-10">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">已入库保单</h2>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
            <span>
              {policies.length} 份 · 共 {totalPages} 页
              {totalReview > 0 ? ` · ${totalReview} 处待复核` : ""}
            </span>
            <Link href="/family" className="text-sky-700 underline decoration-dotted underline-offset-2">
              家庭总览
            </Link>
            <Link href="/stack" className="text-sky-700 underline decoration-dotted underline-offset-2">
              几张保单一起算
            </Link>
          </p>
        </div>

        {policies.length > 0 ? (
          <>
          <form action="/" className="mb-3 flex flex-wrap items-center gap-2">
            {filter ? <input type="hidden" name="category" value={filter} /> : null}
            <input
              name="q"
              defaultValue={keyword}
              placeholder="搜产品、公司、保单号、被保险人…"
              className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs sm:max-w-sm"
            />
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white">
              搜索
            </button>
            {keyword ? (
              <span className="text-xs text-slate-500">
                命中 {visible.length} 份 ·{" "}
                <Link href={filter ? `/?category=${filter}` : "/"} className="text-sky-700 underline">
                  清除
                </Link>
              </span>
            ) : null}
          </form>

          <nav className="mb-4 flex flex-wrap gap-1.5">
            <Link
              href={keyword ? `/?q=${encodeURIComponent(keyword)}` : "/"}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                filter === ""
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
              }`}
            >
              全部 {policies.length}
            </Link>
            {CATEGORY_ORDER.filter((category) => counts.has(category)).map((category) => (
              <Link
                key={category}
                href={`/?category=${category}${keyword ? `&q=${encodeURIComponent(keyword)}` : ""}`}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  filter === category
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
                }`}
              >
                {CATEGORY_LABELS[category]} {counts.get(category)}
              </Link>
            ))}
          </nav>
          </>
        ) : null}

        {policies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center">
            <p className="text-sm text-slate-600">还没有保单。先把电子保单 PDF 传上来。</p>
            <p className="mt-1 text-xs text-slate-500">
              上传后会自动切分条款、抽保障表，并把结果存进本机数据库。
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-8 text-center text-sm text-slate-500">
            {keyword ? `没有匹配「${keyword}」的保单。` : "这个险种下还没有保单。"}
          </p>
        ) : (
          <ul className="space-y-3">
            {visible.map((policy) => (
              <li
                key={policy.documentId}
                id={`p-${policy.documentId}`}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${CATEGORY_STYLE[policy.category]}`}
                      >
                        {CATEGORY_LABELS[policy.category]}
                      </span>
                      <Link
                        href={`/documents/${policy.documentId}`}
                        className="truncate text-sm font-medium text-slate-900 hover:underline"
                      >
                        {policy.productName ?? policy.filename}
                      </Link>
                    </div>

                    <p className="mt-1 text-xs text-slate-500">
                      {policy.insurer ?? "保险公司未识别"}
                      <span className="mx-1.5 text-slate-300">·</span>
                      保单号 {policy.policyNo ?? "未识别"}
                    </p>

                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                      <div>
                        <dt className="text-slate-400">被保险人</dt>
                        <dd className="text-slate-700">{formatDate(policy.insuredName)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">保障期间</dt>
                        <dd className="text-slate-700">
                          {formatDate(policy.effectiveFrom)}
                          {policy.effectiveTo ? ` → ${policy.effectiveTo}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">保费</dt>
                        <dd className="text-slate-700">
                          {policy.premium === null ? "未识别" : `¥ ${formatMoney(policy.premium)}`}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">等待期</dt>
                        <dd className="text-slate-700">
                          {policy.waitingDays === null ? "未识别" : `${policy.waitingDays} 天`}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                      <span>{policy.clauseCount > 0 ? `${policy.clauseCount} 条条款` : "保单摘要（无条款正文）"}</span>
                      <span>{policy.coverageCount} 项责任</span>
                      <span>{policy.exclusionCount} 条免责</span>
                      <span>{policy.aiFacts} 条 AI 要点</span>
                      <span>{policy.pageCount} 页</span>
                      <span>入库 {policy.createdAt}</span>
                      {policy.needsReview > 0 ? (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                          待复核 {policy.needsReview} 处
                        </span>
                      ) : null}
                      {policy.aiStatus === "failed" ? (
                        <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">AI 要点缺</span>
                      ) : null}
                      {!policy.hasTextLayer ? (
                        <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">没有文本层</span>
                      ) : null}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Link
                      href={`/documents/${policy.documentId}`}
                      className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      速查卡
                    </Link>
                    <Link
                      href={`/documents/${policy.documentId}/estimate`}
                      className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      估算
                    </Link>
                    {policy.policyId === null ? (
                      <a
                        href={`/api/documents/${policy.documentId}/file`}
                        className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        原件
                      </a>
                    ) : (
                      <>
                        <form action={rerunAiAction}>
                          <input type="hidden" name="documentId" value={policy.documentId} />
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            重跑 AI
                          </button>
                        </form>
                        <form action={deletePolicyAction}>
                          <input type="hidden" name="documentId" value={policy.documentId} />
                          <ConfirmButton
                            confirmLabel="确认删除"
                            className="rounded-md border border-rose-200 px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-50"
                            confirmClassName="rounded-md border border-rose-600 bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
                          >
                            删除
                          </ConfirmButton>
                        </form>
                      </>
                    )}
                  </div>
                </div>

                {policy.policyId === null ? (
                  <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    这份文件没有生成保单记录（解析可能没走完），条款和原文还能看，字段管理先用不了。
                    <a
                      href={`/api/documents/${policy.documentId}/file`}
                      className="ml-1 underline decoration-dotted underline-offset-2"
                    >
                      下载原件
                    </a>
                  </p>
                ) : (
                  <details className="mt-3 border-t border-slate-100 pt-2">
                    <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">
                      修正保单信息
                    </summary>
                    <form action={savePolicyAction} className="mt-3">
                      <input type="hidden" name="policyId" value={policy.policyId} />
                      <div className="grid gap-3 sm:grid-cols-4">
                        <label className="text-xs text-slate-600">
                          险种
                          <select name="category" defaultValue={policy.category} className={fieldClass}>
                            {CATEGORY_ORDER.map((category) => (
                              <option key={category} value={category}>
                                {CATEGORY_LABELS[category]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-xs text-slate-600">
                          保险公司
                          <input name="insurer" defaultValue={policy.insurer ?? ""} className={fieldClass} />
                        </label>
                        <label className="text-xs text-slate-600">
                          产品名称
                          <input
                            name="productName"
                            defaultValue={policy.productName ?? ""}
                            className={fieldClass}
                          />
                        </label>
                        <label className="text-xs text-slate-600">
                          保单号
                          <input name="policyNo" defaultValue={policy.policyNo ?? ""} className={fieldClass} />
                        </label>
                        <label className="text-xs text-slate-600">
                          投保人
                          <input name="holderName" defaultValue={policy.holderName ?? ""} className={fieldClass} />
                        </label>
                        <label className="text-xs text-slate-600">
                          被保险人
                          <input
                            name="insuredName"
                            defaultValue={policy.insuredName ?? ""}
                            className={fieldClass}
                          />
                        </label>
                        <label className="text-xs text-slate-600">
                          起保日期
                          <input
                            name="effectiveFrom"
                            defaultValue={policy.effectiveFrom ?? ""}
                            placeholder="2025-06-01"
                            className={fieldClass}
                          />
                        </label>
                        <label className="text-xs text-slate-600">
                          到期日期
                          <input
                            name="effectiveTo"
                            defaultValue={policy.effectiveTo ?? ""}
                            placeholder="2026-05-31"
                            className={fieldClass}
                          />
                        </label>
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          type="submit"
                          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                        >
                          保存
                        </button>
                        <span className="text-xs text-slate-400">
                          只改库里的记录，不动 PDF 原文；留空表示未识别。
                        </span>
                      </div>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-12 text-xs leading-6 text-slate-400">
        本工具只做条款整理，不构成理赔意见；关键结论请以合同原文为准。
      </footer>
    </main>
  );
}
