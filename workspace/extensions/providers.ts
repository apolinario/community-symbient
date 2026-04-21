/**
 * Feÿ-deployment context providers.
 *
 * Each provider is a `ContextProvider` with `execute(decl, ctx) => string`.
 * Modules reference them in their `.md` frontmatter as
 * `context: [{source: <name>, ...params}]`. Framework has built-in
 * providers (events, current-time, most-played-songs, upcoming-scheduled,
 * active-threads); these below are Feÿ-specific (house-status, sauna,
 * season-today, current-meal, recent-broadcasts, recent-days,
 * daily-summary, inner-mood, recent-dms, recent-group-chat, active-states).
 *
 * Another community writes their own providers.js with their own blocks.
 */

import type { ContextProvider } from "../../src/core/context-providers.js";
import type { ModuleContext } from "../../src/core/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { symbientDisplayName } from "../../src/core/symbient-name.js";
import { annotateContextLines } from "../../src/memory/time-annotate.js";
import type { FeyOpsDB } from "../services/feyops/db.js";

// Holds runtime refs needed by the providers. Populated by workspace/
// extensions/modules.ts at startup when the FeyOps adapter resolves.
let feyopsDb: FeyOpsDB | null = null;
export function configureFeyProviders(deps: { feyopsDb?: FeyOpsDB }): void {
  feyopsDb = deps.feyopsDb ?? null;
}

// --- Helpers ---

function isPlaceholder(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden");
}

async function safeRead(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}

function dailyLogPath(wsPath: string, date: Date): string {
  return join(wsPath, "memory", `${date.toISOString().slice(0, 10)}.md`);
}

// --- Providers ---

const houseStatusProvider: ContextProvider = {
  async execute() {
    if (!feyopsDb) return null;
    const today = new Date().toISOString().slice(0, 10);
    const activity = feyopsDb.getTodayActivity(today);
    const all = feyopsDb.getBookings();
    const real = all.filter((b) => !isPlaceholder(b.guest));
    const current = real.filter((b) => b.checkin <= today && b.checkout > today);
    const guestNames = [...new Set(current.map((b) => b.guest))];
    const occupiedRooms = [...new Set(current.map((b) => b.room))];
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const tomorrowArrivals = real.filter((b) => b.checkin === tomorrow);
    const realArrivals = activity.arrivals.filter((b) => !isPlaceholder(b.guest));
    const realDepartures = activity.departures.filter((b) => !isPlaceholder(b.guest));
    const lines = [
      `Today: ${guestNames.length} guests in ${occupiedRooms.length} rooms`,
      realArrivals.length > 0
        ? `Arriving today: ${realArrivals.map((b) => b.guest).join(", ")}`
        : `No arrivals today`,
      realDepartures.length > 0
        ? `Departing today: ${realDepartures.map((b) => b.guest).join(", ")}`
        : `No departures today`,
    ];
    if (tomorrowArrivals.length > 0) {
      lines.push(`Arriving tomorrow: ${tomorrowArrivals.map((b) => b.guest).join(", ")}`);
    }
    return lines.join("\n");
  },
};

const saunaProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const SPREADSHEET_ID = "1nQioINK2QYU3MymE5u04F5K0GBASeOIC96TA4UtiQL4";
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&tq=${encodeURIComponent("order by A desc limit 1")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const raw = await res.text();
        const jsonStr = raw.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
        const data = JSON.parse(jsonStr);
        const temp = data.table.rows[0]?.c[1]?.v;
        if (typeof temp === "number") {
          const log = await safeRead(dailyLogPath(workspacePathOf(ctx), new Date()));
          const readings = log?.match(/\*\[Sauna\]\*.*?(\d+\.?\d*)°C/g);
          let trend = "";
          if (readings && readings.length > 0) {
            const prev = parseFloat(readings[readings.length - 1].match(/(\d+\.?\d*)°C/)?.[1] || "0");
            if (temp > prev + 2) trend = " and heating up";
            else if (temp < prev - 2) trend = " and cooling down";
            else trend = " and holding steady";
          }
          return `Sauna: ${temp}°C${trend} (live)`;
        }
      }
    } catch {}
    const log = await safeRead(dailyLogPath(workspacePathOf(ctx), new Date()));
    const readings = log?.match(/\*\[Sauna\]\*.*$/gm);
    if (!readings || readings.length === 0) return null;
    const latest = readings[readings.length - 1].replace("*[Sauna]* ", "");
    return `Sauna: ${latest}`;
  },
};

const seasonTodayProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const ws = workspacePathOf(ctx);
    const { rewriteStaleEntries } = await import("../../src/core/temporal-rewrite.js");
    const categories = ["meals", "events", "parties", "crispy"];
    const now = new Date();
    const nowHour = now.getHours();
    const todayISO = now.toISOString().slice(0, 10);
    const yesterdayISO = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const parts: string[] = [];
    for (const cat of categories) {
      const content = await safeRead(join(ws, "season", `${cat}.md`));
      if (!content) continue;
      const fresh: string[] = [];
      const stale: Array<{ text: string; datetime: string; relativeAge: string }> = [];
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (t.includes(todayISO)) {
          const tm = t.match(/\*\*\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2}):\*\*/);
          if (tm) {
            const hoursAgo = nowHour - parseInt(tm[1]);
            if (hoursAgo > 2) {
              stale.push({ text: t, datetime: `${todayISO} ${tm[1]}:${tm[2]}`, relativeAge: `${hoursAgo}h ago` });
              continue;
            }
          }
          fresh.push(t);
        } else if (t.includes(yesterdayISO)) {
          const tm = t.match(/\*\*\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2}):\*\*/);
          const time = tm ? `${tm[1]}:${tm[2]}` : "00:00";
          stale.push({ text: t, datetime: `${yesterdayISO} ${time}`, relativeAge: "yesterday" });
        }
      }
      const rewritten = stale.length > 0 ? await rewriteStaleEntries(stale) : [];
      if (fresh.length > 0 || rewritten.length > 0) {
        let block = `<${cat}>\n`;
        if (fresh.length > 0) block += `Now/recent:\n${fresh.join("\n")}\n`;
        if (rewritten.length > 0) block += `Earlier:\n${rewritten.join("\n")}\n`;
        block += `</${cat}>`;
        parts.push(block);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  },
};

const currentMealProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    let mealType: string | null = null;
    if (mins >= 510 && mins <= 690) mealType = "breakfast";
    else if (mins >= 750 && mins <= 900) mealType = "lunch";
    else if (mins >= 1140 && mins <= 1320) mealType = "dinner";
    if (!mealType) return null;
    const content = await safeRead(join(workspacePathOf(ctx), "season", "meals.md"));
    if (!content) return null;
    const todayISO = now.toISOString().slice(0, 10);
    const todayLines = content.split("\n").filter((l) => l.includes(todayISO));
    if (todayLines.length === 0) return null;
    const mealLine = todayLines.find((l) => l.toLowerCase().includes(mealType!));
    if (mealLine) return `It's ${mealType} time. Today's ${mealType}: ${mealLine.trim()}`;
    return `It's ${mealType} time. Today's meals: ${todayLines.map((l) => l.trim()).join("; ")}`;
  },
};

const recentBroadcastsProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 2;
    const radioLog = await safeRead(join(workspacePathOf(ctx), "radio", "log.md"));
    if (!radioLog) return null;
    const broadcasts: string[] = [];
    for (const section of radioLog.split("\n## ")) {
      const timeMatch = section.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      const msg = section.match(/\*\*Broadcast:\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/);
      if (timeMatch && msg) broadcasts.push(`[${timeMatch[1]}] ${msg[1].trim()}`);
    }
    if (broadcasts.length === 0) return null;
    return (await annotateContextLines(broadcasts.slice(-count))).join("\n");
  },
};

const innerMoodProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const ws = workspacePathOf(ctx);
    const sources = [
      { path: "inner/current-state.md", label: "Reflecting on", maxChars: 200 },
      { path: "inner/current-desire.md", label: "Want", maxChars: 0 },
      { path: "inner/current-magi.md", label: "Inner voices", maxChars: 200 },
    ];
    const parts: string[] = [];
    for (const s of sources) {
      const content = await safeRead(join(ws, s.path));
      if (!content) continue;
      const trimmed = s.maxChars > 0 ? content.slice(-s.maxChars).trim() : content.trim();
      if (trimmed) parts.push(`${s.label}: ${trimmed}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  },
};

const recentDmsProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 10;
    const todayLog = await safeRead(dailyLogPath(workspacePathOf(ctx), new Date()));
    if (!todayLog) return null;
    const self = symbientDisplayName();
    const dmPattern = /^\*\*([^*]+)\*\*\s*\(dm(?:\s+to\s+([^)]+))?\):\s*(.+)/gm;
    const entries: Array<{ time: string; from: string; to: string; snippet: string }> = [];
    const sections = todayLog.split(/^## (\d{2}:\d{2}:\d{2})/m);
    let currentTime = "";
    for (const section of sections) {
      const t = section.match(/^(\d{2}:\d{2}:\d{2})$/);
      if (t) { currentTime = t[1]; continue; }
      let m;
      dmPattern.lastIndex = 0;
      while ((m = dmPattern.exec(section)) !== null) {
        const name = m[1];
        const toName = m[2] || "";
        const snippet = m[3].replace(/\n/g, " ");
        if (name === self) entries.push({ time: currentTime, from: self, to: toName, snippet });
        else entries.push({ time: currentTime, from: name, to: self, snippet });
      }
    }
    const incoming = entries.filter((e) => e.from !== self).slice(-count);
    if (incoming.length === 0) return null;
    const lines = incoming.map((e) => `[${e.time.slice(0, 5)}] ${e.from}: ${e.snippet}`);
    return (await annotateContextLines(lines)).join("\n");
  },
};

const recentGroupChatProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 18;
    const log = await safeRead(dailyLogPath(workspacePathOf(ctx), new Date()));
    if (!log) return null;
    const groupMessages: string[] = [];
    const parts = log.split(/^(## \d{2}:\d{2}:\d{2})/m);
    let currentTime = "";
    for (const part of parts) {
      const t = part.match(/^## (\d{2}:\d{2}:\d{2})$/);
      if (t) { currentTime = t[1].slice(0, 5); continue; }
      const trimmed = part.trim();
      const match = trimmed.match(/^\*\*([^*]+)\*\*\s*\(([^)]*)\):\s*([\s\S]+)/);
      if (match && match[2].includes("season")) {
        groupMessages.push(`[${currentTime}] ${match[1]}: ${match[3].trim()}`);
      }
    }
    if (groupMessages.length === 0) return null;
    return (await annotateContextLines(groupMessages.slice(-count))).join("\n");
  },
};

const recentDaysProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 5;
    const parts: string[] = [];
    const today = new Date();
    for (let i = 0; i < count; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const iso = date.toISOString().slice(0, 10);
      const path = join(workspacePathOf(ctx), "memory", `${iso}.summary.md`);
      const content = await safeRead(path);
      if (content) {
        const label = iso === today.toISOString().slice(0, 10) ? `**Today (${iso})**` : `**${iso}**`;
        parts.push(`${label}:\n${content.trim()}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  },
};

const dailySummaryProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const today = new Date().toISOString().slice(0, 10);
    return await safeRead(join(workspacePathOf(ctx), "memory", `${today}.summary.md`));
  },
};

/**
 * Most-played songs — reads workspace/radio/play-history.csv (Feÿ-radio-specific).
 * CSV format: `"title",count,"last_played"` — cols[0]=title, cols[1]=count.
 */
const mostPlayedSongsProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 10;
    try {
      const content = await safeRead(join(workspacePathOf(ctx), "radio", "play-history.csv"));
      if (!content) return null;
      const entries: Array<[string, number]> = [];
      const lines = content.split("\n");
      for (let i = 1; i < lines.length; i++) {  // skip header
        const line = lines[i];
        if (!line.trim()) continue;
        const match = line.match(/^"([^"]*(?:""[^"]*)*)",(\d+),/);
        if (match) {
          entries.push([match[1].replace(/""/g, '"'), parseInt(match[2], 10)]);
        }
      }
      if (entries.length === 0) return null;
      return entries
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([title, n]) => `${title} (${n}x)`)
        .join("\n");
    } catch {
      return null;
    }
  },
};

/**
 * Active threads — reads workspace/inner/active-threads.md (Feÿ's cognitive
 * "things I'm tracking" file, maintained by the executive module).
 */
const activeThreadsProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const raw = await safeRead(join(workspacePathOf(ctx), "inner", "active-threads.md"));
    return raw?.trim() || null;
  },
};

/**
 * Pending capability gaps — unapproved requests awaiting reviewer decision.
 * Lets the conversation module know what's pending so the reviewer's
 * natural-language reply ("yeah go ahead", "skip it") can be matched to
 * the right gap via approve_capability / skip_capability tools.
 */
const pendingCapabilityGapsProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const { readdir } = await import("node:fs/promises");
    const dir = join(workspacePathOf(ctx), "state", "capability-gaps");
    let files: string[] = [];
    try { files = await readdir(dir); } catch { return null; }

    const entries: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await safeRead(join(dir, file));
      if (!raw) continue;
      try {
        const g = JSON.parse(raw);
        if (g.approved !== null || g.pr_url) continue; // pending only
        const extras = [g.example ? `example: ${g.example}` : null, g.suggested_shape ? `shape: ${g.suggested_shape}` : null].filter(Boolean).join(" | ");
        entries.push(`[${g.id}] wanted: ${g.what}\n  why: ${g.why}${extras ? "\n  " + extras : ""}`);
      } catch {}
    }
    if (entries.length === 0) return null;
    return entries.join("\n\n");
  },
};

const activeStatesProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const raw = await safeRead(join(workspacePathOf(ctx), "state", "active-states.json"));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return parsed.map((s) => {
        const ctx = s.context ? `: ${s.context}` : "";
        return `${String(s.name).toUpperCase()} ACTIVE${ctx}`;
      }).join("\n");
    } catch {
      return null;
    }
  },
};

function workspacePathOf(ctx: ModuleContext): string {
  // ctx.memory is the MemoryManager; use its workspace path via the
  // `appendLog` write pattern. Simplest: rely on process.cwd() since all
  // deployments run from project root. Falls back safely if not set.
  return join(process.cwd(), "workspace");
}

export default {
  "house-status": houseStatusProvider,
  "sauna": saunaProvider,
  "season-today": seasonTodayProvider,
  "current-meal": currentMealProvider,
  "recent-broadcasts": recentBroadcastsProvider,
  "inner-mood": innerMoodProvider,
  "recent-dms": recentDmsProvider,
  "recent-group-chat": recentGroupChatProvider,
  "recent-days": recentDaysProvider,
  "daily-summary": dailySummaryProvider,
  "active-states": activeStatesProvider,
  "most-played-songs": mostPlayedSongsProvider,
  "active-threads": activeThreadsProvider,
  "pending-capability-gaps": pendingCapabilityGapsProvider,
};
