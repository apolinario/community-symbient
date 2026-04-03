/**
 * Temporal Rewrite — uses a tiny LLM (1.2B) to rewrite stale context entries
 * into past tense so the main model doesn't confuse past with present.
 *
 * Each entry is rewritten individually for reliability.
 * Falls back to simple prefix if the tiny model is unavailable.
 */

const REWRITE_MODEL = "liquid/lfm2.5-1.2b";
const LM_STUDIO_URL = process.env.LLM_BASE_URL || "http://localhost:1234";

const SYSTEM_PROMPT = `Rewrite into past tense. Keep the (datetime) prefix. Output ONLY the rewritten line.

Examples:
(yesterday 08:00) Yoga class at 8 AM on the terrace → (yesterday 08:00) Yoga class was held on the terrace
(4h ago, 09:00) Want: find out who is cooking tonight → (4h ago, 09:00) Wanted to find out who was cooking that night
(yesterday 20:00) DJ set starting in the caves → (yesterday 20:00) DJ set took place in the caves`;

interface StaleEntry {
  text: string;
  datetime: string;   // e.g. "2026-03-31 14:30"
  relativeAge: string; // e.g. "yesterday", "3h ago"
}

/**
 * Rewrite stale entries into past tense using tiny LLM.
 * Processes entries in parallel for speed.
 * Falls back to code-based prefix on failure.
 */
export async function rewriteStaleEntries(entries: StaleEntry[]): Promise<string[]> {
  if (entries.length === 0) return [];

  const results = await Promise.all(
    entries.map((entry) => rewriteSingle(entry)),
  );
  return results;
}

async function rewriteSingle(entry: StaleEntry): Promise<string> {
  const cleanText = stripMarkdown(entry.text);
  const prefixed = `(${entry.relativeAge}, ${entry.datetime}) ${cleanText}`;

  try {
    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: REWRITE_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prefixed },
        ],
        temperature: 0.1,
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return fallback(entry);

    const data = await res.json() as any;
    const rewritten = data.choices?.[0]?.message?.content?.trim();
    if (!rewritten || rewritten.length < 10) return fallback(entry);

    return rewritten;
  } catch {
    return fallback(entry);
  }
}

/** Strip markdown from season entry text */
function stripMarkdown(text: string): string {
  return text
    .replace(/^\*\s+\*\*\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2})?:\*\*\s*/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** Deterministic fallback: simple prefix with datetime + relative age */
function fallback(entry: StaleEntry): string {
  return `(${entry.relativeAge}, ${entry.datetime}) ${stripMarkdown(entry.text)}`;
}

/**
 * Helper: compute relative age and datetime from a Date object.
 */
export function computeAge(date: Date): { datetime: string; relativeAge: string } {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  const datetime = `${date.toISOString().slice(0, 10)} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

  const isToday = date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const isYesterday = diffDays === 1 || (!isToday && diffDays === 0 && date.getDate() !== now.getDate());

  let relativeAge: string;
  if (isToday) {
    relativeAge = diffHours < 1 ? "just now" : `${diffHours}h ago`;
  } else if (isYesterday) {
    relativeAge = "yesterday";
  } else {
    relativeAge = `${diffDays} days ago`;
  }

  return { datetime, relativeAge };
}

/** Check if an entry is stale (older than threshold) */
export function isStale(date: Date, thresholdMinutes = 60): boolean {
  return (Date.now() - date.getTime()) > thresholdMinutes * 60 * 1000;
}
