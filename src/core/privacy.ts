/**
 * Path privacy — the file-side twin of stream privacy (docs/stream.md).
 * Modules not cleared for private entries get file tools that refuse private
 * paths and leave private files out of listings and search results, and lose
 * the tools that read conversations directly.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createSearchMemoryTool } from "../tools/index.js";

let privatePaths = ["stream.jsonl", "MEMORY.md", "memory/", "logs/", "inner/", "people/", "state/", "tasks/", "debug/", "recordings/"];
const PRIVATE_TOOLS = new Set(["chat_history", "list_schedule", "list_watches"]);
const PATH_TOOLS = new Set(["read", "ls", "find", "grep"]);

export function setPrivatePaths(paths: string[]): void {
  privatePaths = paths;
}

/** Workspace-relative (or search-backend) path → is it private? */
export function isPrivatePath(path: string): boolean {
  const rel = path.replace(/^qmd:\/\/[^/]+\//, "").replace(/^\.\//, "");
  return privatePaths.some((p) => (p.endsWith("/") ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p));
}

const refuse = (path: string) => ({ content: [{ type: "text" as const, text: `${path} is private; this part of you doesn't read it.` }], details: {}, isError: true });

function scopePathTool(tool: AgentTool, workspacePath: string): AgentTool {
  const ws = resolve(workspacePath);
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const raw = String((params as { path?: unknown }).path ?? "");
      const rel = raw ? relative(ws, isAbsolute(raw) ? raw : resolve(ws, raw)) : "";
      if (rel && isPrivatePath(rel)) return refuse(raw);
      const result = await tool.execute(id, params, signal, onUpdate);
      // Listings and grep hits from a broader path drop lines that name private files.
      const prefix = rel ? `${rel}/` : "";
      return {
        ...result,
        content: result.content.map((c) => c.type !== "text" ? c : {
          ...c,
          text: c.text.split("\n").filter((line) => !isPrivatePath(prefix + line.trimStart().replace(/^\.\//, "").split(":")[0])).join("\n"),
        }),
      };
    },
  };
}

/** The tool set a public module gets. */
export function scopeToolsForPublic(tools: AgentTool[], workspacePath: string): AgentTool[] {
  return tools
    .filter((t) => !PRIVATE_TOOLS.has(t.name))
    .map((t) => t.name === "search" ? createSearchMemoryTool({ skipFile: isPrivatePath })
      : PATH_TOOLS.has(t.name) ? scopePathTool(t, workspacePath)
      : t);
}
