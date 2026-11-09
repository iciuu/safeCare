/**
 * DeepSeek 适配层（OpenAI 兼容）。
 *
 * 只做三件事：带超时的 POST、拿 JSON、报 token 用量。
 * 业务规则（脱敏、引文校验、合并）都不在这里，方便以后换模型。
 */

export type ChatMessage = { role: "system" | "user"; content: string };

export type DeepSeekResult = { data: unknown; tokens: number };

export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

export function deepseekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

export class DeepSeekError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function deepseekJson(
  messages: ChatMessage[],
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<DeepSeekResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new DeepSeekError("missing_api_key");

  const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const retries = options.retries ?? 1;
  let attempt = 0;

  for (;;) {
    try {
      return await once(base, apiKey, messages, options.timeoutMs ?? 25_000);
    } catch (cause) {
      const status = cause instanceof DeepSeekError ? cause.status : undefined;
      const retryable = status === undefined ? false : RETRYABLE.has(status);
      if (!retryable || attempt >= retries) throw cause;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
  }
}

async function once(
  base: string,
  apiKey: string,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<DeepSeekResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        temperature: 0,
        stream: false,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      // 只回报状态码，不把响应体（可能含 prompt 片段）写进日志
      throw new DeepSeekError(`http_${response.status}`, response.status);
    }

    let parsed: {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new DeepSeekError("bad_envelope");
    }

    const content = parsed.choices?.[0]?.message?.content ?? "";
    if (!content) throw new DeepSeekError("empty_content");

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new DeepSeekError("bad_json");
    }

    return { data, tokens: parsed.usage?.total_tokens ?? 0 };
  } catch (cause) {
    if (cause instanceof DeepSeekError) throw cause;
    if (cause instanceof Error && cause.name === "AbortError") throw new DeepSeekError("timeout");
    throw new DeepSeekError(cause instanceof Error ? cause.message : "network_error");
  } finally {
    clearTimeout(timer);
  }
}
