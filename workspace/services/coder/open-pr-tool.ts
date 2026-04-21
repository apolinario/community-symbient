/**
 * open_capability_pr — the coder module's tool to ship an approved gap as a PR.
 *
 * Runs in an isolated git worktree so the live workspace is never modified:
 *   1. Validate gap is approved and has no pr_url yet
 *   2. Create worktree at <worktreeBase>/<gap-id> on branch capability/<gap-id>
 *   3. Write each file inside the worktree
 *   4. git add + commit + push
 *   5. gh pr create → capture URL
 *   6. Update gap file with pr_url, emit capability_pr event
 *
 * Nothing goes live until a human merges the PR and the running repo is pulled.
 *
 * Write paths are restricted to workspace/modules/, workspace/extensions/,
 * workspace/services/ — matches the guardrail in coder.md.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { recordEvent } from "../../../src/core/event-log.js";

const exec = promisify(execFile);

export interface CoderConfig {
  reviewer: string;
  repo: string;
  worktreeBase: string;
}

const ALLOWED_PREFIXES = [
  "workspace/modules/",
  "workspace/extensions/",
  "workspace/services/",
];
const WORKSPACE_RELATIVE_PREFIXES = ["modules/", "extensions/", "services/"];

function normalizePath(p: string): string {
  // Coder's read/ls/grep tools are sandboxed to workspace/, so it sees paths
  // like "services/weather/tools.ts". Accept both repo-relative and
  // workspace-relative forms — prefix workspace/ if needed.
  if (WORKSPACE_RELATIVE_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    return `workspace/${p}`;
  }
  return p;
}

function isPathAllowed(p: string): boolean {
  if (p.includes("..")) return false;
  return ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function runGh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { cwd });
  return stdout.trim();
}

export function createOpenCapabilityPrTool(
  workspacePath: string,
  repoRoot: string,
  coderConfig: CoderConfig,
): AgentTool {
  return {
    name: "open_capability_pr",
    description:
      "Open a PR with the files that implement an approved capability gap. " +
      "REQUIRED: pass a non-empty `files` array where each entry has `{path, content}` — the content string MUST be the FULL source code of that file, not a description. " +
      "The `body` is just the PR description for humans; the `files` array is what actually gets committed. " +
      "Without `files`, nothing is written and the call fails. " +
      "Writes files in an isolated git worktree (running workspace untouched), commits + pushes, opens a PR via gh, updates the gap with pr_url. " +
      "Call ONLY for a gap where approved=true and pr_url is null. " +
      "Writes restricted to workspace/modules/, workspace/extensions/, workspace/services/.",
    label: "Open Capability PR",
    parameters: Type.Object({
      id: Type.String({ description: "Gap id from pending-capability-gaps." }),
      title: Type.String({ description: "PR title — short, descriptive (e.g. 'capability: sauna-arrival-watch')." }),
      body: Type.String({ description: "PR description for humans — what you built, why it resolves the gap, how it works. NOT the source code." }),
      files: Type.Array(
        Type.Object({
          path: Type.String({ description: "Repo-relative path (workspace/modules/, workspace/extensions/, or workspace/services/ only)." }),
          content: Type.String({ description: "FULL source code of the file as a string. Include every import, function, type, and closing brace. Not a summary, not a description — the literal contents that will be written to disk." }),
        }),
        { description: "REQUIRED non-empty array. Each entry is one file to create. Put the actual source code inline in `content`.", minItems: 1 },
      ),
    }),
    execute: async (_id, params) => {
      const gapPath = join(workspacePath, "state", "capability-gaps", `${params.id}.json`);

      let gap: Record<string, unknown>;
      try {
        const raw = await readFile(gapPath, "utf-8");
        gap = JSON.parse(raw);
      } catch {
        return { content: [{ type: "text", text: `Gap ${params.id} not found.` }], details: {} };
      }

      if (gap.approved !== true) {
        return { content: [{ type: "text", text: `Gap ${params.id} is not approved (approved=${gap.approved}). Skipping.` }], details: {} };
      }
      if (gap.pr_url) {
        return { content: [{ type: "text", text: `Gap ${params.id} already has a PR: ${gap.pr_url}` }], details: {} };
      }

      const normalizedFiles = params.files.map((f) => ({ path: normalizePath(f.path), content: f.content }));
      for (const f of normalizedFiles) {
        if (!isPathAllowed(f.path)) {
          return {
            content: [{ type: "text", text: `Rejected: ${f.path} — only workspace/modules/, workspace/extensions/, workspace/services/ allowed.` }],
            details: {},
          };
        }
      }

      const worktreePath = join(coderConfig.worktreeBase, params.id);
      const branch = `capability/${params.id}`;

      try {
        if (existsSync(worktreePath)) {
          await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot }).catch(() => {});
          await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
        }

        await mkdir(dirname(worktreePath), { recursive: true });
        await runGit(repoRoot, "worktree", "add", "-b", branch, worktreePath);

        for (const f of params.files) {
          const full = join(worktreePath, f.path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, f.content, "utf-8");
          await runGit(worktreePath, "add", f.path);
        }

        const commitMsg = `capability: ${gap.what}\n\nGap ${params.id}\n\n${gap.why}`;
        await runGit(worktreePath, "commit", "-m", commitMsg);
        await runGit(worktreePath, "push", "-u", "origin", branch);

        const prBody = `**Gap:** ${gap.what}\n\n**Why:** ${gap.why}\n\n---\n\n${params.body}\n\n_Opened automatically by the coder module for gap ${params.id}._`;
        const prUrl = await runGh(worktreePath, "pr", "create", "--title", params.title, "--body", prBody);

        gap.pr_url = prUrl;
        (gap as { updated_at: string }).updated_at = new Date().toISOString();
        await writeFile(gapPath, JSON.stringify(gap, null, 2), "utf-8");

        recordEvent({
          type: "capability_pr",
          id: params.id,
          pr_url: prUrl,
          branch,
          what: gap.what,
        });

        return {
          content: [{
            type: "text",
            text: `PR opened: ${prUrl}\nBranch: ${branch}\nGap ${params.id} updated with pr_url.`,
          }],
          details: { pr_url: prUrl, branch, gap_id: params.id },
        };
      } catch (err) {
        await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot }).catch(() => {});
        return {
          content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  };
}
