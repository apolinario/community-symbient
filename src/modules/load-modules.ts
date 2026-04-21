/**
 * Module Loader — reads workspace/modules/*.md and creates module functions.
 *
 * Each markdown file defines a module's behavior:
 * - YAML frontmatter: name, interval, tools whitelist, startActive
 * - Markdown body: the module's goal/prompt
 *
 * This keeps module behavior editable without code changes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModuleConfig, ModuleFunction } from "../core/types.js";
import {
  createAgentModule,
  thinkingHandler,
  desireHandler,
  magiHandler,
  autobiographicalHandler,
  promptModifierHandler,
} from "./agent-module.js";

interface ParsedModule {
  config: ModuleConfig;
  fn: ModuleFunction;
}

// Map module names to their output handlers
const radioDjHandler = async (ctx: any, output: string, toolTrace: string[]) => {
  if (toolTrace.length > 0) {
    ctx.log(`DJ: ${toolTrace.join(" → ")}`);
  }
};

const radioHandler = async (ctx: any, output: string, toolTrace: string[], toolCalls?: Array<{ name: string; args: any }>) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const logPath = path.join(process.cwd(), "workspace", "radio", "log.md");
  const timestamp = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = new Date().toISOString().slice(0, 10);

  // Get broadcast messages directly from tool calls (full args, no truncation)
  const broadcastMessages: string[] = [];
  if (toolCalls) {
    for (const call of toolCalls) {
      if (call.name === "radio_broadcast" && call.args?.message) {
        broadcastMessages.push(call.args.message);
      }
    }
  }

  const lines = [`## ${dateStr} ${timestamp}`];
  if (broadcastMessages.length > 0) {
    for (const msg of broadcastMessages) {
      lines.push(``, `**Broadcast:** ${msg}`);
    }
  }
  if (output?.trim()) {
    lines.push(``, `**Notes:** ${output.trim()}`);
  }

  await fs.appendFile(logPath, `\n${lines.join("\n")}\n`, "utf-8");
};

const OUTPUT_HANDLERS: Record<string, typeof thinkingHandler> = {
  thinking: thinkingHandler,
  desire: desireHandler,
  magi: magiHandler,
  autobiographical: autobiographicalHandler,
  "prompt-modifier": promptModifierHandler,
  radio: radioHandler,
  "radio-dj": radioDjHandler,
};

// Parse interval strings like "3h", "10m", "500ms"
function parseInterval(s: string): number {
  const match = s.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match) return 60000; // default 1 min
  const n = parseInt(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    default: return n;
  }
}

export function parseFrontmatter(content: string): { fields: Record<string, any>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };

  const fields: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      let val: any = kv[2].trim();
      // Parse arrays: [a, b, c]
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s: string) => s.trim());
      }
      // Parse booleans
      if (val === "true") val = true;
      if (val === "false") val = false;
      fields[kv[1]] = val;
    }
  }

  return { fields, body: match[2].trim() };
}

export async function loadModuleConfigs(workspacePath: string): Promise<ParsedModule[]> {
  const modulesDir = join(workspacePath, "modules");
  const modules: ParsedModule[] = [];

  let files: string[];
  try {
    files = await readdir(modulesDir);
  } catch {
    return [];
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const content = await readFile(join(modulesDir, file), "utf-8");
    const { fields, body } = parseFrontmatter(content);

    const name = fields.name || file.replace(".md", "");
    const interval = typeof fields.interval === "string" ? parseInterval(fields.interval) : (fields.interval || 60000);
    const toolNames: string[] = Array.isArray(fields.tools) ? fields.tools : [];
    const startActive = fields.startActive !== false; // default true
    const follows = fields.follows as string | undefined;

    // Skip conversation — it has special handling (Signal bridge)
    if (name === "conversation") continue;

    const handler = OUTPUT_HANDLERS[name];
    if (!handler) {
      // Default handler: just log to daily memory
      const defaultHandler = async (ctx: any, output: string, _trace: string[]) => {
        await ctx.memory.appendLog(`*[${name}]* ${output}`);
      };

      modules.push({
        config: { name, intervalMs: interval, startActive, follows, description: body.split("\n")[0] },
        fn: createAgentModule({ name, prompt: body, toolNames, outputHandler: defaultHandler }),
      });
      continue;
    }

    modules.push({
      config: { name, intervalMs: interval, startActive, description: body.split("\n")[0] },
      fn: createAgentModule({ name, prompt: body, toolNames, outputHandler: handler }),
    });
  }

  return modules;
}
