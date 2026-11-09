"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type PageMeta = { page_no: number; char_count: number };

type Props = {
  id: number;
  filename: string;
  pageCount: number;
  pages: PageMeta[];
  /** 从速查卡点过来的页码与要高的引文 */
  focusPage?: number;
  highlight?: string;
};

export function DocumentViewer({ id, filename, pageCount, pages, focusPage, highlight }: Props) {
  const [view, setView] = useState<"text" | "pdf">("text");
  const [page, setPage] = useState(focusPage && focusPage >= 1 ? focusPage : 1);
  const markRef = useRef<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<number, string>());

  const meta = useMemo(() => pages.find((item) => item.page_no === page), [pages, page]);

  useEffect(() => {
    if (view !== "text" || pageCount === 0) return;

    const cached = cache.current.get(page);
    if (cached !== undefined) {
      setText(cached);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/documents/${id}/pages/${page}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
        return (await response.json()) as { text: string };
      })
      .then((payload) => {
        cache.current.set(page, payload.text);
        setText(payload.text);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setText("");
        setError(cause instanceof Error ? cause.message : "未知错误");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [id, page, pageCount, view]);

  useEffect(() => {
    if (focusPage && focusPage >= 1 && focusPage <= pageCount) setPage(focusPage);
  }, [focusPage, pageCount]);

  useEffect(() => {
    if (!text || !highlight) return;
    markRef.current?.scrollIntoView({ block: "center" });
  }, [text, highlight]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") setPage((current) => Math.max(1, current - 1));
      if (event.key === "ArrowRight") setPage((current) => Math.min(pageCount, current + 1));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageCount]);

  return (
    <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">页面</p>
        <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1">
          {pages.map((item) => (
            <button
              key={item.page_no}
              type="button"
              onClick={() => setPage(item.page_no)}
              className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-xs transition-colors ${
                item.page_no === page
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <span>第 {item.page_no} 页</span>
              <span className={item.page_no === page ? "text-slate-300" : "text-slate-400"}>
                {item.char_count}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="text-xs tabular-nums text-slate-600">
              {page} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              disabled={page >= pageCount}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 disabled:opacity-40"
            >
              下一页
            </button>
          </div>

          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
            {(
              [
                { key: "text", label: "提取文本" },
                { key: "pdf", label: "原文 PDF" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setView(option.key)}
                className={`rounded px-3 py-1 text-xs transition-colors ${
                  view === option.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {view === "pdf" ? (
          <iframe
            key={page}
            title={`${filename} 第 ${page} 页`}
            src={`/api/documents/${id}/file#page=${page}&zoom=page-width`}
            className="h-[75vh] w-full rounded-xl border border-slate-200 bg-white"
          />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500">
              <span>第 {page} 页 · {meta?.char_count ?? 0} 字</span>
              {loading ? <span>加载中…</span> : <span>按 ← → 翻页</span>}
            </div>
            <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
              {error ? (
                <p className="text-sm text-rose-600">{error}</p>
              ) : text.length === 0 && !loading ? (
                <p className="text-sm text-slate-500">
                  这一页没有文字层。可能是扫描件或图片型 PDF —— 当前版本不做 OCR。
                </p>
              ) : (
                <>
                  {highlight && !text.includes(highlight) ? (
                    <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                      引文不在本页（条款可能跨页），可翻到下一页或看「保障要点」里的原文。
                    </p>
                  ) : null}
                  <pre className="whitespace-pre-wrap break-words text-[13px] leading-7 text-slate-800">
                    {highlight && text.includes(highlight) ? (
                      <>
                        {text.slice(0, text.indexOf(highlight))}
                        <mark ref={markRef} className="rounded bg-amber-200 px-0.5 text-slate-900">
                          {highlight}
                        </mark>
                        {text.slice(text.indexOf(highlight) + highlight.length)}
                      </>
                    ) : (
                      text
                    )}
                  </pre>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
