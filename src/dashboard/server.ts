/**
 * Symbient Dashboard — real-time monitoring UI on port 3333.
 *
 * Surfaces:
 * - Live log streaming via SSE (`/api/logs`)
 * - Module status: name, active flag, last run, interval (`/api/modules`)
 * - Active states from workspace/state/*.json (`/api/states`)
 * - Symbient name from config (`/api/name`)
 * - Per-module detail page with the module's `.md`, any `dashboardFiles`
 *   declared in frontmatter, and recent log entries the module wrote
 *   (`/api/module/<name>` + `/module/<name>` HTML)
 */

import { createServer, type ServerResponse } from "node:http";
import { appendFile, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../core/frontmatter.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { MemoryManager } from "../memory/manager.js";

/**
 * Get related files for a module: always its own .md, plus anything the
 * module declares in `dashboardFiles: [...]` frontmatter (extra context
 * the operator wants visible in the per-module dashboard panel — e.g.
 * inner-state snapshots, log files, curated memory). Deployment-specific
 * by design — framework reads the frontmatter; the deployment owns the list.
 */
async function getModuleFiles(workspace: string, name: string): Promise<string[]> {
  const modulePath = `modules/${name}.md`;
  const files: string[] = [modulePath];
  try {
    const raw = await readFile(join(workspace, modulePath), "utf-8");
    const { fields } = parseFrontmatter(raw);
    if (Array.isArray(fields.dashboardFiles)) {
      files.push(...fields.dashboardFiles.filter((p) => typeof p === "string"));
    }
  } catch {
    // Module .md missing — return just the (non-existent) reference; the file-read loop will skip it.
  }
  return files;
}

/**
 * Load every dashboard-relevant file for a module: its own .md, anything
 * declared in `dashboardFiles: [...]`, and the per-module debug context
 * if the orchestrator wrote one. Each file's content is trimmed to the
 * last 5000 chars so the panel doesn't bloat. Files that don't exist
 * are silently skipped.
 */
async function loadModuleDetailFiles(workspace: string, name: string): Promise<Array<{ path: string; content: string }>> {
  const relPaths = [...(await getModuleFiles(workspace, name)), `debug/${name}-context.md`];
  const out: Array<{ path: string; content: string }> = [];
  for (const rel of relPaths) {
    try {
      const content = await readFile(join(workspace, rel), "utf-8");
      const trimmed = content.length > 5000 ? "...\n" + content.slice(-5000) : content;
      out.push({ path: rel, content: trimmed });
    } catch {
      // missing — skip
    }
  }
  return out;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the regex used to match this module's log entries. Modules can
 * declare an explicit `dashboardLogTag` in frontmatter; otherwise we
 * fall back to a heuristic that catches the two common handler-prefix
 * conventions (`*[<Symbient> <name>]*` and `*[<Capitalized name>...]*`).
 */
async function modulePatternFor(workspace: string, name: string): Promise<RegExp> {
  let dashboardLogTag: string | null = null;
  try {
    const raw = await readFile(join(workspace, `modules/${name}.md`), "utf-8");
    const { fields } = parseFrontmatter(raw);
    if (typeof fields.dashboardLogTag === "string") dashboardLogTag = fields.dashboardLogTag;
  } catch {
    // module .md missing — fall through to heuristic
  }
  if (dashboardLogTag) {
    return new RegExp(`\\*\\[${escapeRegex(dashboardLogTag)}\\]\\*`, "i");
  }
  const { symbientDisplayName } = await import("../core/symbient-name.js");
  const self = symbientDisplayName();
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return new RegExp(`\\*\\[(?:${escapeRegex(self)}\\s+${escapeRegex(name)}|${escapeRegex(cap)}[^\\]]*)\\]\\*`, "i");
}

/**
 * Filter today's daily log to entries this module wrote, returning the
 * last 10 matched sections joined with blank lines. Returns null when
 * today's log doesn't exist yet or no entries match.
 */
async function filterTodayLogForModule(workspace: string, name: string): Promise<{ path: string; content: string } | null> {
  const today = new Date().toISOString().slice(0, 10);
  let log: string;
  try {
    log = await readFile(join(workspace, "memory", `${today}.md`), "utf-8");
  } catch {
    return null;
  }
  const pattern = await modulePatternFor(workspace, name);
  const sections = log.split(/^(## \d{2}:\d{2}:\d{2})/m);
  const relevant: string[] = [];
  let currentHeader = "";
  for (const section of sections) {
    if (section.match(/^## \d{2}:\d{2}:\d{2}$/)) {
      currentHeader = section;
    } else if (pattern.test(section)) {
      relevant.push(currentHeader + "\n" + section.trim());
    }
  }
  if (relevant.length === 0) return null;
  return { path: `memory/${today}.md (${name} entries)`, content: relevant.slice(-10).join("\n\n") };
}

const PORT = Number(process.env.DASHBOARD_PORT) || 3333;

// Log persistence + SSE streaming
const LOG_BUFFER_SIZE = 500;
const sseClients = new Set<ServerResponse>();
let logFilePath: string | null = null;

/** Read last N log lines from disk. */
function readRecentLogs(n: number = LOG_BUFFER_SIZE): string[] {
  if (!logFilePath) return [];
  try {
    const lines = readFileSync(logFilePath, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l: string) => { try { return JSON.parse(l); } catch { return l; } });
  } catch { return []; }
}

/** Call this from the logger to feed lines to the dashboard. */
export function pushLogLine(line: string): void {
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  if (logFilePath) {
    appendFile(logFilePath, JSON.stringify(line) + "\n", () => {});
  }
}

/** Start the dashboard HTTP server. */
let memoryRef: MemoryManager | null = null;
let workspaceRef: string = "";

export function startDashboard(
  orchestrator: Orchestrator,
  memory: MemoryManager,
  workspacePath: string,
): void {
  memoryRef = memory;
  workspaceRef = workspacePath;
  logFilePath = join(workspacePath, "logs", "dashboard.jsonl");
  try { mkdirSync(dirname(logFilePath), { recursive: true }); } catch {}

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (url.pathname === "/api/name") {
      const { symbientName } = await import("../core/symbient-name.js");
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ name: symbientName() }));
      return;
    }


    if (url.pathname === "/api/states") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const states = memoryRef ? await memoryRef.getActiveStates() : [];
        res.end(JSON.stringify(states.map((s) => s.name)));
      } catch {
        res.end("[]");
      }
      return;
    }

    if (url.pathname === "/api/modules") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const modules = orchestrator.listModules().map((m) => ({
        name: m.config.name,
        active: m.active,
        intervalMs: m.config.intervalMs,
        lastRun: m.lastRun?.toISOString() || null,
        description: m.config.description || "",
      }));
      res.end(JSON.stringify(modules));
      return;
    }

    if (url.pathname === "/api/logs") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      // Send persisted logs first
      for (const line of readRecentLogs()) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // Module detail API: /api/module/<name>
    const moduleMatch = url.pathname.match(/^\/api\/module\/(.+)$/);
    if (moduleMatch) {
      const name = decodeURIComponent(moduleMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });

      const files = await loadModuleDetailFiles(workspaceRef, name);
      const todayLogEntries = await filterTodayLogForModule(workspaceRef, name);
      if (todayLogEntries) files.push(todayLogEntries);

      const handle = orchestrator.getHandle(name);
      res.end(JSON.stringify({
        name,
        active: handle?.active ?? false,
        intervalMs: handle?.config.intervalMs ?? 0,
        lastRun: handle?.lastRun?.toISOString() || null,
        files,
      }));
      return;
    }

    // Module page
    if (url.pathname.startsWith("/module/")) {
      try {
        const html = await readFile(join(import.meta.dirname, "module.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Module page not found");
      }
      return;
    }

    if (url.pathname === "/docs" || url.pathname === "/docs/") {
      try {
        // docs ship alongside the workspace at `<project-root>/docs`.
        // Anchor to workspace's parent so the dashboard works regardless
        // of how the process was launched.
        const html = await readFile(join(dirname(workspaceRef), "docs", "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("Docs not found");
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = await readFile(join(import.meta.dirname, "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Dashboard HTML not found");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
}
