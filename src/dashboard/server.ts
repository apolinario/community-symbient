/**
 * Symbient Dashboard — real-time monitoring UI.
 *
 * - Live log streaming via SSE
 * - Module status (active, last run, interval)
 * - Signal connection status
 * - Radio / sauna / bookings at a glance
 *
 * Runs on port 3333 alongside the main process.
 */

import http from "node:http";
import fs from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
const { join } = path;
import type { Orchestrator } from "../core/orchestrator.js";
import type { MemoryManager } from "../memory/manager.js";

const WORKSPACE = join(process.cwd(), "workspace");

// Extra files to show for specific modules (beyond the auto-discovered module md)
const MODULE_EXTRA_FILES: Record<string, string[]> = {
  thinking: ["inner/current-state.md"],
  desire: ["inner/current-desire.md"],
  magi: ["inner/current-magi.md"],
  radio: ["radio/log.md"],
  "radio-dj": ["radio/log.md"],
  "radio-commentary": ["radio/log.md"],
  autobiographical: ["MEMORY.md"],
  "radio-calendar": ["radio/calendar.json"],
};

/** Get related files for a module — auto-discovers the module md + extras */
function getModuleFiles(name: string): string[] {
  const files: string[] = [`modules/${name}.md`];
  const extras = MODULE_EXTRA_FILES[name];
  if (extras) files.push(...extras);
  return files;
}

const PORT = Number(process.env.DASHBOARD_PORT) || 3333;

// Log persistence + SSE streaming
const LOG_BUFFER_SIZE = 500;
const sseClients = new Set<http.ServerResponse>();
const LOG_FILE = path.join(process.cwd(), "workspace", "logs", "dashboard.jsonl");

// Ensure log directory exists
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}

/** Read last N log lines from disk. */
function readRecentLogs(n: number = LOG_BUFFER_SIZE): string[] {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l: string) => { try { return JSON.parse(l); } catch { return l; } });
  } catch { return []; }
}

/** Call this from the logger to feed lines to the dashboard. */
export function pushLogLine(line: string): void {
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  // Persist to disk (fire and forget)
  fs.appendFile(LOG_FILE, JSON.stringify(line) + "\n", () => {});
}

/** Start the dashboard HTTP server. */
let memoryRef: MemoryManager | null = null;

export function startDashboard(orchestrator: Orchestrator, memory?: MemoryManager): void {
  if (memory) memoryRef = memory;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

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
      const relPaths = getModuleFiles(name);

      // Always include the debug context if it exists
      relPaths.push(`debug/${name}-context.md`);

      for (const rel of relPaths) {
        try {
          const content = await readFile(join(WORKSPACE, rel), "utf-8");
          // For large files, take last 5000 chars
          const trimmed = content.length > 5000 ? "...\n" + content.slice(-5000) : content;
          files.push({ path: rel, content: trimmed });
        } catch {}
      }

      // Also include today's memory log entries for this module
      try {
        const today = new Date().toISOString().slice(0, 10);
        const logPath = join(WORKSPACE, "memory", `${today}.md`);
        const log = await readFile(logPath, "utf-8");
        // Dashboard's per-module log filter — matches the daily-log entry
        // prefixes the module's handler writes (e.g. `*[<Symbient> thinking]*`).
        // The handler format lives in workspace/extensions/handlers.js; we
        // read both forms (`[Name ...]` and `[<Symbient> name]`) so dashboard
        // works regardless of the handler's chosen prefix convention.
        const { symbientDisplayName } = await import("../core/symbient-name.js");
        const self = symbientDisplayName();
        const tag = `[${name.charAt(0).toUpperCase() + name.slice(1)}`;
        const symbientTag = ["thinking", "desire", "magi"].includes(name)
          ? `${self} ${name}`
          : null;
        const pattern = symbientTag ? new RegExp(`\\*\\[${symbientTag}\\]\\*`, "i") : null;

        const sections = log.split(/^(## \d{2}:\d{2}:\d{2})/m);
        const relevant: string[] = [];
        let currentHeader = "";
        for (const section of sections) {
          if (section.match(/^## \d{2}:\d{2}:\d{2}$/)) {
            currentHeader = section;
          } else if (pattern && pattern.test(section)) {
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
