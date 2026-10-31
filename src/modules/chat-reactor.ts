/**
 * Chat Reactor — generic reactive chat module.
 *
 * Reusable factory for a chat-handler module. The deployment registers
 * it under whatever name it likes (typically "conversation") with
 * `role: "chat-handler"` so the framework can route inbound chat,
 * watch-driven dm/group actions, and scheduled-action defaults to it
 * without hardcoding the name.
 *
 * Deliberately minimal — no group-vs-DM triage, no retry, no protocol
 * prefixes, no attachment handling. Deployments needing any of that
 * register their own factory under the same role.
 *
 * Loads the module's `.md` (looked up by the module's own name in the
 * workspace's `modules/` dir) on first invocation; subsequent ticks
 * reuse the parsed spec until hot-reload invalidates it.
 */

import type { ModuleContext, InboundMessage } from "../core/types.js";
import type { ChatAdapter } from "../adapters/chat/types.js";
import { Agent } from "@mariozechner/pi-agent-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { render, parseSections } from "../core/prompt-template.js";
import { standardVars } from "../core/prompt-vars.js";
import { recordEvent } from "../core/event-log.js";
import { filterToolsByWhitelist } from "../mcp/bridge.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { symbientDisplayName } from "../core/symbient-name.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("chat-reactor");

export interface ChatReactorOpts {
  bridge: ChatAdapter;
  workspacePath: string;
  /**
   * Name under which this reactor is registered — also the basename of
   * its markdown file in `<workspace>/modules/<moduleName>.md`. Defaults
   * to "conversation" for backward compatibility with deployments that
   * haven't yet wired the role-based registration.
   */
  moduleName?: string;
}

export function createChatReactor(opts: ChatReactorOpts) {
  const { bridge, workspacePath } = opts;
  const moduleName = opts.moduleName ?? "conversation";
  const inbox: InboundMessage[] = [];
  bridge.onMessage(async (msg) => { inbox.push(msg); });

  let spec: { template: string; sections: Record<string, string>; toolNames: string[] } | null = null;
  async function loadSpec(): Promise<typeof spec> {
    const modulePath = join(workspacePath, "modules", `${moduleName}.md`);
    // Distinguish "module not present" (silent) from "module present but
    // unreadable / malformed frontmatter" (logged). Both return null so
    // the chat reactor stays alive, but the diagnostic isn't lost.
    if (!existsSync(modulePath)) return null;
    try {
      const raw = await readFile(modulePath, "utf-8");
      const { fields, body } = parseFrontmatter(raw);
      const { body: template, sections } = parseSections(body);
      return {
        template,
        sections,
        toolNames: Array.isArray(fields.tools) ? fields.tools : [],
      };
    } catch (err) {
      log.error(`Failed to load workspace/modules/${moduleName}.md: ${(err as Error).message}`);
      return null;
    }
  }

  return async function chatReactor(ctx: ModuleContext): Promise<void> {
    const msg = inbox.shift();
    if (!msg) return;
    if (!spec) spec = await loadSpec();
    if (!spec) return;

    const self = symbientDisplayName();
    const fromLabel = msg.from.name || msg.from.id;
    const chatTag = msg.chatType === "group" ? "group" : "dm";
    await ctx.memory.appendLog(`**${fromLabel}** (${chatTag}): ${msg.text || "(attachment)"}`);
    recordEvent({
      type: "chat_message", direction: "in", chat: msg.chatType,
      from: fromLabel, fromId: msg.from.id, text: msg.text, groupId: msg.groupId,
    });

    const memoryContext = await ctx.memory.assembleConversationContext(
      msg.text, msg.from.name, msg.from.phone,
    );
    const vars = await standardVars(ctx, {
      sections: spec.sections,
      memoryContext,
      isGroup: msg.chatType === "group",
    });
    const systemPrompt = render(spec.template, vars);

    const allowedTools = filterToolsByWhitelist(ctx.tools, spec.toolNames);

    const agent = new Agent({
      initialState: { model: ctx.model, systemPrompt },
      getApiKey: () => ctx.apiKey,
    });
    if (allowedTools.length > 0) agent.setTools(allowedTools);

    let response = "";
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        response += event.assistantMessageEvent.delta;
      }
    });

    await bridge.sendTyping?.(msg.from.phone || msg.from.id, msg.groupId);
    await agent.prompt(msg.text);
    await agent.waitForIdle();

    const clean = response.trim();
    if (!clean) return;
    await bridge.send({ to: msg.from.phone || msg.from.id, text: clean, groupId: msg.groupId });
    await ctx.memory.appendLog(`**${self}** (${chatTag} to ${fromLabel}): ${clean}`);
    recordEvent({
      type: "chat_message", direction: "out", chat: msg.chatType,
      from: self, to: fromLabel, toId: msg.from.id, text: clean, groupId: msg.groupId,
    });
  };
}
