"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

export type ExtractStatusPayload = {
  status: string | null;
  promptVersion: string | null;
  model: string | null;
  batches: number;
  done: number;
  failedBatches: number;
  pendingBatches: number;
  tokens: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  elements: number;
  coverages: number;
  canResume: boolean;
  running?: boolean;
  configured?: boolean;
};

const STATUS_TEXT: Record<string, string> = {
  running: "正在抽取",
  succeeded: "抽取完成",
  partial: "部分批次没抽成",
  failed: "抽取失败",
  skipped: "没配置 API key，未抽取",
};

export function ExtractStatus({
  documentId,
  initial,
}: {
  documentId: number;
  initial: ExtractStatusPayload;
}) {
  const router = useRouter();
  const [state, setState] = useState<ExtractStatusPayload>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const running = state.running === true || state.status === "running";

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/documents/${documentId}/extract`, { cache: "no-store" });
    if (!response.ok) return;
    setState((await response.json()) as ExtractStatusPayload);
  }, [documentId]);

  // 只在跑的时候轮询；跑完刷新一次服务端数据，速查卡跟着更新
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      void refresh();
    }, 2500);
    const done = setTimeout(() => {
      stopped = true;
      clearInterval(timer);
      router.refresh();
    }, 300_000);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(done);
    };
  }, [running, refresh, router]);

  useEffect(() => {
    if (state.status && state.status !== "running" && !running) router.refresh();
  }, [state.finishedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(force: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const payload = (await response.json()) as { started?: boolean; error?: string };
      if (!response.ok) {
        setNote(payload.error === "no_api_key" ? "没有配置 DEEPSEEK_API_KEY。" : "没能启动抽取。");
        return;
      }
      setNote(force ? "已重新开始，之前抽好的批次会一并作废。" : "接着抽上次没完成的批次。");
      await refresh();
    } catch {
      setNote("没能启动抽取。");
    } finally {
      setBusy(false);
    }
  }

  const percent = state.batches > 0 ? Math.min(100, Math.round((state.done / state.batches) * 100)) : 0;
  const statusText = running ? STATUS_TEXT.running : (STATUS_TEXT[state.status ?? ""] ?? "还没抽过");

  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-slate-800">
          AI 抽取 · {statusText}
          {state.batches > 0 ? (
            <span className="ml-1 font-normal text-slate-500">
              第 {Math.min(state.done, state.batches)} / {state.batches} 批
            </span>
          ) : null}
        </p>
        <p className="text-xs text-slate-400">
          {state.elements} 条要素 · {state.coverages} 项责任
          {state.tokens > 0 ? ` · ${state.tokens.toLocaleString("zh-CN")} token` : ""}
        </p>
      </div>

      {state.batches > 0 ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all ${state.failedBatches > 0 && !running ? "bg-amber-400" : "bg-emerald-500"}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {state.canResume && !running ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void start(false)}
            className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {state.pendingBatches + state.failedBatches > 0
              ? `继续未完成（${state.pendingBatches + state.failedBatches} 批）`
              : "继续未完成"}
          </button>
        ) : null}

        {!running ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void start(true)}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
          >
            {state.batches > 0 ? "全部重抽" : "开始抽取"}
          </button>
        ) : null}

        {running ? <span className="text-xs text-slate-400">抽取在后台进行，可以离开这个页面，回来看进度就行。</span> : null}
        {state.error && !running ? <span className="text-xs text-amber-700">上次结束原因：{state.error}</span> : null}
        {note ? <span className="text-xs text-slate-500">{note}</span> : null}
      </div>
    </div>
  );
}
