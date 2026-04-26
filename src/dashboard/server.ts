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

import http from "node:http";
import fs from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
const { join } = path;
import { parseFrontmatter } from "../modules/load-modules.js";
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

const PORT = Number(process.env.DASHBOARD_PORT) || 3333;

// Log persistence + SSE streaming
const LOG_BUFFER_SIZE = 500;
const sseClients = new Set<http.ServerResponse>();
let logFilePath: string | null = null;

/** Read last N log lines from disk. */
function readRecentLogs(n: number = LOG_BUFFER_SIZE): string[] {
  if (!logFilePath) return [];
  try {
    const lines = fs.readFileSync(logFilePath, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l: string) => { try { return JSON.parse(l); } catch { return l; } });
  } catch { return []; }
}

/** Call this from the logger to feed lines to the dashboard. */
export function pushLogLine(line: string): void {
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  if (logFilePath) {
    fs.appendFile(logFilePath, JSON.stringify(line) + "\n", () => {});
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
  try { fs.mkdirSync(path.dirname(logFilePath), { recursive: true }); } catch {}

  const server = http.createServer(async (req, res) => {
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

      const files: Array<{ path: string; content: string }> = [];
      const relPaths = await getModuleFiles(workspaceRef, name);

      // Always include the debug context if it exists
      relPaths.push(`debug/${name}-context.md`);

      for (const rel of relPaths) {
        try {
          const content = await readFile(join(workspaceRef, rel), "utf-8");
          // For large files, take last 5000 chars
          const trimmed = content.length > 5000 ? "...\n" + content.slice(-5000) : content;
          files.push({ path: rel, content: trimmed });
        } catch {}
      }

      // Also include today's memory log entries written by this module.
      // The module's frontmatter can declare an explicit `dashboardLogTag`
      // (the literal `*[Tag]*` prefix the module's handler writes). If
      // unset, fall back to a heuristic that matches `*[<Symbient> <name>]*`
      // OR `*[<Capitalized name>...]*` — covers the common conventions
      // without requiring every module to declare the tag.
      try {
        const today = new Date().toISOString().slice(0, 10);
        const logPath = join(workspaceRef, "memory", `${today}.md`);
        const log = await readFile(logPath, "utf-8");
        const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        let pattern: RegExp;
        const moduleMdPath = `modules/${name}.md`;
        let dashboardLogTag: string | null = null;
        try {
          const raw = await readFile(join(workspaceRef, moduleMdPath), "utf-8");
          const { fields } = parseFrontmatter(raw);
          if (typeof fields.dashboardLogTag === "string") dashboardLogTag = fields.dashboardLogTag;
        } catch {}

        if (dashboardLogTag) {
          pattern = new RegExp(`\\*\\[${escapeRe(dashboardLogTag)}\\]\\*`, "i");
        } else {
          const { symbientDisplayName } = await import("../core/symbient-name.js");
          const self = symbientDisplayName();
          const cap = name.charAt(0).toUpperCase() + name.slice(1);
          pattern = new RegExp(`\\*\\[(?:${escapeRe(self)}\\s+${escapeRe(name)}|${escapeRe(cap)}[^\\]]*)\\]\\*`, "i");
        }

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

        if (relevant.length > 0) {
          files.push({ path: `memory/${today}.md (${name} entries)`, content: relevant.slice(-10).join("\n\n") });
        }
      } catch {}

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
        const html = await readFile(join(process.cwd(), "docs", "index.html"), "utf-8");
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
