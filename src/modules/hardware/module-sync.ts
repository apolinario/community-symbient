/**
 * Module Sync — hot-reloads markdown modules without restart.
 *
 * Runs every 30s. Scans workspace/modules/*.md and compares against
 * registered modules. Adds new ones, removes deleted ones, handles expiry.
 *
 * Uses orchestrator.registerLive() and orchestrator.unregister().
 */

import type { ModuleContext } from "../../core/types.js";
import type { Orchestrator } from "../../core/orchestrator.js";
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../load-modules.js";
import { createAgentModule } from "../agent-module.js";

// Track what we've loaded to detect changes
const loadedModules = new Map<string, { mtime: number }>();

// Modules that are hardcoded (not managed by hot-reload)
const HARDCODED = new Set([
  "sauna", "bookings", "onboarding", "qmd-index",
  "conversation", "radio-calendar", "people-sync",
  "people-enrich", "module-sync", "schedule-checker",
]);

function parseInterval(s: string): number {
  const match = s.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match) return 60000;
  const n = parseInt(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    default: return n;
  }
}

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

      // Skip hardcoded modules and conversation (special wiring)
      if (HARDCODED.has(name) || name === "conversation") continue;

      const filePath = join(modulesDir, file);

      // Check mtime to avoid re-reading unchanged files
      try {
        const s = await stat(filePath);
        const existing = loadedModules.get(name);
        if (existing && existing.mtime === s.mtimeMs) continue;

        // File is new or changed — parse and register
        const content = await readFile(filePath, "utf-8");
        const { fields, body } = parseFrontmatter(content);

        const interval = typeof fields.interval === "string" ? parseInterval(fields.interval) : (fields.interval || 60000);
        const toolNames: string[] = Array.isArray(fields.tools) ? fields.tools : [];
        const startActive = fields.startActive !== false;

        // Check expiry
        if (fields.expires) {
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

        // Determine output handler (default: log to daily memory)
        const defaultHandler = async (c: any, output: string, _trace: string[]) => {
          await c.memory.appendLog(`*[${name}]* ${output}`);
          c.log(`${name}: ${output.slice(0, 100)}...`);
        };

        const follows = fields.follows as string | undefined;
        const config = {
          name,
          intervalMs: interval,
          startActive,
          follows,
          description: body.split("\n")[0],
        };

        const fn = createAgentModule({
          name,
          prompt: body,
          toolNames,
          outputHandler: defaultHandler,
        });

        orchestrator.registerLive(config, fn);
        loadedModules.set(name, { mtime: s.mtimeMs });
      } catch (err) {
        ctx.log(`Module sync error for ${name}: ${err}`);
      }
    }

    // Check for removed modules (file deleted or moved to disabled/)
    for (const [name] of loadedModules) {
      if (!currentFiles.has(name) && !HARDCODED.has(name)) {
        ctx.log(`Module ${name} removed, unregistering`);
        orchestrator.unregister(name);
        loadedModules.delete(name);
      }
    }
  };
}
