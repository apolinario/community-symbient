/**
 * Module Loader — reads workspace/modules/*.md and creates module functions.
 *
 * Each markdown file defines a module's behavior:
 * - YAML frontmatter: name, interval, tools whitelist, startActive
 * - Markdown body: Handlebars template for the system prompt
 * - Optional `## section` H2 headings: named sub-prompts (extracted into spec.sections)
 *
 * Module-specific output handlers live in `workspace/extensions/handlers.js`
 * (loaded separately via extension-loader). Core only ships the default
 * handler (log-to-memory).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModuleConfig, ModuleFunction } from "../core/types.js";
import { createAgentModule } from "./agent-module.js";
import { getModuleHandler, defaultModuleHandler } from "../core/handler-registry.js";
import { parseSections } from "../core/prompt-template.js";

interface ParsedModule {
  config: ModuleConfig;
  fn: ModuleFunction;
}

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

    // Split the body into the Handlebars template (content before any `## section`)
    // plus any named subsections for use by the module's handler or template conditionals.
    const { body: template, sections } = parseSections(body);

    // Handler: workspace-registered first, else default (log-to-memory).
    const handler = getModuleHandler(name) ?? defaultModuleHandler;

    modules.push({
      config: { name, intervalMs: interval, startActive, follows, description: template.split("\n")[0] },
      fn: createAgentModule({
        name,
        prompt: body,
        template,
        sections,
        toolNames,
        outputHandler: handler,
      }),
    });
  }

  return modules;
}
