import Link from "next/link";
import { UploadForm } from "@/components/upload-form";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type DocumentRow = {
  id: number;
  filename: string;
  page_count: number;
  char_count: number;
  byte_size: number;
  has_text_layer: number;
  status: string;
  created_at: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function HomePage() {
  const db = getDb();
  const documents = db
    .prepare(
      "SELECT id, filename, page_count, char_count, byte_size, has_text_layer, status, created_at FROM document ORDER BY id DESC",
    )
    .all() as unknown as DocumentRow[];

  const totalPages = documents.reduce((sum, doc) => sum + doc.page_count, 0);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-700">safeCare</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">家庭保单速查</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          上传电子保单，先把它逐页拆开、保存原文；下一步才会切分条款并抽取保障要素。
          所有文件与数据只存在本机 <code className="rounded bg-slate-200/70 px-1 py-0.5 text-xs">data/</code> 目录。
        </p>
      </header>

      <UploadForm />

      <section className="mt-10">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">已上传文档</h2>
          <p className="text-xs text-slate-500">
            {documents.length} 份 · 共 {totalPages} 页
          </p>
        </div>

        {documents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center">
            <p className="text-sm text-slate-600">还没有文档。先丢一份医疗险的电子保单进来。</p>
            <p className="mt-1 text-xs text-slate-500">
              当前阶段只做「上传 → 去重 → 文本层提取」，条款切分与保障要素抽取是下一步。
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {documents.map((doc) => (
              <li key={doc.id}>
                <Link
                  href={`/documents/${doc.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{doc.filename}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span>{doc.page_count} 页</span>
                      <span>{doc.char_count.toLocaleString("zh-CN")} 字</span>
                      <span>{formatSize(doc.byte_size)}</span>
                      <span>{doc.created_at}</span>
                    </p>
                  </div>
                  {doc.has_text_layer ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
                      有文本层
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                      未检测到文本
                    </span>
                  )}
                </Link>
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
