/**
 * Module Sync — hot-reloads markdown modules without restart.
 *
 * Runs every 30s. Scans workspace/modules/*.md and reconciles against the
 * orchestrator: registers new ones, re-registers changed ones (mtime-based
 * change detection), unregisters deleted ones, and moves expired ones into
 * `modules/disabled/`.
 *
 * Code-driven modules (those registered via `registerBuiltInModule`, both
 * framework-shipped and workspace-registered) are skipped — they're owned
 * by `registerBuiltIns` / `workspace/extensions/modules.ts`, not by .md files.
 *
 * Uses orchestrator.registerLive() and orchestrator.unregister().
 */

import type { ModuleContext } from "./types.js";
import type { Orchestrator } from "./orchestrator.js";
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, parseInterval } from "./frontmatter.js";
import { createAgentModule } from "../modules/agent-module.js";
import { parseSections } from "./prompt-template.js";
import { getModuleHandler, defaultModuleHandler } from "./handler-registry.js";
import { getBuiltInModule } from "./module-factories.js";

// Track what we've loaded to detect changes
const loadedModules = new Map<string, { mtime: number }>();

export function createModuleSyncModule(orchestrator: Orchestrator, workspacePath: string) {
  return async function moduleSync(ctx: ModuleContext): Promise<void> {
    const modulesDir = join(workspacePath, "modules");

    let files: string[];
    try {
      files = (await readdir(modulesDir)).filter((f) => f.endsWith(".md"));
    } catch {
      return;
    }

    const currentFiles = new Set<string>();

    for (const file of files) {
      const name = file.replace(".md", "");
      currentFiles.add(name);

      // Skip any module that's owned by the built-in registry (framework
      // modules + workspace-registered code modules). The registry is the
      // single source of truth for "this module is code-driven, not .md-driven."
      if (getBuiltInModule(name)) continue;

      const filePath = join(modulesDir, file);

      // Check mtime to avoid re-reading unchanged files
      try {
        const s = await stat(filePath);
        const existing = loadedModules.get(name);
        if (existing && existing.mtime === s.mtimeMs) continue;

        // File is new or changed — parse and register
        const content = await readFile(filePath, "utf-8");
        const { fields, body } = parseFrontmatter(content);

        const interval = typeof fields.interval === "string"
          ? parseInterval(fields.interval)
          : (typeof fields.interval === "number" ? fields.interval : 60_000);
        const toolNames: string[] = Array.isArray(fields.tools) ? fields.tools.filter((t): t is string => typeof t === "string") : [];
        const startActive = fields.startActive !== false;
        const runImmediately = typeof fields.runImmediately === "boolean" ? fields.runImmediately : undefined;
        const follows = typeof fields.follows === "string" ? fields.follows : undefined;
        const cron = typeof fields.cron === "string" ? fields.cron : undefined;

        // Check expiry
        if (typeof fields.expires === "string") {
          const expiresDate = new Date(fields.expires);
          if (!isNaN(expiresDate.getTime()) && expiresDate.getTime() < Date.now()) {
            // Expired — move to disabled
            ctx.log(`Module ${name} expired, disabling`);
            try {
              const disabledDir = join(modulesDir, "disabled");
              await rename(filePath, join(disabledDir, file));
            } catch {}
            orchestrator.unregister(name);
            loadedModules.delete(name);
            continue;
          }
        }

        // Split md body into Handlebars template + `## section` sub-prompts.
        const { body: template, sections } = parseSections(body);

        // Handler: workspace-registered first, else framework default.
        const handler = getModuleHandler(name) ?? defaultModuleHandler;

        const config = {
          name,
          intervalMs: interval,
          cron,
          startActive,
          follows,
          runImmediately,
          description: template.split("\n")[0],
        };

        // Declarative context blocks from frontmatter.
        const contextDecl = Array.isArray(fields.context)
          ? (fields.context as Array<{ source: string; [k: string]: unknown }>)
          : undefined;

        const fn = createAgentModule({
          name,
          prompt: body,
          template,
          sections,
          contextDecl,
          toolNames,
          outputHandler: handler,
        });

        orchestrator.registerLive(config, fn);
        loadedModules.set(name, { mtime: s.mtimeMs });
      } catch (err) {
        ctx.log(`Module sync error for ${name}: ${err}`);
      }
    }

    // Check for removed modules (file deleted or moved to disabled/).
    // Skip code-driven names — those aren't tracked here anyway, but
    // the guard is cheap and makes the loop self-explanatory.
    for (const [name] of loadedModules) {
      if (!currentFiles.has(name) && !getBuiltInModule(name)) {
        ctx.log(`Module ${name} removed, unregistering`);
        orchestrator.unregister(name);
        loadedModules.delete(name);
      }
    }
  };
}
