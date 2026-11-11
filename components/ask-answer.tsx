"use client";

import { useState } from "react";

type Citation = {
  ref: string;
  documentId: number;
  clauseNo: string;
  page: number;
  quote: string;
  productName: string | null;
};

type Answer = {
  question: string;
  kind: "answered" | "related-only" | "refused";
  reason:
    | "no-match"
    | "insufficient"
    | "unverified"
    | "missing-key"
    | "upstream"
    | "redaction"
    | null;
  points: string[];
  calculation: string | null;
  conditions: string[];
  missing: string[];
  citations: Citation[];
  rejected: number;
  tokens: number;
  model: string;
};

const REASON_TEXT: Record<NonNullable<Answer["reason"]>, string> = {
  "no-match": "在已入库的条款里没有检索到相关内容，这里不给结论。",
  insufficient: "模型认为检索到的条款不足以回答这个问题，只列出原文，不给结论。",
  unverified: "模型给的引文都没能在原文里逐字反查到，这条结论不采信，只列出原文。",
  "missing-key": "没有配置 DEEPSEEK_API_KEY，只能检索原文，没法让模型组织答案。",
  upstream: "调用模型失败（超时或服务不可用），原文检索不受影响。",
  redaction: "脱敏出口校验没通过，这批内容没有发出去。",
};

export function AskAnswer({ question, configured }: { question: string; configured: boolean }) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        answer?: Answer;
        error?: string;
      };
      if (!response.ok || !payload.answer) {
        setError(payload.error ?? "upstream");
        setStatus("error");
        return;
      }
      setAnswer(payload.answer);
      setStatus("done");
    } catch {
      setError("upstream");
      setStatus("error");
    }
  }

  const blocked = answer ? answer.kind !== "answered" : false;

  return (
    <section className="mt-6 rounded-xl border border-sky-200 bg-sky-50/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">AI 组织答案</h2>
        <span className="text-xs text-slate-500">只依据上面检索到的条款，不给条款以外的说法</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={!configured || status === "loading"}
          className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {status === "loading" ? "正在读条款…" : "让 AI 整理成答案"}
        </button>
        {!configured ? (
          <span className="text-xs text-slate-500">未配置 DEEPSEEK_API_KEY</span>
        ) : status === "loading" ? (
          <span className="text-xs text-slate-500">大约 10–25 秒</span>
        ) : null}
      </div>

      {status === "error" ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {REASON_TEXT[(error as Answer["reason"]) ?? "upstream"] ?? "AI 调用失败，上面的原文检索不受影响。"}
        </p>
      ) : null}

      {answer ? (
        <div className="mt-3 space-y-3">
          {blocked ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              {REASON_TEXT[answer.reason ?? "insufficient"]}
            </p>
          ) : null}

          {answer.points.length > 0 ? (
            <ul className="space-y-1 text-sm leading-6 text-slate-800">
              {answer.points.map((item, index) => (
                <li key={`${item}-${index}`}>· {item}</li>
              ))}
            </ul>
          ) : null}

          {answer.calculation ? (
            <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
              <p className="text-xs font-medium text-slate-500">计算过程</p>
              <p className="mt-0.5 text-xs leading-5 text-slate-700">{answer.calculation}</p>
            </div>
          ) : null}

          {answer.conditions.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {answer.conditions.map((item, index) => (
                <span
                  key={`${item}-${index}`}
                  className="rounded bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200"
                >
                  {item}
                </span>
              ))}
            </div>
          ) : null}

          {answer.citations.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-slate-500">依据</p>
              <ul className="mt-1 space-y-1.5">
                {answer.citations.map((citation, index) => (
                  <li key={`${citation.clauseNo}-${index}`} className="text-xs text-slate-600">
                    <a
                      href={`/documents/${citation.documentId}?p=${citation.page}&q=${encodeURIComponent(
                        citation.quote.slice(0, 60),
                      )}#doc`}
                      className="font-medium text-sky-700 underline decoration-dotted underline-offset-2"
                    >
                      {citation.clauseNo} · P{citation.page}
                    </a>
                    {citation.productName ? <span className="ml-1 text-slate-400">{citation.productName}</span> : null}
                    <p className="mt-0.5 leading-5 text-slate-500">「{citation.quote}」</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {answer.missing.length > 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-xs font-medium text-slate-500">需要你自己确认</p>
              <ul className="mt-1 space-y-0.5 text-xs leading-5 text-slate-600">
                {answer.missing.map((item, index) => (
                  <li key={`${item}-${index}`}>· {item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="border-t border-sky-200 pt-2 text-xs text-slate-400">
            {answer.model}
            {answer.tokens > 0 ? ` · ${answer.tokens.toLocaleString("zh-CN")} tokens` : ""}
            {answer.rejected > 0 ? ` · 丢弃 ${answer.rejected} 条反查不过的引文` : ""}
            {" · 只复述条款，不构成理赔结论"}
          </p>
        </div>
      ) : null}
    </section>
  );
}
