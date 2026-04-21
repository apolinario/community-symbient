/**
 * Approval tools — update the approval state of a capability gap based
 * on a natural-language reply from the reviewer.
 *
 * Conversation module uses these when it interprets the reviewer's DM
 * reply as an approval or rejection. Example flow:
 *
 *   1. feyblet calls request_capability → gap-1234.json created
 *   2. capability-gap watch DMs Poli with the gap details
 *   3. Poli replies "yeah go ahead" (or "not sure, what would it look like?" or "skip it")
 *   4. conversation's LLM reads the pending-capability-gaps context block,
 *      understands which gap is being discussed, and calls
 *      approve_capability({id}) or skip_capability({id})
 *   5. coder module picks up approved gaps on its next cycle
 *
 * No slash commands — the reviewer just talks to the symbient normally.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function updateGap(workspacePath: string, id: string, patch: Record<string, unknown>): Promise<string> {
  const path = join(workspacePath, "state", "capability-gaps", `${id}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    const gap = JSON.parse(raw);
    Object.assign(gap, patch, { updated_at: new Date().toISOString() });
    await writeFile(path, JSON.stringify(gap, null, 2), "utf-8");
    return `Updated ${id}: ${Object.keys(patch).join(", ")}`;
  } catch {
    return `Gap ${id} not found.`;
  }
}

export function createApproveCapabilityTool(workspacePath: string): AgentTool {
  return {
    name: "approve_capability",
    description:
      "Approve a pending capability gap so the coder agent will build it. " +
      "Use ONLY when the reviewer (e.g. Poli in DM) has clearly said yes to a pending gap described in <pending-capability-gaps>. " +
      "Pass the gap id from that context block. The coder picks up approved gaps on its next cycle (~1 minute) and will open a PR — nothing goes live until that PR is merged.",
    label: "Approve Capability",
    parameters: Type.Object({
      id: Type.String({ description: "Gap id (e.g. gap-1776799999123) from the pending-capability-gaps context block." }),
      note: Type.Optional(Type.String({ description: "Optional note from the reviewer — any constraints, preferences, or caveats for the coder to honor." })),
    }),
    execute: async (_id, params) => {
      const status = await updateGap(workspacePath, params.id, {
        approved: true,
        approval_note: params.note ?? null,
      });
      return { content: [{ type: "text", text: status }], details: {} };
    },
  };
}

export function createSkipCapabilityTool(workspacePath: string): AgentTool {
  return {
    name: "skip_capability",
    description:
      "Mark a pending capability gap as skipped — the reviewer has decided not to build this. " +
      "Use when the reviewer has clearly declined a gap described in <pending-capability-gaps>. " +
      "The coder will not pick it up.",
    label: "Skip Capability",
    parameters: Type.Object({
      id: Type.String({ description: "Gap id to skip." }),
      note: Type.Optional(Type.String({ description: "Optional reason the reviewer gave." })),
    }),
    execute: async (_id, params) => {
      const status = await updateGap(workspacePath, params.id, {
        approved: false,
        approval_note: params.note ?? null,
      });
      return { content: [{ type: "text", text: status }], details: {} };
    },
  };
}
