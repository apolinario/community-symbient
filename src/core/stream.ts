/**
 * The stream — the symbient's shared state: one append-only file of short
 * natural-language entries, each with a dotted category (see docs/stream.md).
 * Modules reach it only through the mediator in agent-module, which filters
 * by the categories they declare.
 */

import { appendFile, open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("stream");

export interface StreamEntry {
  ts: number;
  category: string;
  author: string;
  text: string;
  /** Heard only by modules cleared for private entries. */
  private?: boolean;
  [key: string]: unknown;
}

let streamPath: string | null = null;
// Entries in these categories are private wherever they come from.
let privateCategories = ["perception.chat.dm", "effector.said.dm"];

export function setPrivateCategories(categories: string[]): void {
  privateCategories = categories;
}

export function setStreamWorkspace(workspacePath: string): void {
  streamPath = join(workspacePath, "stream.jsonl");
}

/** `perception.chat` matches `perception.chat` and everything below it. */
export function inCategories(category: string, filters: string[]): boolean {
  return filters.some((f) => category === f || category.startsWith(`${f}.`));
}

/** Append an entry. Fire-and-forget: failures are logged, never thrown. */
export async function appendStream(entry: { category: string; author: string; text: string; ts?: number; [key: string]: unknown }): Promise<void> {
  if (!streamPath || !entry.category || !entry.text?.trim()) return;
  try {
    await mkdir(join(streamPath, ".."), { recursive: true });
    const isPrivate = entry.private === true || inCategories(entry.category, privateCategories);
    await appendFile(streamPath, JSON.stringify({ ts: Date.now(), ...entry, text: entry.text.trim(), private: isPrivate || undefined }) + "\n", "utf-8");
  } catch (err) {
    log.warn(`append failed: ${(err as Error).message}`);
  }
}

// Recent entries live at the end of the file; reading a bounded tail keeps a
// long-lived stream cheap to query.
const TAIL_BYTES = 4 * 1024 * 1024;

async function readTail(): Promise<StreamEntry[]> {
  if (!streamPath) return [];
  let handle;
  try {
    handle = await open(streamPath, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    if (start > 0) lines.shift();
    const out: StreamEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } finally {
    await handle.close();
  }
}

export interface StreamQuery {
  categories?: string[];
  since?: number;
  /** Private entries are left out unless asked for. */
  includePrivate?: boolean;
  /** The most recent N matching entries. */
  limit?: number;
}

export async function readStream(q: StreamQuery = {}): Promise<StreamEntry[]> {
  const entries = (await readTail()).filter((e) =>
    (q.includePrivate || !e.private) &&
    (!q.categories || inCategories(e.category, q.categories)) && (!q.since || e.ts >= q.since));
  return q.limit ? entries.slice(-q.limit) : entries;
}

export function renderStream(entries: StreamEntry[]): string {
  const today = new Date().toDateString();
  return entries.map((e) => {
    const at = new Date(e.ts);
    const when = at.toDateString() === today
      ? at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return `[${when}] ${e.category} · ${e.author}: ${e.text}`;
  }).join("\n");
}
