import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { buildClaimGuide, hasClaimGuide, type ClaimSource } from "@/lib/claim-guide";

export const dynamic = "force-dynamic";

function SourceLink({ id, source }: { id: number; source: ClaimSource }) {
  const quote = encodeURIComponent(source.quote.slice(0, 60));
  return (
    <a
      href={`/documents/${id}?p=${source.page}&q=${quote}#doc`}
      className="shrink-0 text-xs text-sky-700 underline decoration-dotted underline-offset-2"
    >
      {source.clauseNo ? `${source.clauseNo} · ` : ""}P{source.page}
    </a>
  );
}

export default async function ClaimGuidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isInteger(documentId) || documentId <= 0) notFound();

  const db = getDb();
  const document = db.prepare("SELECT id, filename, page_count FROM document WHERE id = ?").get(documentId) as
    | { id: number; filename: string; page_count: number }
    | undefined;
  if (!document) notFound();

  const policy = db
    .prepare(
      "SELECT product_name, insurer, policy_no FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(documentId) as { product_name: string | null; insurer: string | null; policy_no: string | null } | undefined;

  // 能切出条款的用条款（带条款号）；只有页文本的退到页，条款号留空
  const clauses = db
    .prepare("SELECT clause_no, page_from, heading_path, text FROM clause WHERE document_id = ? ORDER BY seq")
    .all(documentId) as { clause_no: string | null; page_from: number; heading_path: string | null; text: string }[];

  const source =
    clauses.length > 0
      ? clauses
      : (db
          .prepare("SELECT page_no, text FROM page WHERE document_id = ? ORDER BY page_no")
          .all(documentId) as { page_no: number; text: string }[]).map((page) => ({
          clause_no: null,
          page_from: page.page_no,
          heading_path: null,
          text: page.text,
        }));

  const guide = buildClaimGuide(source);
  const empty = !hasClaimGuide(guide);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-slate-900">
          ← 返回保单管理
        </Link>
        <Link href={`/documents/${documentId}`} className="hover:text-slate-900">
          ← 返回这份保单
        </Link>
      </div>

      <header className="mt-4 mb-6">
        <h1 className="text-lg font-semibold tracking-tight">出事了怎么报</h1>
        <p className="mt-1.5 text-xs text-slate-500">
          {policy?.product_name ?? document.filename}
          {policy?.insurer ? ` · ${policy.insurer}` : ""}
          {policy?.policy_no ? ` · 保单号 ${policy.policy_no}` : ""}
        </p>
        <p className="mt-2 text-xs leading-6 text-slate-500">
          下面每一条都摘自这份合同的原文，点页码能跳回去看上下文。合同没写的一律写「未识别」，不拿别家的规矩补。
        </p>
      </header>

      {empty ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <p className="font-medium">这份文件里没找到理赔流程的原文。</p>
          <p className="mt-1 text-xs leading-6 text-amber-800">
            {document.page_count <= 3
              ? "这类只有一两页的电子保单通常只给保障摘要，条款正文（含申请材料、核定时限）在另一份条款册里，或者要问保险公司客服。"
              : "条款里没有「保险金申请 / 事故通知」这类段落，可能切分没覆盖到，可以回详情页看原文自行确认。"}
          </p>
          {guide.hotline ? (
            <p className="mt-2 text-xs text-amber-900">文件里出现的客服电话：{guide.hotline}</p>
          ) : null}
        </section>
      ) : (
        <>
          <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">第一步 · 报案</h2>
            {guide.notify ? (
              <>
                <p className="mt-2 text-sm text-slate-800">{guide.notify.text}</p>
                <p className="mt-1 text-xs leading-6 text-slate-500">「{guide.notify.source.quote}」</p>
                <div className="mt-2 flex justify-end">
                  <SourceLink id={documentId} source={guide.notify.source} />
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-amber-600">未识别到事故通知时限，以保险公司要求为准。</p>
            )}
            {guide.hotline ? (
              <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
                合同里出现的客服电话：<span className="font-medium text-slate-800">{guide.hotline}</span>
              </p>
            ) : null}
          </section>

          <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">第二步 · 准备材料</h2>
              <p className="text-xs text-slate-400">共 {guide.materials.length} 项</p>
            </div>
            {guide.materials.length > 0 ? (
              <ol className="mt-2 space-y-2">
                {guide.materials.map((item, index) => (
                  <li key={`${item.source.page}-${index}`} className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-xs leading-6 text-slate-700">
                      <span className="mr-1 text-slate-400">{index + 1}.</span>
                      {item.text}
                    </p>
                    <SourceLink id={documentId} source={item.source} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-xs text-amber-600">未识别到材料清单。</p>
            )}
            {guide.materialsNote ? (
              <p className="mt-3 border-t border-slate-100 pt-2 text-xs leading-6 text-slate-500">
                材料不全时：{guide.materialsNote}
              </p>
            ) : null}
          </section>

          <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">第三步 · 等答复</h2>
            {guide.timeline.length > 0 ? (
              <dl className="mt-2 space-y-2">
                {guide.timeline.map((item) => (
                  <div key={item.label} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <dt className="text-xs text-slate-400">{item.label}</dt>
                      <dd className="text-xs leading-6 text-slate-800">{item.value}</dd>
                    </div>
                    <SourceLink id={documentId} source={item.source} />
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-amber-600">未识别到核定时限。</p>
            )}
          </section>

          <section className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs leading-6 text-sky-900">
            材料之外还要注意「报不报」：这份保单的免责情形见{" "}
            <Link href={`/documents/${documentId}#quick`} className="underline decoration-dotted underline-offset-2">
              详情页的速查卡
            </Link>
            。金额怎么算可以走
            <Link href={`/documents/${documentId}/estimate`} className="mx-1 underline decoration-dotted underline-offset-2">
              按条款估算
            </Link>
            。
          </section>
        </>
      )}

      <p className="mt-6 text-xs leading-6 text-slate-400">
        实际理赔以保险合同约定和保险公司核定为准；这里只是把合同里写明的流程和时限摘出来，不构成理赔承诺。
      </p>
    </main>
  );
}
