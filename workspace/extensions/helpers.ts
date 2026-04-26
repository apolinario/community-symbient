/**
 * Feÿ deployment helpers — Handlebars variables available in every .md template.
 *
 * Helpers are resolved by standardVars() against the current module ctx. Any
 * helper registered here appears as {{name}} in all module templates (e.g.
 * conversation.md, radio.md).
 */

import type { HelperFn } from "../../src/core/prompt-vars.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const pendingCapabilityGaps: HelperFn = async () => {
  const dir = join(process.cwd(), "workspace", "state", "capability-gaps");
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return ""; }

  const entries: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const g = JSON.parse(raw);
      if (g.approved !== null || g.pr_url) continue;
      entries.push(`[${g.id}] ${g.what}`);
    } catch {}
  }
  if (entries.length === 0) return "";
  return `<pending-capability-gaps note="gaps the reviewer hasn't decided on yet — if their reply is about one of these, forward via nudge_module(coder, '<id>: <their reply verbatim>')">\n${entries.join("\n")}\n</pending-capability-gaps>`;
};

// Feÿ-specific inner-life pattern: thinking/desire/magi each maintain a
// snapshot file in workspace/inner/. Conversation and other modules surface
// the latest fragment as ambient mood. Other deployments without this
// cognitive structure simply don't reference these helpers in their
// templates and don't pay the file-read cost.
const innerState: HelperFn = async (ctx) => {
  if (!ctx) return "";
  return (await ctx.memory.readFile("inner/current-state.md")) ?? "";
};

const currentDesire: HelperFn = async (ctx) => {
  if (!ctx) return "";
  return (await ctx.memory.readFile("inner/current-desire.md")) ?? "";
};

const currentMagi: HelperFn = async (ctx) => {
  if (!ctx) return "";
  return (await ctx.memory.readFile("inner/current-magi.md")) ?? "";
};

export default {
  pendingCapabilityGaps,
  innerState,
  currentDesire,
  currentMagi,
};
