/**
 * 后台抽取：上传后立刻返回，抽取在进程里接着跑，页面轮询进度。
 *
 * 为什么不在请求里等：一份 120 页的重疾险要抽一两分钟，浏览器等着既看不到进度，
 * 断掉了这一次的 token 也白花了。改成后台跑 + 分批落盘之后，刷新页面能接着看，
 * 中断后点「继续」只补没抽成功的批次。
 */

import { extractPolicyElements, type ExtractSummary } from "./ai/extract";

const holder = globalThis as unknown as { __safecareExtractJobs?: Map<number, Promise<unknown>> };

function jobs(): Map<number, Promise<unknown>> {
  if (!holder.__safecareExtractJobs) holder.__safecareExtractJobs = new Map();
  return holder.__safecareExtractJobs;
}

export function extractionRunning(documentId: number): boolean {
  return jobs().has(documentId);
}

/**
 * 起一次抽取。已经在跑就不再起第二个，返回 false。
 * 返回的 Promise 只在测试里等用，接口层不 await。
 */
export function startExtraction(documentId: number, options: { force?: boolean } = {}): boolean {
  if (jobs().has(documentId)) return false;

  const job: Promise<ExtractSummary | null> = extractPolicyElements(documentId, options)
    .catch((cause) => {
      // 失败已经写进 extraction_run 和 extract_batch，这里只留一行日志
      console.error(`[extract] document ${documentId} failed:`, cause instanceof Error ? cause.message : cause);
      return null;
    })
    .finally(() => {
      jobs().delete(documentId);
    });

  jobs().set(documentId, job);
  return true;
}

export type { ExtractSummary };
