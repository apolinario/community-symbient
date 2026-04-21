/**
 * Context Providers — declarative seed-prompt blocks.
 *
 * A module's frontmatter can declare a `context:` array of provider
 * invocations. Each produces an XML-tagged block that gets appended to
 * the module's seed prompt at cycle time. This replaces the hardcoded
 * switch in agent-module.ts (radio/radio-dj/executive seed builders).
 *
 * Example `workspace/modules/radio.md`:
 *
 *   context:
 *     - source: current-time
 *     - source: events
 *       type: broadcast
 *       count: 2
 *       tag: recent-broadcasts
 *       note: "Same topics ok but vary the angle"
 *       format: "[{ts:HH:mm}] {message}"
 *
 * Providers come from three registers:
 *   1. Framework built-ins (in this file): `events`, `current-time`,
 *      `most-played-songs`, `upcoming-scheduled`, `active-threads`,
 *      `house-status`.
 *   2. Workspace extensions via `workspace/extensions/providers.js`
 *      — register new `source: foo` handlers without editing core.
 *   3. (Future) MCP-backed providers.
 *
 * Extension shape: `export default { "source-name": { execute(decl, ctx) { ... } } }`
 */

import type { ModuleContext } from "./types.js";
import { queryEvents, type Event } from "./event-log.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ContextDecl {
  source: string;
  tag?: string;
  note?: string;
  [key: string]: unknown;
}

export interface ContextProvider {
  /** Returns the inner text for this block. Caller wraps it in <tag>...</tag>. Return null/"" to skip. */
  execute(decl: ContextDecl, ctx: ModuleContext): Promise<string | null>;
}

const registry = new Map<string, ContextProvider>();

export function registerProvider(name: string, provider: ContextProvider): void {
  registry.set(name, provider);
}

export function getProvider(name: string): ContextProvider | undefined {
  return registry.get(name);
}

export function listProviders(): string[] {
  return [...registry.keys()];
}

// --- Formatting helpers ---

function pad2(n: number): string { return n.toString().padStart(2, "0"); }

function formatDate(ts: number, pattern: string): string {
  const d = new Date(ts);
  return pattern
    .replace("YYYY", String(d.getFullYear()))
    .replace("MM", pad2(d.getMonth() + 1))
    .replace("DD", pad2(d.getDate()))
    .replace("HH", pad2(d.getHours()))
    .replace("mm", pad2(d.getMinutes()))
    .replace("ss", pad2(d.getSeconds()));
}

/**
 * Resolve a dotted field path against the event: `{tool}` → event.tool,
 * `{args.message}` → event.args.message. Missing fields render as "".
 */
function resolveField(evt: Event, path: string): string {
  const parts = path.split(".");
  let val: unknown = evt;
  for (const p of parts) {
    if (val === null || val === undefined) return "";
    val = (val as Record<string, unknown>)[p];
  }
  if (val === undefined || val === null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/**
 * Apply a format template to an event. Supports `{field}` (dotted paths)
 * and `{ts:HH:mm}` for date formatting. If no format given, returns JSON.
 */
function formatEvent(evt: Event, format: string | undefined): string {
  if (!format) return JSON.stringify(evt);
  return format.replace(/\{([^}]+)\}/g, (_, token: string) => {
    const [field, pattern] = token.split(":");
    if (field === "ts" && pattern) {
      return formatDate(Number(evt.ts), pattern);
    }
    return resolveField(evt, field);
  });
}

// --- Built-in providers ---

/**
 * Generic event-query provider. Handles the 90% case.
 *
 *   - source: events
 *     type: broadcast
 *     count: 2
 *     tag: recent-broadcasts
 *     format: "[{ts:HH:mm}] {message}"
 */
const eventsProvider: ContextProvider = {
  async execute(decl) {
    const events = await queryEvents({
      type: decl.type as string | string[] | undefined,
      since: decl.since as number | undefined,
      until: decl.until as number | undefined,
      count: decl.count as number | undefined,
      days: decl.days as number | undefined,
      where: decl.where as Record<string, unknown> | undefined,
      contains: decl.contains as { field: string; substr: string } | undefined,
    });
    if (events.length === 0) return null;
    const format = decl.format as string | undefined;
    return events.map((e) => formatEvent(e, format)).join("\n");
  },
};

const currentTimeProvider: ContextProvider = {
  async execute() {
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    return `${time} on ${date}`;
  },
};

/**
 * Most-played songs — requires GROUP BY + count-sort, so not a pure event query.
 * Reads the Feÿ-specific play-history CSV. In a generic deployment this belongs
 * in workspace/extensions/providers.js as a custom provider; it's here for now
 * so the radio-dj module keeps working.
 */
const mostPlayedSongsProvider: ContextProvider = {
  async execute(decl) {
    const count = (decl.count as number) ?? 10;
    try {
      const path = join(process.cwd(), "workspace", "radio", "play-history.csv");
      const content = await readFile(path, "utf-8");
      const counts = new Map<string, number>();
      for (const line of content.split("\n")) {
        const cols = line.split(",");
        const title = cols[1]?.replace(/^"|"$/g, "").trim();
        if (!title) continue;
        counts.set(title, (counts.get(title) ?? 0) + 1);
      }
      const sorted = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([title, n]) => `${title} (${n}x)`);
      return sorted.length > 0 ? sorted.join("\n") : null;
    } catch {
      return null;
    }
  },
};

/**
 * Upcoming scheduled items. Reads tasks/scheduled.json.
 */
const upcomingScheduledProvider: ContextProvider = {
  async execute(decl, ctx) {
    const windowHours = (decl.window_hours as number) ?? 24;
    try {
      const raw = await ctx.memory.readFile("tasks/scheduled.json");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const arr: Array<Record<string, any>> = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.scheduled) ? parsed.scheduled
        : Array.isArray(parsed.tasks) ? parsed.tasks
        : [];
      const cutoff = Date.now() + windowHours * 60 * 60 * 1000;
      const upcoming = arr
        .filter((e) => !e.done && e.nextRun && e.nextRun <= cutoff)
        .sort((a, b) => a.nextRun - b.nextRun)
        .map((e) => {
          const when = new Date(e.nextRun).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
          return `[${when}] ${e.prompt || e.intent || "(no prompt)"}`;
        });
      return upcoming.length > 0 ? upcoming.join("\n") : null;
    } catch {
      return null;
    }
  },
};

const activeThreadsProvider: ContextProvider = {
  async execute(_decl, ctx) {
    try {
      const raw = await ctx.memory.readFile("inner/active-threads.md");
      return raw?.trim() || null;
    } catch {
      return null;
    }
  },
};

const houseStatusProvider: ContextProvider = {
  async execute(_decl, ctx) {
    try {
      const ctxStr = await ctx.memory.assembleContext();
      const m = ctxStr.match(/<house-status>([\s\S]*?)<\/house-status>/);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  },
};

function registerBuiltInProviders(): void {
  registerProvider("events", eventsProvider);
  registerProvider("current-time", currentTimeProvider);
  registerProvider("most-played-songs", mostPlayedSongsProvider);
  registerProvider("upcoming-scheduled", upcomingScheduledProvider);
  registerProvider("active-threads", activeThreadsProvider);
  registerProvider("house-status", houseStatusProvider);
}

registerBuiltInProviders();

// --- Block assembly (called from agent-module.ts) ---

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a list of context declarations into XML-tagged blocks. Unknown
 * providers log a warning and are skipped. Null/empty provider output
 * is skipped (so a missing file doesn't produce an empty tag).
 */
export async function renderContextBlocks(
  decls: ContextDecl[],
  ctx: ModuleContext,
): Promise<string[]> {
  const blocks: string[] = [];
  for (const decl of decls) {
    const provider = registry.get(decl.source);
    if (!provider) {
      ctx.log(`Unknown context provider: ${decl.source}`);
      continue;
    }
    try {
      const inner = await provider.execute(decl, ctx);
      if (!inner) continue;
      const tag = (decl.tag as string) || decl.source;
      const noteAttr = decl.note ? ` note="${escapeAttr(decl.note as string)}"` : "";
      blocks.push(`<${tag}${noteAttr}>\n${inner}\n</${tag}>`);
    } catch (err) {
      ctx.log(`Provider ${decl.source} failed: ${err}`);
    }
  }
  return blocks;
}
