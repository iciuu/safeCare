"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Notice = { kind: "ok" | "warn" | "error"; text: string };

const ERROR_TEXT: Record<string, string> = {
  missing_file: "没有选择文件。",
  not_pdf: "只支持 PDF 文件。",
  invalid_form: "上传格式无法识别，请重试。",
  parse_failed: "解析失败：可能是加密或损坏的 PDF。",
};

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setNotice(null);

    try {
      const body = new FormData();
      body.append("file", file);

      const response = await fetch("/api/documents", { method: "POST", body });
      const payload = (await response.json()) as {
        id?: number;
        duplicate?: boolean;
        pages?: number;
        error?: string;
        detail?: string;
      };

      if (!response.ok || !payload.id) {
        setNotice({
          kind: "error",
          text: ERROR_TEXT[payload.error ?? ""] ?? payload.detail ?? "上传失败。",
        });
        return;
      }

      setNotice(
        payload.duplicate
          ? { kind: "warn", text: "这份文件之前已经上传过，直接跳到已有记录。" }
          : { kind: "ok", text: `已解析 ${payload.pages ?? 0} 页。` },
      );
      router.push(`/documents/${payload.id}`);
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "上传失败。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        className={`rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? "border-emerald-400 bg-emerald-50/60" : "border-slate-300 bg-white"
        }`}
      >
        <p className="text-sm font-medium text-slate-800">
          {busy ? "正在解析…" : "把电子保单 PDF 拖到这里"}
        </p>
        <p className="mt-1 text-xs text-slate-500">文件按内容指纹去重，同一份传两次不会重复占空间</p>

        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          选择文件
        </button>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
        />
      </div>

      {notice ? (
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-xs ${
            notice.kind === "error"
              ? "bg-rose-50 text-rose-700"
              : notice.kind === "warn"
                ? "bg-amber-50 text-amber-700"
                : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
