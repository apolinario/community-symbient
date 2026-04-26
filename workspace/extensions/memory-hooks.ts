/**
 * Feÿ deployment — memory append hooks.
 *
 * Each new entry in the daily log triggers an LLM-generated summary so
 * older days have a single-paragraph recap alongside the full transcript.
 * The autobiographical and conversation modules pull the recent summaries
 * via the `recent-days` provider (cheaper than re-reading every day's
 * raw log).
 *
 * This is a deployment choice, not a framework concern. A symbient that
 * doesn't want summaries simply doesn't register this hook.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoryManager } from "../../src/memory/manager.js";
import type { LLMClient } from "../../src/core/extensions-api.js";

const SUMMARY_SYSTEM_PROMPT =
  "Summarize this day's log into one short paragraph (3-5 sentences). " +
  "Be factual: who talked, what happened, key events. No editorializing. " +
  "Output ONLY the summary paragraph, nothing else.";

const TRUNCATE_THRESHOLD = 6000;
const TRUNCATE_HEAD = 3000;
const TRUNCATE_TAIL = 3000;
const MIN_LOG_LENGTH = 100;

function dailyLogPath(workspacePath: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return join(workspacePath, "memory", `${yyyy}-${mm}-${dd}.md`);
}

function dailySummaryPath(workspacePath: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return join(workspacePath, "memory", `${yyyy}-${mm}-${dd}.summary.md`);
}

/**
 * Coalesce rapid-fire summary requests per-date so we don't hammer the
 * LLM when many log lines land in the same minute. The latest call wins.
 */
const pending = new Map<string, NodeJS.Timeout>();
const COALESCE_MS = 2000;

export function attachDailySummarizer(memory: MemoryManager, llm: LLMClient): void {
  const workspacePath = memory.getWorkspacePath();

  memory.onAppend((_entry, date) => {
    const key = date.toISOString().slice(0, 10);
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      pending.delete(key);
      summarizeDay(workspacePath, date, llm).catch((err) =>
        console.warn("[memory-hooks] summarize failed:", (err as Error)?.message || err),
      );
    }, COALESCE_MS);
    pending.set(key, handle);
  });
}

async function summarizeDay(workspacePath: string, date: Date, llm: LLMClient): Promise<void> {
  const logPath = dailyLogPath(workspacePath, date);
  let log: string;
  try {
    log = await readFile(logPath, "utf-8");
  } catch {
    return;
  }
  if (log.length < MIN_LOG_LENGTH) return;

  const truncated = log.length > TRUNCATE_THRESHOLD
    ? log.slice(0, TRUNCATE_HEAD) + "\n...\n" + log.slice(-TRUNCATE_TAIL)
    : log;

  const summary = await llm.complete({
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: truncated }],
    temperature: 0.3,
    maxTokens: 1000,
  });

  if (!summary.trim()) return;

  const summaryPath = dailySummaryPath(workspacePath, date);
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, summary.trim(), "utf-8");
}
