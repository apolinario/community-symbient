/**
 * request_capability — any module can call this when it hits a wall.
 *
 * Two-gate safety model:
 *   1. Intent review: the reviewer (config.coder.reviewer) is DMed about
 *      the gap and can /approve or /skip it.
 *   2. Code review: if approved, the coder module writes a new module
 *      in a git worktree and opens a PR. Nothing in the running
 *      workspace changes until the PR is merged and `git pull` runs.
 *
 * This tool just emits the gap record + event. The watch on
 * capability_gap events handles the DM; the coder module picks up
 * approved gaps on its cycle.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordEvent } from "../../../src/core/event-log.js";

export function createRequestCapabilityTool(workspacePath: string): AgentTool {
  return {
    name: "request_capability",
    description:
      "File a capability gap for review when you want to do something but lack the tool, module, or sensor for it. " +
      "NOT an instant build: the request goes to a human reviewer who decides whether to approve. " +
      "If approved, a coder agent writes a new module in a branch and opens a PR — still not live until a human merges it. " +
      "Use this for real gaps (e.g. 'a tool to check if the dishwasher is running'), not for things you could do with existing tools.",
    label: "Request Capability",
    parameters: Type.Object({
      what: Type.String({
        description: "One sentence describing the capability you wanted (e.g. 'a tool to check which room has the loudest music right now').",
      }),
      why: Type.String({
        description: "The situation that made you need this — who asked, what you were trying to do, why existing tools didn't cover it.",
      }),
      example: Type.Optional(Type.String({
        description: "Optional: a concrete recent moment where this would have helped (quote the chat message or describe the scene).",
      })),
      suggested_shape: Type.Optional(Type.String({
        description: "Optional: what kind of thing this might be — a new markdown module, a new tool, a new sensor, a new context provider.",
      })),
    }),
    execute: async (_id, params) => {
      const id = `gap-${Date.now()}`;
      const gap = {
        id,
        what: params.what,
        why: params.why,
        example: params.example ?? null,
        suggested_shape: params.suggested_shape ?? null,
        requested_at: new Date().toISOString(),
        approved: null as boolean | null,
        pr_url: null as string | null,
      };
      const dir = join(workspacePath, "state", "capability-gaps");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.json`), JSON.stringify(gap, null, 2), "utf-8");
      recordEvent({
        type: "capability_gap",
        id,
        what: params.what,
        why: params.why,
        example: params.example,
        suggested_shape: params.suggested_shape,
      });
      return {
        content: [{
          type: "text",
          text:
            `Capability request filed as ${id}. ` +
            `Poli will review; nothing happens until approved. ` +
            `When you reply to whoever asked, set expectations accordingly — this isn't instant and may be declined.`,
        }],
        details: { gapId: id },
      };
    },
  };
}
