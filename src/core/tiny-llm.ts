/**
 * Tiny LLM — single place for all "fast, cheap" model calls
 * (temporal rewrites, time parsing, image descriptions).
 *
 * Deployments can optionally configure a separate smaller/faster model
 * (config.llm.tinyModel + config.llm.tinyBaseUrl). If not set, the main
 * LLM is used — same provider, same endpoint.
 */

let _model = "";
let _baseUrl = "";

/** Call once at startup. Both fields required. */
export function configureTinyLLM(baseUrl: string, model: string): void {
  _baseUrl = baseUrl;
  _model = model;
}

/** @deprecated Renamed to configureTinyLLM for verb consistency with the
 *  other configure*() startup wirings. */
export const initTinyLLM = configureTinyLLM;

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
