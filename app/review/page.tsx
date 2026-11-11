import Link from "next/link";
import { ReviewShortcuts } from "@/components/review-shortcuts";
import { resolveElementAction } from "@/app/policy-actions";
import { getDb } from "@/lib/db";
import { ELEMENT_KIND_LABELS } from "@/lib/elements";
import { listPendingElements } from "@/lib/review";

export const dynamic = "force-dynamic";

const POLICY_LABEL: Record<string, string> = {
  medical: "医疗险",
  critical_illness: "重疾险",
  accident: "意外险",
  life: "寿险",
  unknown: "未识别",
};

/**
 * 集中复核：所有「待复核」要素排成一条队列，键盘逐条过。
 * 同一条事实在保单里前后给了不同值，本程序不替它选，这里就是人工做决定的出口。
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  const items = listPendingElements(getDb());

  const groups: { documentId: number; product: string; insurer: string | null; category: string; items: typeof items }[] =
    [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.documentId === item.documentId) last.items.push(item);
    else
      groups.push({
        documentId: item.documentId,
        product: item.product,
        insurer: item.insurer,
        category: item.category,
        items: [item],
      });
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/" className="text-xs text-slate-500 hover:text-slate-900">
        ← 返回保单管理
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-lg font-semibold tracking-tight">集中复核</h1>
        <p className="mt-1 text-xs text-slate-500">
          待复核 {items.length} 条 · 覆盖 {groups.length} 份保单。这些是保单里前后给了不同值、或没抽全的要素，程序没有替它们选。
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          <span>
            <kbd className="rounded border border-slate-300 px-1">j</kbd> /{" "}
            <kbd className="rounded border border-slate-300 px-1">k</kbd> 上下一条
          </span>
          <span>
            <kbd className="rounded border border-slate-300 px-1">Enter</kbd> 保存并继续
          </span>
          <span>
            <kbd className="rounded border border-slate-300 px-1">c</kbd> 原样确认
          </span>
          <span>
            <kbd className="rounded border border-slate-300 px-1">i</kbd> 忽略
          </span>
        </p>
      </header>

      {done === "1" ? (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          已处理一条，队列里少了一条；速查卡和待复核计数已经跟着更新。
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
          没有待复核的要素了。新上传的保单抽完如果出现冲突，会重新出现在这里。
        </p>
      ) : null}

      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.documentId}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                {group.product}
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {group.insurer ?? "公司未识别"} · {POLICY_LABEL[group.category] ?? group.category} · 剩{" "}
                  {group.items.length} 条
                </span>
              </h2>
              <Link
                href={`/documents/${group.documentId}`}
                className="text-xs text-sky-700 underline decoration-dotted underline-offset-2"
              >
                打开这份保单
              </Link>
            </div>

            <ul className="space-y-2">
              {group.items.map((item) => (
                <li
                  key={item.id}
                  data-review-item
                  className="rounded-xl border border-amber-200 bg-white px-3 py-2.5"
                >
                  <form action={resolveElementAction} className="space-y-2">
                    <input type="hidden" name="documentId" value={item.documentId} />
                    <input type="hidden" name="elementId" value={item.id} />
                    <input type="hidden" name="returnTo" value="/review?done=1" />

                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                      <span className="text-amber-900">
                        {ELEMENT_KIND_LABELS[item.kind as keyof typeof ELEMENT_KIND_LABELS] ?? item.kind} · P
                        {item.pageNo}
                        {item.clauseNo ? ` · ${item.clauseNo}` : ""}
                      </span>
                      <a
                        href={`/documents/${item.documentId}?p=${item.pageNo}&q=${encodeURIComponent(item.quote.slice(0, 60))}#doc`}
                        className="text-sky-700 underline decoration-dotted underline-offset-2"
                      >
                        看原文
                      </a>
                    </div>

                    {item.quote ? (
                      <p className="line-clamp-2 text-xs text-slate-500">「{item.quote}」</p>
                    ) : (
                      <p className="text-xs text-amber-600">模型没给引文，只能靠页码确认。</p>
                    )}

                    <div className="flex flex-wrap gap-1.5">
                      <label className="flex items-center gap-1 text-xs text-slate-500">
                        标签
                        <input
                          name="label"
                          defaultValue={item.label}
                          className="w-40 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-slate-500">
                        值
                        <input
                          name="value"
                          defaultValue={item.value}
                          className="w-28 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-900"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-slate-500">
                        单位
                        <input
                          name="unit"
                          defaultValue={item.unit}
                          className="w-16 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-slate-500">
                        条件
                        <input
                          name="condition"
                          defaultValue={item.condition}
                          className="w-32 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="submit"
                        name="action"
                        value="save"
                        data-act="save"
                        className="rounded bg-slate-900 px-2.5 py-1 text-xs text-white"
                      >
                        保存并继续
                      </button>
                      <button
                        type="submit"
                        name="action"
                        value="confirm"
                        data-act="confirm"
                        className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700"
                      >
                        原样确认
                      </button>
                      <button
                        type="submit"
                        name="action"
                        value="ignore"
                        data-act="ignore"
                        className="rounded px-2.5 py-1 text-xs text-slate-500 hover:text-slate-900"
                      >
                        忽略这条
                      </button>
                    </div>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <ReviewShortcuts />
    </main>
  );
}
