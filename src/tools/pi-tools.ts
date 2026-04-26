/**
 * Sandboxed Pi Agent file tools (read/write/edit/grep/find/ls).
 *
 * Wraps Pi's built-in file tools (read, write, edit, grep, find, ls) with
 * path restrictions so the symbient can only read within workspace/ and
 * only write to a deployment-declared set of paths/prefixes.
 *
 * Default writable paths (overridable via config.workspace.writablePaths):
 *   - MEMORY.md  — curated long-term memory
 *   - people/    — per-person profiles
 *
 * Deployments with extra writable areas (inner-state, scheduled tasks,
 * seasonal logs, etc.) extend the list via `config.workspace.writablePaths`.
 */

import { resolve, relative, extname, isAbsolute } from "node:path";
import { access, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

const DEFAULT_WRITABLE_PREFIXES = [
  "MEMORY.md",
  "people/",
];

// Image extensions Pi's read tool recognizes
const IMAGE_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function isWritable(absolutePath: string, workspacePath: string, prefixes: string[]): boolean {
  const rel = relative(workspacePath, resolve(absolutePath));
  if (rel.startsWith("..") || rel === "") return false;
  return prefixes.some((prefix) => {
    if (prefix.endsWith("/")) {
      // Directory prefix: match the dir itself or anything inside it
      const dirName = prefix.slice(0, -1);
      return rel === dirName || rel.startsWith(prefix);
    }
    return rel === prefix;
  });
}

function assertReadable(absolutePath: string, workspacePath: string): void {
  const resolved = resolve(absolutePath);
  if (!resolved.startsWith(workspacePath)) {
    throw new Error(`Access denied: ${absolutePath} is outside workspace`);
  }
}

function assertWritable(absolutePath: string, workspacePath: string, prefixes: string[]): void {
  assertReadable(absolutePath, workspacePath);
  if (!isWritable(absolutePath, workspacePath, prefixes)) {
    const rel = relative(workspacePath, absolutePath);
    throw new Error(
      `Write denied: ${rel} is not in a writable directory. Writable paths: ${prefixes.join(", ")}`
    );
  }
}

/**
 * Create all sandboxed Pi tools for the symbient workspace.
 * Read tools can access anything under workspace/.
 * Write/edit tools are restricted to writablePrefixes (defaults to
 * MEMORY.md + people/; deployments extend via config.workspace.writablePaths).
 */
export function createSandboxedPiTools(
  workspacePath: string,
  writablePrefixes: string[] = DEFAULT_WRITABLE_PREFIXES,
): AgentTool[] {
  const ws = resolve(workspacePath);
  const prefixes = writablePrefixes;

  // Read — full workspace access, images supported
  const piRead = createReadTool(ws, {
    operations: {
      readFile: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        return readFile(absolutePath);
      },
      access: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        await access(absolutePath, constants.R_OK);
      },
      detectImageMimeType: async (absolutePath) => {
        const ext = extname(absolutePath).toLowerCase();
        return IMAGE_EXTENSIONS[ext] ?? null;
      },
    },
  });

  // Wrap pi's read tool to support tail semantics. Append-only logs (radio,
  // memory, event logs) grow large and the "interesting" part is always near
  // EOF — but pi's offset is 1-indexed positive, so callers can only read
  // head. This wrapper adds:
  //   - `tail: N` → read the last N lines of the file
  //   - negative `offset` → shortcut for `tail: |offset|`
  // Positive offsets and the existing limit behave unchanged.
  const read: AgentTool = {
    name: piRead.name,
    description:
      piRead.description +
      " Set `tail: N` to read the last N lines (useful for append-only logs). " +
      "A negative `offset` (e.g. -50) is shorthand for `tail: 50`. " +
      "Positive `offset` and `limit` behave as before.",
    label: piRead.label,
    parameters: Type.Object({
      path: Type.String({ description: "File path (workspace-relative or absolute)." }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed). Negative values read from end — `-50` means last 50 lines." })),
      limit: Type.Optional(Type.Number({ description: "Max lines to return." })),
      tail: Type.Optional(Type.Number({ description: "Return the last N lines of the file. Takes precedence over offset when both are set." })),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const tailLines = params.tail ?? (typeof params.offset === "number" && params.offset < 0 ? -params.offset : undefined);
      if (tailLines === undefined) {
        return piRead.execute(toolCallId, params, signal, onUpdate);
      }
      const absolutePath = isAbsolute(params.path) ? params.path : resolve(ws, params.path);
      assertReadable(absolutePath, ws);
      const content = (await readFile(absolutePath, "utf-8")).split("\n");
      // Drop a single trailing empty element from trailing newline
      if (content.length > 0 && content[content.length - 1] === "") content.pop();
      const start = Math.max(1, content.length - tailLines + 1);
      return piRead.execute(toolCallId, { ...params, offset: start, limit: params.limit ?? tailLines }, signal, onUpdate);
    },
  };

  // Write — restricted to writable paths
  const piWrite = createWriteTool(ws, {
    operations: {
      writeFile: async (absolutePath, content) => {
        assertWritable(absolutePath, ws, prefixes);
        await writeFile(absolutePath, content, "utf-8");
      },
      mkdir: async (dir) => {
        // Pi's createWriteTool calls mkdir(dirname(path)) before every write.
        // For files at the workspace root, dirname IS the workspace — and
        // `relative(ws, ws) === ""`, which a writability check would reject.
        // Enforce only the sandbox boundary here; the writeFile path still
        // runs assertWritable for the actual file.
        assertReadable(dir, ws);
        await mkdir(dir, { recursive: true });
      },
    },
  });

  // Strengthen write's description: writes are full-file replace, which
  // destroys any existing content. Reserve it for new files or files
  // designed to be fully regenerated each cycle.
  const write: AgentTool = {
    ...piWrite,
    description:
      (piWrite.description ?? "") +
      " WARNING: `write` is full-file REPLACE. If the file already exists, its entire previous content is destroyed. " +
      "Prefer `edit` for modifying existing files. Only use `write` for: (1) creating a new file that doesn't exist, or " +
      "(2) files that are meant to be fully regenerated each time (e.g. curated memory rewrites). " +
      "If unsure whether the file exists, `read` it first.",
  };

  // Edit — restricted to writable paths
  const edit = createEditTool(ws, {
    operations: {
      readFile: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        return readFile(absolutePath);
      },
      writeFile: async (absolutePath, content) => {
        assertWritable(absolutePath, ws, prefixes);
        await writeFile(absolutePath, content, "utf-8");
      },
      access: async (absolutePath) => {
        assertWritable(absolutePath, ws, prefixes);
        await access(absolutePath, constants.R_OK | constants.W_OK);
      },
    },
  });

  // Grep — read-only, full workspace
  const grep = createGrepTool(ws, {
    operations: {
      isDirectory: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        return (await stat(absolutePath)).isDirectory();
      },
      readFile: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        return (await readFile(absolutePath)).toString("utf-8");
      },
    },
  });

  // Find — read-only, full workspace
  const find = createFindTool(ws, {
    operations: {
      exists: async (absolutePath) => {
        try {
          assertReadable(absolutePath, ws);
          await access(absolutePath, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      glob: async (pattern, cwd, options) => {
        assertReadable(cwd, ws);
        const { glob } = await import("glob");
        const results = await glob(pattern, {
          cwd,
          ignore: options.ignore,
          nodir: true,
        });
        return results.slice(0, options.limit);
      },
    },
  });

  // Ls — read-only, full workspace
  const ls = createLsTool(ws, {
    operations: {
      exists: async (absolutePath) => {
        try {
          assertReadable(absolutePath, ws);
          await access(absolutePath, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        return stat(absolutePath);
      },
      readdir: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        const { readdir: rd } = await import("node:fs/promises");
        return rd(absolutePath);
      },
    },
  });

  return [read, write, edit, grep, find, ls] as unknown as AgentTool[];
}
