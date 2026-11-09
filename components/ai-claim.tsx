"use client";

import { useState } from "react";
import type { ClaimRequest } from "@/lib/claim-request";

type Citation = { clauseNo: string; page: number | null; quote: string; verified: boolean };

type Analysis = {
  verdict: "covered" | "partly" | "not_covered" | "uncertain";
  payable: number | null;
  reasoning: string[];
  conditions: string[];
  citations: Citation[];
  payableInReasoning: number | null;
  rejected: number;
  tokens: number;
  model: string;
};

const VERDICT: Record<Analysis["verdict"], { label: string; className: string }> = {
  covered: { label: "可以赔", className: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  partly: { label: "部分可赔", className: "bg-amber-50 text-amber-800 border-amber-200" },
  not_covered: { label: "不赔", className: "bg-rose-50 text-rose-800 border-rose-200" },
  uncertain: { label: "条款不足以判断", className: "bg-slate-100 text-slate-700 border-slate-200" },
};

const ERROR_TEXT: Record<string, string> = {
  missing_api_key: "没有配置 DEEPSEEK_API_KEY，AI 分析不可用；上面的条款计算不受影响。",
  redaction_leak: "脱敏出口校验没通过，这批内容没有发出去。",
  bad_response: "模型返回的内容不是预期的 JSON，这次没有结论。",
  upstream: "调用模型失败（超时或服务不可用），可以稍后再试。",
  no_benefit: "这份文档里没识别到可分析的责任。",
};

function money(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function AiClaim({
  documentId,
  request,
  deterministicPayable,
  configured,
}: {
  documentId: number;
  request: ClaimRequest;
  deterministicPayable: number;
  configured: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/estimate/ai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        analysis?: Analysis;
        error?: string;
      };
      if (!response.ok || !payload.analysis) {
        setError(payload.error ?? "upstream");
        setStatus("error");
        return;
      }
      setAnalysis(payload.analysis);
      setStatus("done");
    } catch {
      setError("upstream");
      setStatus("error");
    }
  }

  const diff =
    analysis && analysis.payable !== null ? Math.round((analysis.payable - deterministicPayable) * 100) / 100 : null;

  return (
    <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">AI 独立分析</h2>
        <span className="text-xs text-slate-500">同样的情况交给模型重读一遍条款，用来和上面的条款计算对照</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        只发送条款原文和这次的费用情况（不含姓名、证件号、保单号），模型给的每条依据都要能在原文里反查到。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={!configured || status === "loading"}
          className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {status === "loading" ? "AI 正在读条款…" : "让 AI 再判一次"}
        </button>
        {!configured ? (
          <span className="text-xs text-slate-500">未配置 DEEPSEEK_API_KEY</span>
        ) : status === "loading" ? (
          <span className="text-xs text-slate-500">大约 10–25 秒</span>
        ) : null}
      </div>

      {status === "error" ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {ERROR_TEXT[error ?? "upstream"] ?? "AI 分析失败，上面的条款计算不受影响。"}
        </p>
      ) : null}

      {analysis ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${VERDICT[analysis.verdict].className}`}
            >
              {VERDICT[analysis.verdict].label}
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight text-slate-900">
              {analysis.payable === null ? "未给出金额" : `¥ ${money(analysis.payable)}`}
            </span>
            {diff !== null && diff !== 0 ? (
              <span className="rounded bg-white px-2 py-0.5 text-xs text-slate-600">
                与条款计算相差 {diff > 0 ? "+" : "−"}¥ {money(Math.abs(diff))}
              </span>
            ) : diff === 0 ? (
              <span className="rounded bg-white px-2 py-0.5 text-xs text-slate-600">与条款计算一致</span>
            ) : null}
          </div>

          {analysis.payableInReasoning !== null ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              模型给的金额和它自己的推理不一致：推理最后算出 ¥ {money(analysis.payableInReasoning)}，它却填了
              ¥ {money(analysis.payable ?? 0)}。以推理过程为准核对，上面的条款计算不受影响。
            </p>
          ) : null}

          {analysis.reasoning.length > 0 ? (
            <ul className="space-y-1 text-xs text-slate-700">
              {analysis.reasoning.map((item, index) => (
                <li key={`${item}-${index}`}>· {item}</li>
              ))}
            </ul>
          ) : null}

          {analysis.conditions.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {analysis.conditions.map((item, index) => (
                <span
                  key={`${item}-${index}`}
                  className="rounded bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200"
                >
                  {item}
                </span>
              ))}
            </div>
          ) : null}

          {analysis.citations.length > 0 ? (
            <ul className="space-y-1.5">
              {analysis.citations.map((citation, index) => (
                <li key={`${citation.clauseNo}-${index}`} className="text-xs text-slate-600">
                  <span className="font-medium text-slate-800">{citation.clauseNo}</span>
                  {citation.page === null ? null : (
                    <a
                      href={`/documents/${documentId}?p=${citation.page}#doc`}
                      className="ml-1 text-sky-700 underline decoration-dotted underline-offset-2"
                    >
                      P{citation.page}
                    </a>
                  )}
                  <p className="mt-0.5 line-clamp-2 text-slate-500">「{citation.quote}」</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-amber-700">模型没给出能反查原文的依据，这条结论不采信。</p>
          )}

          <p className="border-t border-violet-200 pt-2 text-xs text-slate-400">
            {analysis.model}
            {analysis.tokens > 0 ? ` · ${analysis.tokens.toLocaleString("zh-CN")} tokens` : ""}
            {analysis.rejected > 0 ? ` · 丢弃 ${analysis.rejected} 条反查不过的引文` : ""}
            {" · AI 分析只作参考，不构成理赔结论"}
          </p>
        </div>
      ) : null}
    </section>
  );
}
