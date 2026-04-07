/**
 * Parse flexible time expressions into absolute timestamps.
 *
 * Uses the tiny 1.2B LLM for natural language, falls back to heuristics.
 * Supports: ISO datetime, relative times, natural language ("next friday afternoon")
 */

import { tinyComplete } from "./tiny-llm.js";

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse a time expression into an absolute timestamp (ms since epoch).
 * Tries heuristic parsing first (fast), then LLM for natural language (slow).
 */
export async function parseTime(input: string): Promise<number | null> {
  // Try heuristic first (instant, no LLM)
  const heuristic = parseHeuristic(input);
  if (heuristic) return heuristic;

  // Try LLM for natural language
  const llmResult = await parseLLM(input);
  if (llmResult) return llmResult;

  return null;
}

/** Fast heuristic parser for common formats */
function parseHeuristic(input: string): number | null {
  const s = input.trim().toLowerCase();
  const now = new Date();

  // ISO datetime: 2026-04-09T08:00:00 or 2026-04-09 08:00
  if (s.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/)) {
    const d = new Date(s.replace(" ", "T"));
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // Relative: "in 5m", "in 2h", "in 3d", "in 1w"
  const relMatch = s.match(/^in\s+(\d+)\s*(m|min|h|hour|d|day|w|week)/i);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2][0];
    const ms = unit === "m" ? n * 60000 : unit === "h" ? n * 3600000 : unit === "d" ? n * 86400000 : n * 604800000;
    return Date.now() + ms;
  }

  // "at HH:MM" (today, or tomorrow if past)
  const atMatch = s.match(/^at\s+(\d{1,2}):(\d{2})$/);
  if (atMatch) {
    const target = new Date(now);
    target.setHours(parseInt(atMatch[1]), parseInt(atMatch[2]), 0, 0);
    if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  // "tomorrow HH:MM" or "tomorrow at HH:MM"
  const tomorrowMatch = s.match(/^tomorrow\s+(?:at\s+)?(\d{1,2}):(\d{2})$/);
  if (tomorrowMatch) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(parseInt(tomorrowMatch[1]), parseInt(tomorrowMatch[2]), 0, 0);
    return target.getTime();
  }

  // "next monday HH:MM" etc.
  const dayMatch = s.match(/^next\s+(\w+)\s+(?:at\s+)?(\d{1,2}):(\d{2})$/);
  if (dayMatch) {
    const dayIdx = DAY_NAMES.indexOf(dayMatch[1]);
    if (dayIdx >= 0) {
      const target = new Date(now);
      const daysAhead = ((dayIdx - now.getDay() + 7) % 7) || 7;
      target.setDate(target.getDate() + daysAhead);
      target.setHours(parseInt(dayMatch[2]), parseInt(dayMatch[3]), 0, 0);
      return target.getTime();
    }
  }

  // "YYYY-MM-DD HH:MM" without T
  const dateTimeMatch = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
  if (dateTimeMatch) {
    const d = new Date(`${dateTimeMatch[1]}T${dateTimeMatch[2]}:${dateTimeMatch[3]}:00`);
    if (!isNaN(d.getTime())) return d.getTime();
  }

  return null;
}

/** LLM-assisted parsing for natural language times */
async function parseLLM(input: string): Promise<number | null> {
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 16);
  const dayName = DAY_NAMES[now.getDay()];

  const systemPrompt = `Convert the time expression to ISO datetime format (YYYY-MM-DDTHH:MM). Current time: ${nowStr} (${dayName}). Output ONLY the datetime, nothing else.

Examples:
"next friday afternoon" → 2026-04-10T15:00
"this evening" → ${now.toISOString().slice(0, 10)}T20:00
"day after tomorrow morning" → ${new Date(Date.now() + 172800000).toISOString().slice(0, 10)}T09:00
"april 9th at 8am" → 2026-04-09T08:00`;

  try {
    const output = await tinyComplete({
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
      maxTokens: 30,
      timeoutMs: 3000,
    });
    if (!output) return null;

    const match = output.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    if (match) {
      const d = new Date(match[0]);
      if (!isNaN(d.getTime())) return d.getTime();
    }

    return null;
  } catch {
    return null;
  }
}
