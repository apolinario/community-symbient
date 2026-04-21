/**
 * Sandboxed Pi Agent file tools (read/write/edit/grep/find/ls).
 *
 * Wraps Pi's built-in file tools (read, write, edit, grep, find, ls) with
 * path restrictions so the feyblet can only read within workspace/ and only
 * write to a restricted set of directories.
 *
 * Writable paths (relative to workspace/):
 *   - MEMORY.md         — autobiographical rewrites
 *   - season/           — events, meals, parties, crispy
 *   - people/           — person profiles
 *   - tasks/            — scheduled actions
 */

import { resolve, relative, extname } from "node:path";
import { access, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

// Paths the feyblet is allowed to write to (relative to workspace)
const WRITABLE_PREFIXES = [
  "MEMORY.md",
  "inner/",
  "season/",
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

function isWritable(absolutePath: string, workspacePath: string): boolean {
  const rel = relative(workspacePath, resolve(absolutePath));
  if (rel.startsWith("..") || rel === "") return false;
  return WRITABLE_PREFIXES.some((prefix) => {
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

function assertWritable(absolutePath: string, workspacePath: string): void {
  assertReadable(absolutePath, workspacePath);
  if (!isWritable(absolutePath, workspacePath)) {
    const rel = relative(workspacePath, absolutePath);
    throw new Error(
      `Write denied: ${rel} is not in a writable directory. Writable paths: ${WRITABLE_PREFIXES.join(", ")}`
    );
  }
}

/**
 * Create all sandboxed Pi tools for the feyblet workspace.
 * Read tools can access anything under workspace/.
 * Write/edit tools are restricted to WRITABLE_PREFIXES.
 */
export function createSandboxedPiTools(workspacePath: string): AgentTool[] {
  const ws = resolve(workspacePath);

  // Read — full workspace access, images supported
  const read = createReadTool(ws, {
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

  // Write — restricted to writable paths
  const write = createWriteTool(ws, {
    operations: {
      writeFile: async (absolutePath, content) => {
        assertWritable(absolutePath, ws);
        await writeFile(absolutePath, content, "utf-8");
      },
      mkdir: async (dir) => {
        assertWritable(dir, ws);
        await mkdir(dir, { recursive: true });
      },
    },
  });

  // Edit — restricted to writable paths
  const edit = createEditTool(ws, {
    operations: {
      readFile: async (absolutePath) => {
        assertReadable(absolutePath, ws);
        return readFile(absolutePath);
      },
      writeFile: async (absolutePath, content) => {
        assertWritable(absolutePath, ws);
        await writeFile(absolutePath, content, "utf-8");
      },
      access: async (absolutePath) => {
        assertWritable(absolutePath, ws);
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
