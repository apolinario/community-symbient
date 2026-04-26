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
 *
 * Modules named `conversation` are skipped — the framework registers a
 * built-in conversation module via register-builtins.ts that owns the
 * chat-adapter wiring; the .md file is still read by chat-reactor for
 * its template/tool-whitelist, but it doesn't enter the orchestrator
 * twice.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModuleConfig, ModuleFunction } from "../core/types.js";
import { createAgentModule } from "./agent-module.js";
import { getModuleHandler, defaultModuleHandler } from "../core/handler-registry.js";
import { parseSections } from "../core/prompt-template.js";
import { parseFrontmatter, parseInterval } from "../core/frontmatter.js";

// Re-exports kept so existing callers (chat-reactor, module-sync,
// memory/manager, dashboard/server) keep working through the migration.
export { parseFrontmatter, parseInterval };

interface ParsedModule {
  config: ModuleConfig;
  fn: ModuleFunction;
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

    const name = (typeof fields.name === "string" ? fields.name : file.replace(".md", ""));
    const interval = typeof fields.interval === "string"
      ? parseInterval(fields.interval)
      : (typeof fields.interval === "number" ? fields.interval : 60_000);
    const toolNames: string[] = Array.isArray(fields.tools) ? fields.tools.filter((t): t is string => typeof t === "string") : [];
    const startActive = fields.startActive !== false; // default true
    const follows = typeof fields.follows === "string" ? fields.follows : undefined;
    const runImmediately = typeof fields.runImmediately === "boolean" ? fields.runImmediately : undefined;

    // Skip conversation — it has special handling (Signal bridge)
    if (name === "conversation") continue;

    // Split the body into the Handlebars template (content before any `## section`)
    // plus any named subsections for use by the module's handler or template conditionals.
    const { body: template, sections } = parseSections(body);

    // Handler: workspace-registered first, else default (log-to-memory).
    const handler = getModuleHandler(name) ?? defaultModuleHandler;

    // Declarative context blocks from frontmatter (`context:` array of provider declarations).
    const contextDecl = Array.isArray(fields.context)
      ? (fields.context as Array<{ source: string; [k: string]: unknown }>)
      : undefined;

    modules.push({
      config: { name, intervalMs: interval, startActive, follows, runImmediately, description: template.split("\n")[0] },
      fn: createAgentModule({
        name,
        prompt: body,
        template,
        sections,
        contextDecl,
        toolNames,
        outputHandler: handler,
      }),
    });
  }

  return modules;
}
