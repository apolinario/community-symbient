/**
 * Signal-flavoured DM and group-send tools.
 *
 * The framework only exposes a generic ChatAdapter — it doesn't know how
 * to map "Aaron" → a Signal phone number or a Matrix matrix ID. That
 * mapping is deployment-specific: Feÿ keeps phone + signal-uuid in each
 * person's frontmatter and a base64 group-id table at
 * `workspace/community/known-groups.md`. A Discord deployment would store
 * different identifiers and write different tools.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ChatAdapter } from "../../../src/adapters/chat/types.js";
import type { MemoryManager } from "../../../src/memory/manager.js";
import { symbientDisplayName } from "../../../src/core/symbient-name.js";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

async function loadImageAsDataUrl(workspacePath: string, relPath: string): Promise<string> {
  const fullPath = join(workspacePath, relPath);
  const buffer = await readFile(fullPath);
  const mime = IMAGE_MIME[extname(fullPath).toLowerCase()] ?? "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export interface MessagingDeps {
  adapter: ChatAdapter;
  memory: MemoryManager;
  workspacePath: string;
}

export function createSendDMTool(deps: MessagingDeps): AgentTool {
  const { adapter, memory, workspacePath } = deps;
  return {
    name: "send_dm",
    description: "Send a direct message to someone, optionally with an image attachment. Person is resolved from their profile (phone or signal-uuid).",
    label: "Send DM",
    parameters: Type.Object({
      to: Type.String({ description: "Person name — resolved to chat ID via person lookup" }),
      message: Type.String({ description: "The message to send" }),
      image_path: Type.Optional(Type.String({ description: "Workspace-relative path to an image, e.g. media/2026-04-08-sarah.jpg" })),
    }),
    execute: async (_id, params) => {
      const person = await memory.findPerson(params.to);
      if (!person) {
        return { content: [{ type: "text", text: `Could not find person "${params.to}". Try a different name.` }], details: {} };
      }

      const phoneMatch = person.content.match(/phone:\s*["']?(\+[\d\s]+)["']?/);
      const uuidMatch = person.content.match(/signal-uuid:\s*["']?([\w-]+)["']?/);
      const chatId = phoneMatch?.[1]?.replace(/\s/g, "") || uuidMatch?.[1];

      if (!chatId) {
        return { content: [{ type: "text", text: `Found ${params.to} but no phone/UUID in their profile.` }], details: {} };
      }

      try {
        const attachments = params.image_path
          ? [await loadImageAsDataUrl(workspacePath, params.image_path)]
          : undefined;
        await adapter.send({ to: chatId, text: params.message, attachments });
        const imageNote = params.image_path ? ` [+image: ${params.image_path}]` : "";
        await memory.appendLog(`**${symbientDisplayName()}** (dm to ${params.to}): ${params.message}${imageNote}`);
        return { content: [{ type: "text", text: `DM sent to ${params.to}: "${params.message.slice(0, 100)}"${imageNote}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send DM: ${err}` }], details: {} };
      }
    },
  };
}

export function createSendGroupMessageTool(deps: MessagingDeps): AgentTool {
  const { adapter, memory, workspacePath } = deps;
  // Friendly-name → group-id table loaded once from workspace/community/known-groups.md.
  const knownGroups = new Map<string, string>();
  let loaded = false;
  // Dedup recent broadcasts to keep accidental retries silent.
  const recentMessages: string[] = [];

  async function loadKnownGroups() {
    if (loaded) return;
    try {
      const content = await readFile(join(workspacePath, "community", "known-groups.md"), "utf-8");
      for (const m of content.matchAll(/\*\*(.+?)\*\*:\s*`(.+?)`/g)) {
        knownGroups.set(m[1].toLowerCase(), m[2]);
      }
      loaded = true;
    } catch {
      // No known-groups file yet — name lookups will fail with a clear error.
    }
  }

  return {
    name: "send_group_message",
    description: "Send a message to a group chat, optionally with an image. You can pass either the raw group ID or a friendly name from workspace/community/known-groups.md.",
    label: "Send Group Message",
    parameters: Type.Object({
      group_id: Type.String({ description: "Group ID or friendly name" }),
      message: Type.String({ description: "The message to send" }),
      image_path: Type.Optional(Type.String({ description: "Workspace-relative path to an image" })),
    }),
    execute: async (_id, params) => {
      await loadKnownGroups();

      if (recentMessages.includes(params.message)) {
        return { content: [{ type: "text", text: `Duplicate message blocked — you just sent this. Not sending again.` }], details: {} };
      }

      let groupId = params.group_id;
      if (!groupId.includes("/") && !groupId.includes("=")) {
        const resolved = knownGroups.get(groupId.toLowerCase());
        if (resolved) {
          groupId = resolved;
        } else {
          return { content: [{ type: "text", text: `Unknown group name "${params.group_id}". Use the group ID or a known name.` }], details: {} };
        }
      }

      try {
        const attachments = params.image_path
          ? [await loadImageAsDataUrl(workspacePath, params.image_path)]
          : undefined;
        await adapter.send({ to: "", text: params.message, groupId, attachments });

        recentMessages.push(params.message);
        if (recentMessages.length > 20) recentMessages.shift();

        const imageNote = params.image_path ? ` [+image]` : "";
        await memory.appendLog(`**${symbientDisplayName()}** (group): ${params.message}${imageNote}`);
        return { content: [{ type: "text", text: `Sent to group: "${params.message.slice(0, 100)}"${imageNote}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send: ${err}` }], details: {} };
      }
    },
  };
}
