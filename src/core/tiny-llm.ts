/**
 * Tiny LLM — single place for all calls to the small/fast model.
 *
 * Used for: temporal rewrites, time parsing, image descriptions, etc.
 * Configured via config.llm.tinyModel and config.llm.baseUrl.
 */

let _model = "LFM2.5-VL-1.6B-Q8_0";
let _baseUrl = "http://localhost:1234";

/** Call once at startup with config values. */
export function initTinyLLM(baseUrl: string, model: string) {
  _baseUrl = baseUrl;
  _model = model;
}

export function getTinyModel() { return _model; }
export function getTinyBaseUrl() { return _baseUrl; }

/** Simple chat completion with the tiny model. */
export async function tinyComplete(opts: {
  system?: string;
  messages: Array<{ role: string; content: any }>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  const messages = opts.system
    ? [{ role: "system", content: opts.system }, ...opts.messages]
    : opts.messages;

  try {
    const res = await fetch(`${_baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: _model,
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 100,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}
