import Link from "next/link";
import { AskAnswer } from "@/components/ask-answer";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import { getDb } from "@/lib/db";
import { retrieveClauses } from "@/lib/qa";

export const dynamic = "force-dynamic";

const EXAMPLES = [
  "住院前七天的门诊检查费用能报吗",
  "意外险的意外医疗有没有免赔额",
  "重疾险的轻症赔多少",
];

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const question = typeof q === "string" ? q.trim() : "";

  const db = getDb();
  const clauseCount = (
    db.prepare("SELECT COUNT(*) AS n FROM clause").get() as { n: number }
  ).n;
  const related = retrieveClauses(db, question);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-xs text-slate-500 hover:text-slate-900">
        ← 返回保单管理
      </Link>

      <header className="mt-4 mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-700">safeCare</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">问条款</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          用一句日常的话问，答案只依据已经入库的条款原文，每条结论都点得回页码和条款号；
          条款没写清的地方会列出来让你确认，不替你猜。
        </p>
      </header>

      <form action="/ask" className="flex flex-wrap items-start gap-2">
        <input
          name="q"
          defaultValue={question}
          placeholder="例如：住院前七天的门诊检查费用能报吗"
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white">
          检索
        </button>
      </form>

      {question === "" ? (
        <div className="mt-6">
          <p className="text-xs text-slate-500">
            库里 {clauseCount} 条条款，可以直接问，也可以从这几句试试：
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map((item) => (
              <li key={item}>
                <Link
                  href={`/ask?q=${encodeURIComponent(item)}`}
                  className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:border-slate-400"
                >
                  {item}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {question !== "" && related.length === 0 ? (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-amber-800">不回答这个问题</h2>
          <p className="mt-1 text-xs leading-5 text-amber-800">
            在已入库的 {clauseCount} 条条款里没有检索到相关内容。可能这份条款还没上传，也可能换个说法更准
            （比如把「住院前门诊」说成「住院前后的门急诊」）。没有原文支撑，这里不给结论。
          </p>
        </section>
      ) : null}

      {related.length > 0 ? (
        <>
          <section className="mt-6">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900">检索到的条款</h2>
              <span className="text-xs text-slate-500">{related.length} 条 · 按相关度排序</span>
            </div>
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
              {related.map((hit) => (
                <li key={hit.clauseId} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-800">{hit.clauseNo}</span>
                    <a
                      href={`/documents/${hit.documentId}?p=${hit.page}#doc`}
                      className="text-sky-700 underline decoration-dotted underline-offset-2"
                    >
                      P{hit.page}
                    </a>
                    {hit.productName ? <span>{hit.productName}</span> : null}
                    {hit.heading ? <span>· {hit.heading}</span> : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{hit.snippet}</p>
                </li>
              ))}
            </ul>
          </section>

          <AskAnswer question={question} configured={deepseekConfigured()} />
        </>
      ) : null}

      <p className="mt-8 text-xs leading-5 text-slate-400">
        答案只复述条款怎么规定，不构成理赔结论，也不代表保险公司会赔。
        只有你问的问题和检索到的条款原文（已脱敏）会发给模型，其余数据留在本机。
      </p>
    </main>
  );
}
