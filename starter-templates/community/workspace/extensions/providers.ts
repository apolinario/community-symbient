/**
 * Community-deployment context providers.
 *
 * Generic building blocks for a symbient with a cognitive inner life —
 * inner-mood, recent-dms, recent-group-chat, recent-days, daily-summary,
 * active-states. Nothing community-specific (no house-status, no
 * sensors, no broadcasts — those live in individual community
 * deployments like Feÿ, which extend this starter).
 *
 * Modules reference them in `.md` frontmatter:
 *   context:
 *     - source: inner-mood
 *     - source: recent-group-chat
 *
 * Framework built-in providers (events, current-time, upcoming-scheduled)
 * are always available alongside these.
 */

import type { ContextProvider } from "../../../../src/core/context-providers.js";
import type { ModuleContext } from "../../../../src/core/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { symbientDisplayName } from "../../../../src/core/symbient-name.js";
import { annotateContextLines } from "../../../../src/memory/time-annotate.js";

function safeRead(path: string): Promise<string | null> {
  return readFile(path, "utf-8").catch(() => null);
}

function wsPath(ctx: ModuleContext): string {
  return join(process.cwd(), "workspace");
}

function dailyLogPath(ws: string, date: Date): string {
  return join(ws, "memory", `${date.toISOString().slice(0, 10)}.md`);
}

// --- Providers ---

/**
 * Inner mood — reads `inner/current-state.md`, `current-desire.md`,
 * `current-magi.md` (the cognitive modules' output files). Only
 * relevant if you run the thinking/desire/magi modules.
 */
const innerMoodProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const ws = wsPath(ctx);
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

/**
 * Recent DMs — parses today's log for inbound DM lines. The symbient's
 * own replies are excluded (we don't want it anchoring on past failures).
 */
const recentDmsProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 10;
    const todayLog = await safeRead(dailyLogPath(wsPath(ctx), new Date()));
    if (!todayLog) return null;
    const self = symbientDisplayName();
    const dmPattern = /^\*\*([^*]+)\*\*\s*\(dm(?:\s+to\s+([^)]+))?\):\s*(.+)/gm;
    const entries: Array<{ time: string; from: string; snippet: string }> = [];
    const sections = todayLog.split(/^## (\d{2}:\d{2}:\d{2})/m);
    let currentTime = "";
    for (const section of sections) {
      const t = section.match(/^(\d{2}:\d{2}:\d{2})$/);
      if (t) { currentTime = t[1]; continue; }
      let m;
      dmPattern.lastIndex = 0;
      while ((m = dmPattern.exec(section)) !== null) {
        if (m[1] === self) continue;  // skip the symbient's own messages
        entries.push({ time: currentTime, from: m[1], snippet: m[3].replace(/\n/g, " ") });
      }
    }
    if (entries.length === 0) return null;
    const recent = entries.slice(-count);
    const lines = recent.map((e) => `[${e.time.slice(0, 5)}] ${e.from}: ${e.snippet}`);
    return (await annotateContextLines(lines)).join("\n");
  },
};

/**
 * Recent group chat — parses today's log for group messages. A
 * "group" message has `(group)` in its header. Adjust the filter if
 * your chat convention uses different tags.
 */
const recentGroupChatProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 18;
    const log = await safeRead(dailyLogPath(wsPath(ctx), new Date()));
    if (!log) return null;
    const msgs: string[] = [];
    const parts = log.split(/^(## \d{2}:\d{2}:\d{2})/m);
    let currentTime = "";
    for (const part of parts) {
      const t = part.match(/^## (\d{2}:\d{2}:\d{2})$/);
      if (t) { currentTime = t[1].slice(0, 5); continue; }
      const trimmed = part.trim();
      const match = trimmed.match(/^\*\*([^*]+)\*\*\s*\(([^)]*)\):\s*([\s\S]+)/);
      if (match && match[2].includes("group")) {
        msgs.push(`[${currentTime}] ${match[1]}: ${match[3].trim()}`);
      }
    }
    if (msgs.length === 0) return null;
    return (await annotateContextLines(msgs.slice(-count))).join("\n");
  },
};

/**
 * Recent days — the last N daily summaries (LLM-generated paragraphs
 * written by MemoryManager after each log append).
 */
const recentDaysProvider: ContextProvider = {
  async execute(decl, ctx) {
    const count = (decl.count as number) ?? 5;
    const parts: string[] = [];
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    for (let i = 0; i < count; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const iso = date.toISOString().slice(0, 10);
      const path = join(wsPath(ctx), "memory", `${iso}.summary.md`);
      const content = await safeRead(path);
      if (content) {
        const label = iso === todayIso ? `**Today (${iso})**` : `**${iso}**`;
        parts.push(`${label}:\n${content.trim()}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  },
};

const dailySummaryProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const today = new Date().toISOString().slice(0, 10);
    return safeRead(join(wsPath(ctx), "memory", `${today}.summary.md`));
  },
};

/**
 * Active states — transient community modes (party mode, focus mode,
 * quiet hours, etc.) that the executive or conversation can set via
 * `memory.setState(name, active)`. Reads `workspace/state/*.json`
 * with optional expiry.
 */
const activeStatesProvider: ContextProvider = {
  async execute(_decl, ctx) {
    const states = await ctx.memory.assembleContext().then(() => null).catch(() => null);
    // Since MemoryManager exposes getActiveStates, call via the memory ref.
    // (Typed as any because the MemoryReader interface is narrow; the
    // concrete MemoryManager class has getActiveStates.)
    const mm = ctx.memory as unknown as { getActiveStates?: () => Promise<Array<{ name: string; context: string | null }>> };
    if (!mm.getActiveStates) return null;
    const active = await mm.getActiveStates();
    if (active.length === 0) return null;
    return active
      .map((s) => `${s.name.toUpperCase()} ACTIVE${s.context ? ": " + s.context : ""}`)
      .join("\n");
  },
};

export default {
  "inner-mood": innerMoodProvider,
  "recent-dms": recentDmsProvider,
  "recent-group-chat": recentGroupChatProvider,
  "recent-days": recentDaysProvider,
  "daily-summary": dailySummaryProvider,
  "active-states": activeStatesProvider,
};
