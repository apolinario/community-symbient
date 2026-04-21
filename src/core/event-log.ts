/**
 * Event Log — append-only JSONL stream of structured events.
 *
 * Events are the machine-readable counterpart to the markdown daily logs.
 * They back "recent X" queries: recent broadcasts, recent tool calls,
 * recent sauna readings, recent chat messages, etc. The context provider
 * system (src/core/context-providers.ts) uses this as its query engine.
 *
 * Storage layout: `workspace/logs/YYYY-MM-DD.jsonl`, one event per line.
 * Each line is valid JSON with at minimum `{ts, type, ...}`. Types and
 * fields are open — conventions emerge per event type. Adding a new event
 * type requires no schema changes; a new context provider can query it
 * the same day.
 *
 * Design notes:
 *   - Writes are fire-and-forget (errors logged, not thrown) so that
 *     instrumentation never breaks the calling code.
 *   - Reads span daily files based on `days` filter; one small buffered
 *     scan per day is fine for the Feÿ volume.
 *   - The markdown logs stay as the human-facing record. This layer is
 *     purely for structured queries.
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("event-log");

export interface Event {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export interface QueryFilter {
  /** One type or an array of types (OR match). */
  type?: string | string[];
  /** Lower bound (inclusive), epoch ms. */
  since?: number;
  /** Upper bound (inclusive), epoch ms. */
  until?: number;
  /** Return the last N matching events (after filter, before format). */
  count?: number;
  /** How many days back to scan. Default 1 (today only). */
  days?: number;
  /** Field equality match, e.g. {chat: "group", direction: "in"}. */
  where?: Record<string, unknown>;
  /** Substring match on a string field. */
  contains?: { field: string; substr: string };
}

let workspacePath: string | null = null;

/**
 * Called once at startup by src/index.ts so the event log knows where
 * to write. Without this, recordEvent is a no-op and queryEvents returns [].
 */
export function setEventLogWorkspace(path: string): void {
  workspacePath = path;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function pathForDay(day: string): string {
  if (!workspacePath) throw new Error("Event log workspace not set");
  return join(workspacePath, "logs", `${day}.jsonl`);
}

/**
 * Append an event to today's log. Assigns `ts` if missing. Fire-and-forget:
 * failures log a warning but never throw.
 */
export async function recordEvent(event: Partial<Event> & { type: string }): Promise<void> {
  if (!workspacePath) return;
  try {
    const evt: Event = { ts: event.ts ?? Date.now(), ...event } as Event;
    const path = pathForDay(dayKey(evt.ts));
    if (!existsSync(dirname(path))) {
      await mkdir(dirname(path), { recursive: true });
    }
    await appendFile(path, JSON.stringify(evt) + "\n", "utf-8");
  } catch (err) {
    log.warn(`recordEvent failed: ${err}`);
  }
}

async function readDay(day: string): Promise<Event[]> {
  try {
    const content = await readFile(pathForDay(day), "utf-8");
    const events: Event[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed line — don't abort the whole scan
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Query events matching the filter. Scans at most `days` daily files
 * (newest first) and returns events in chronological order (oldest first).
 * If `count` is given, returns only the last N matches.
 */
export async function queryEvents(filter: QueryFilter = {}): Promise<Event[]> {
  if (!workspacePath) return [];

  const days = filter.days ?? 1;
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  // Collect events from each day, newest day first — so we can stop early
  // once we have enough for `count`.
  const typeFilter = filter.type
    ? (Array.isArray(filter.type) ? new Set(filter.type) : new Set([filter.type]))
    : null;

  const allMatched: Event[] = [];
  for (let d = 0; d < days; d++) {
    const dayTs = now - d * oneDay;
    const events = await readDay(dayKey(dayTs));

    // Iterate newest-first within the day; push matches into allMatched
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (typeFilter && !typeFilter.has(evt.type)) continue;
      if (filter.since !== undefined && evt.ts < filter.since) continue;
      if (filter.until !== undefined && evt.ts > filter.until) continue;
      if (filter.where) {
        let skip = false;
        for (const [k, v] of Object.entries(filter.where)) {
          if (evt[k] !== v) { skip = true; break; }
        }
        if (skip) continue;
      }
      if (filter.contains) {
        const field = evt[filter.contains.field];
        if (typeof field !== "string" || !field.includes(filter.contains.substr)) continue;
      }
      allMatched.push(evt);
      if (filter.count !== undefined && allMatched.length >= filter.count) {
        // Newest-first order; return them in chronological order.
        return allMatched.reverse();
      }
    }
  }

  // Collected newest-first; reverse to chronological.
  return allMatched.reverse();
}
