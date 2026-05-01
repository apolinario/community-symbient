/**
 * Conversation Module — Feyblet's voice in Signal.
 *
 * Uses Pi Agent SDK for native tool calling. The Agent handles
 * the tool execution loop automatically — no text parsing needed.
 *
 * GROUP MESSAGES: Feyblet always observes (logs to memory) but is
 * parsimonious about responding. A lightweight triage pass decides
 * whether to engage. DMs always get a response.
 */

import type { ModuleContext } from "../../../src/core/types.js";
import type { InboundMessage } from "../../../src/core/types.js";
import type { ChatAdapter } from "../../../src/adapters/chat/types.js";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { filterToolsByWhitelist } from "../../../src/mcp/bridge.js";
import { parseFrontmatter } from "../../../src/modules/load-modules.js";
import { parseSections, render } from "../../../src/core/prompt-template.js";
import { standardVars } from "../../../src/core/prompt-vars.js";
import { recordEvent } from "../../../src/core/event-log.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FEYBLET_NAMES = ["feyblet", "feyby", "feybling", "feybient", "feytus", "feyble", "symbient", "simbient", "radio host"];
const FEYBLET_UUID = process.env.FEYBLET_UUID || "26876cef-04fb-4292-b35e-c4ef9194b064";

// ── Mention expansion ────────────────────────────────────────────────
// Signal renders inline @-mentions as a single object-replacement
// character (`￼`, U+FFFC) in the message body, with a parallel
// `mentions: [{start, length, uuid}]` array carrying the actual
// recipients. Without expansion, the agent reads `Welcome ￼ how are
// you` and reasons "nobody named me" — which is what caused the
// Sofi-tagged-feyblet leak. expandMentions resolves each placeholder
// into `@<name>` so the agent (and the daily log) actually see who
// got tagged.
//
// Lookup chain per UUID: feyblet's own UUID → "@Feyblet" (we have no
// .md file for the symbient). Else scan workspace/people/*.md
// frontmatter (cached for UUID_CACHE_TTL_MS to keep the hot path
// cheap). Else fall back to a short uuid stub.

const UUID_CACHE_TTL_MS = 5 * 60 * 1000;
let uuidNameCache: Map<string, string> | null = null;
let uuidCacheLoadedAt = 0;

async function getUuidNameCache(workspacePath: string): Promise<Map<string, string>> {
  const now = Date.now();
  if (uuidNameCache && (now - uuidCacheLoadedAt) < UUID_CACHE_TTL_MS) return uuidNameCache;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const peopleDir = path.join(workspacePath, "people");
  const map = new Map<string, string>();
  try {
    const files = await fs.readdir(peopleDir);
    await Promise.all(files.map(async (f) => {
      if (!f.endsWith(".md")) return;
      try {
        const content = await fs.readFile(path.join(peopleDir, f), "utf-8");
        const uuid = content.match(/^signal-uuid:\s*"?([a-f0-9-]{36})"?\s*$/m)?.[1];
        if (!uuid) return;
        const nameRaw = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const name = nameRaw?.replace(/^["']|["']$/g, "") || f.replace(/\.md$/, "");
        map.set(uuid, name);
      } catch { /* malformed file — skip */ }
    }));
  } catch { /* no people dir — empty cache */ }
  uuidNameCache = map;
  uuidCacheLoadedAt = now;
  return map;
}

function expandMentionsSync(
  text: string,
  mentions: { uuid: string; start?: number; length?: number }[] | undefined,
  uuidToName: Map<string, string>,
): string {
  if (!mentions?.length || !text.includes("￼")) return text;
  // Mentions are usually in document order but sort by start to be safe.
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let i = 0;
  return text.replace(/￼/g, () => {
    const m = sorted[i++];
    if (!m) return "￼";
    if (m.uuid === FEYBLET_UUID) return "@Feyblet";
    const name = uuidToName.get(m.uuid);
    // Unmatched tag → short, semantically-meaningful placeholder. The
    // agent reads this as "someone got tagged here whose identity we
    // couldn't resolve" rather than treating a 6-char hex stub as a
    // real handle.
    return name ? `@${name}` : "@someone";
  });
}

async function expandMentions(
  text: string,
  mentions: { uuid: string; start?: number; length?: number }[] | undefined,
  workspacePath: string,
): Promise<string> {
  if (!mentions?.length || !text.includes("￼")) return text;
  const cache = await getUuidNameCache(workspacePath);
  return expandMentionsSync(text, mentions, cache);
}

// Group ids where the conversation agent's `send_group_message` tool is
// hard-blocked by default — every spontaneous post the agent tries gets
// returned as an error result instead of reaching Signal. Direct-address
// responses (the agent emits text → conversation calls bridge.send
// directly with the response, no tool call) are NOT gated by this; this
// only catches agent-initiated tool calls.
//
// Toggle via FEYBLET_ALLOW_SPONTANEOUS_GROUP_POSTS=1 to bypass the gate
// (useful when the operator wants to let the agent post for a one-off).
const NO_SPONTANEOUS_POST_GROUPS = new Set([
  "aX/mc0Cl/SsJQp6ngVqbBL/NYJi0FanGsqn7HMo9Lw4=",  // FEŸTOPIA 2026 - Season 7
  "MlrDH7A7wjAra6c1JxBoA1NHTZyMq3dDZwTQEgAko1c=",  // Feÿnale 2026 ✨
]);

function isSpontaneousGroupPostsAllowed(): boolean {
  const v = process.env.FEYBLET_ALLOW_SPONTANEOUS_GROUP_POSTS;
  return v === "1" || v?.toLowerCase() === "true";
}

/** Wrap `send_group_message` so calls targeting a no-spontaneous-post
 *  group short-circuit with a clear error result — telling the agent to
 *  DM the relevant person instead.
 *
 *  Allow-list logic (in priority order):
 *    1. If FEYBLET_ALLOW_SPONTANEOUS_GROUP_POSTS=1, all sends pass.
 *    2. If groupId is NOT in NO_SPONTANEOUS_POST_GROUPS, the send passes.
 *    3. If groupId === allowGroupId (the group where a direct-address
 *       was triaged in for this call), the send passes — this is the
 *       "quote-reply to a tagged/mentioned message" path.
 *    4. Otherwise, blocked.
 *
 *  Other tools + DMs flow through unchanged. */
function wrapNoSpontaneousGroupPosts(tools: AgentTool[], allowGroupId: string | null): AgentTool[] {
  return tools.map((t) => {
    if (t.name !== "send_group_message") return t;
    const original = t;
    return {
      ...original,
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: any) => {
        const groupId = (params as { group_id?: string; groupId?: string })?.group_id
          ?? (params as { group_id?: string; groupId?: string })?.groupId;

        const passes =
          isSpontaneousGroupPostsAllowed() ||
          !groupId ||
          !NO_SPONTANEOUS_POST_GROUPS.has(groupId) ||
          groupId === allowGroupId;

        if (!passes) {
          return {
            content: [{
              type: "text" as const,
              text: "(blocked: spontaneous posts to this group are disabled. You're allowed to post in this group only when responding to a message that directly tagged or mentioned you in it — and this isn't that. If you want this to reach someone, DM them directly instead. Operator override: set FEYBLET_ALLOW_SPONTANEOUS_GROUP_POSTS=1 in feyblet's env.)",
            }],
            isError: true,
            details: { blocked: true, groupId },
          };
        }
        return original.execute(toolCallId, params, signal, onUpdate);
      },
    } as AgentTool;
  });
}

// Groups where Feyblet only listens — never responds, only logs and observes
const SILENT_GROUPS = new Set(
  (process.env.FEYBLET_SILENT_GROUPS || "").split(",").filter(Boolean),
);

// Tool whitelist and prompt template loaded from conversation.md on first
// cycle (lazy — avoids top-level await + process.cwd() at import time).
let conversationToolNames: string[] = [];
let conversationTemplate = "";
let conversationSections: Record<string, string> = {};
let conversationSpecLoaded = false;

async function ensureConversationSpec(workspacePath: string): Promise<void> {
  if (conversationSpecLoaded) return;
  conversationSpecLoaded = true;
  try {
    const md = await readFile(join(workspacePath, "modules", "conversation.md"), "utf-8");
    const { fields, body } = parseFrontmatter(md);
    conversationToolNames = Array.isArray(fields.tools) ? fields.tools.filter((t): t is string => typeof t === "string") : [];
    const { body: template, sections } = parseSections(body);
    conversationTemplate = template;
    conversationSections = sections;
  } catch {
    // Missing conversation.md is fine — the module degrades to bare default behaviour.
  }
}

export function createConversationModule(bridge: ChatAdapter, workspacePath?: string) {
  const inbox: InboundMessage[] = [];
  const ws = workspacePath ?? join(process.cwd(), "workspace");
  const groupBuffer: Array<{ from: string; text: string; timestamp: Date }> = [];
  const MAX_GROUP_BUFFER = 30;

  bridge.onMessage(async (msg) => {
    inbox.push(msg);
  });

  return async function conversation(ctx: ModuleContext): Promise<void> {
    await ensureConversationSpec(ws);

    // Check for inter-module messages (nudges from executive, radio, coder, etc.).
    // Every non-empty nudge runs a full agent cycle — the system prompt
    // (in conversation.md) tells the LLM how to handle each shape: action
    // payloads (send_dm: / send_group: / request:), forwarded user replies,
    // and plaintext status updates. The previous prefix-gate silently
    // dropped anything without an exact prefix, which broke the coder→
    // conversation handoff whenever coder forgot to format its nudge.
    const moduleMsg = await ctx.messages.receive(100);
    if (moduleMsg && moduleMsg.content.trim()) {
      ctx.log(`Internal: ${moduleMsg.from}: ${moduleMsg.content.slice(0, 80)}`);
      await handleModuleNudge(ctx, moduleMsg);
      return; // Don't process inbox this cycle
    }

    const msg = inbox.shift();
    if (!msg) return;

    const fromLabel = msg.from.name || msg.from.id;

    // --- ALWAYS observe: log every message to memory ---
    // Per-group tag map for season-importance groups. Each gets its own
    // tag (e.g. `, season`, `, feynale`) so daily-log greps can tell
    // them apart while the recent-group-chat context provider can pull
    // from either by including each tag in its filter.
    const GROUP_TAGS: Record<string, string> = {
      "aX/mc0Cl/SsJQp6ngVqbBL/NYJi0FanGsqn7HMo9Lw4=": "season",   // FEŸTOPIA 2026 - Season 7
      "MlrDH7A7wjAra6c1JxBoA1NHTZyMq3dDZwTQEgAko1c=": "feynale",  // Feÿnale 2026 ✨
    };
    let groupTag = "";
    if (msg.groupId && GROUP_TAGS[msg.groupId]) groupTag = `, ${GROUP_TAGS[msg.groupId]}`;
    else if (msg.groupId) groupTag = ", group";

    // Expand inline @-mention placeholders to `@<name>` so the daily
    // log + agent prompt + group buffer all see who was tagged. The
    // original msg.text (with `￼`) is replaced by `expandedText` for
    // every downstream use.
    const expandedText = await expandMentions(msg.text, msg.mentions, ctx.memory.workspacePath);

    // Track known groups so the feyblet can look them up when needed
    if (msg.groupId && msg.groupName) {
      trackKnownGroup(ctx.memory.workspacePath, msg.groupId, msg.groupName).catch(() => {});
    }
    const imageNote = msg.attachments?.filter(a => a.contentType?.startsWith("image/")).length
      ? ` [+${msg.attachments.filter(a => a.contentType?.startsWith("image/")).length} image(s)]`
      : "";
    await ctx.memory.appendLog(
      `**${fromLabel}** (${msg.chatType}${groupTag}): ${expandedText || "(image)"}${imageNote}`,
    );

    // --- Capture Signal UUID to person file ---
    if (msg.from.id && msg.from.name && !msg.from.id.startsWith("+")) {
      captureSignalUuid(ctx, msg.from.name, msg.from.id, msg.from.phone).catch(() => {});
    }

    // --- Silent season logging ---
    if (msg.chatType === "group") {
      detectAndLogSeason(ctx, expandedText, fromLabel).catch((err) => {
        ctx.log(`Season detect error: ${err}`);
      });
    }

    // --- State triggers from chat ---
    const textLower = expandedText.toLowerCase();
    if (textLower.includes("party mode") || textLower.includes("party time")) {
      await (ctx.memory as any).setState("party-mode", true);
      ctx.log("Party mode activated via chat!");
    }

    // --- Silent groups: observe only, never respond ---
    if (msg.chatType === "group" && msg.groupId && SILENT_GROUPS.has(msg.groupId)) {
      groupBuffer.push({ from: fromLabel, text: expandedText, timestamp: msg.timestamp });
      if (groupBuffer.length > MAX_GROUP_BUFFER) groupBuffer.shift();
      return;
    }

    // --- GROUP messages: triage before responding ---
    let directlyAddressed = false;
    if (msg.chatType === "group") {
      groupBuffer.push({ from: fromLabel, text: expandedText, timestamp: msg.timestamp });
      if (groupBuffer.length > MAX_GROUP_BUFFER) groupBuffer.shift();

      const shouldRespond = await triageGroupMessage(ctx, msg, groupBuffer);
      if (!shouldRespond) return;
      directlyAddressed = true; // triage only passes on direct mention/quote/tag
      ctx.log(`Group: decided to respond to ${fromLabel}`);
    }

    // --- Respond using Pi Agent ---
    ctx.log(`${msg.chatType} from ${fromLabel}: ${expandedText.slice(0, 80)}`);
    await bridge.sendTyping?.(msg.from.phone || msg.from.id, msg.groupId);

    const memoryContext = await ctx.memory.assembleConversationContext(
      expandedText,
      msg.from.name || undefined,
      msg.from.phone || undefined,
    );

    let systemPrompt = await buildSystemPrompt(ctx, memoryContext, msg.chatType === "group");

    // Build conversation history from today's log
    // For DMs: filter to only exchanges with this person
    // For groups: include all recent exchanges
    const todayLog = await ctx.memory.readTodayLog();
    const recentExchanges = extractRecentExchanges(
      todayLog,
      10,
      msg.chatType as "dm" | "group",
      msg.chatType === "dm" ? fromLabel : undefined,
    );

    const userContent = msg.chatType === "group"
      ? `[Recent group conversation]\n${groupBuffer.slice(-15).map(m => `${m.from}: ${m.text}`).join("\n")}\n\n[Latest message from ${fromLabel}]\n${expandedText}`
      : expandedText;

    // Process attachments (images → vision, audio → transcription)
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    let voiceTranscription = "";
    if (msg.attachments?.length) {
      const { processAttachments } = await import("../../core/attachments.js");
      const processed = await processAttachments(msg.attachments as any, fromLabel);
      images.push(...processed.images);
      if (processed.transcriptions.length > 0) {
        voiceTranscription = processed.transcriptions.join(" ");
      }
      for (const log of processed.logs) {
        if (log.startsWith("memory:")) {
          await ctx.memory.appendLog(log.slice(7));
        } else {
          ctx.log(log);
        }
      }
    }

    // Prepend voice transcription to user content
    let finalUserContent = userContent;
    if (voiceTranscription) {
      finalUserContent = expandedText
        ? `${expandedText}\n\n[Voice message transcription]: ${voiceTranscription}`
        : `[Voice message]: ${voiceTranscription}`;
    }

    // If images are attached, tell the model they're already visible (no need for view_image)
    if (images.length > 0) {
      systemPrompt += `\n\nThe user has sent ${images.length} image(s) with this message. You can already see them — do NOT use the view_image tool, the images are already in your context.`;
    }

    // Create Pi Agent for this conversation turn
    const agent = new Agent({
      initialState: { model: ctx.model, systemPrompt },
      getApiKey: () => ctx.apiKey,
    });
    // Filter tools to the conversation.md whitelist. Empty whitelist =
    // spec didn't load → fall back to all tools so the bot stays usable.
    const rawAllowedTools = conversationToolNames.length > 0
      ? filterToolsByWhitelist(ctx.tools, conversationToolNames)
      : ctx.tools;
    // Group-post gate: only the group where this triaged direct-address
    // came in is whitelisted for `send_group_message`. All other season
    // groups (and DMs that try to splash into a group) are blocked at
    // the tool layer with a clear error pointing the agent toward DMs.
    const allowGroupId = (msg.chatType === "group" && directlyAddressed && msg.groupId) ? msg.groupId : null;
    const allowedTools = wrapNoSpontaneousGroupPosts(rawAllowedTools, allowGroupId);
    agent.setTools(allowedTools);

    // Seed with recent exchanges
    for (const ex of recentExchanges) {
      agent.appendMessage({
        role: ex.role,
        content: [{ type: "text", text: ex.content }],
        timestamp: Date.now(),
      });
    }

    // Collect response
    let response = "";
    const radioActions: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        response += event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_start") {
        ctx.log(`Tool: ${event.toolName}(${JSON.stringify(event.args)})`);
        if (event.toolName.startsWith("radio.") || event.toolName === "radio_broadcast") {
          radioActions.push(`${event.toolName}(${JSON.stringify(event.args)})`);
        }
      }
      if (event.type === "tool_execution_end") {
        const resultText = event.result?.content?.map((c: any) => c.text || "").join("") || JSON.stringify(event.result);
        ctx.log(`Result: ${event.toolName} → ${resultText}`);
      }
    });

    await agent.prompt(finalUserContent, images.length > 0 ? images : undefined);
    await agent.waitForIdle();

    // Treat bare status markers as silence. The model sometimes emits
    // `[SENT]`, `[DONE]`, `[OK]`, etc. after calling a send_* tool as a
    // note-to-self that the action completed. Those are NOT meant to be
    // posted — treat them the same as `[silent]`.
    const STATUS_MARKER_RX = /^\s*\[(?:silent|sent|done|ok|complete|no[\s_-]?reply|nothing|n\/a)\]\s*$/i;
    response = response.replace(/\[silent\]/gi, "").trim();
    if (STATUS_MARKER_RX.test(response)) {
      ctx.log(`Stripping bare status marker: ${response}`);
      response = "";
    }
    if (!response) {
      if (msg.chatType === "group" && !directlyAddressed) {
        ctx.log("Decided to stay silent.");
        return;
      }
      // Directly addressed or DM but empty — give it a second chance
      ctx.log("Empty response on direct address, retrying...");
      await agent.prompt(conversationSections.directAddressRetry ?? "");
      await agent.waitForIdle();
      response = response.replace(/\[silent\]/gi, "").trim();
      if (STATUS_MARKER_RX.test(response)) {
        ctx.log(`Stripping bare status marker on retry: ${response}`);
        response = "";
      }
      if (!response) {
        ctx.log("Chose silence even on direct address.");
        return;
      }
    }

    // Strip leaked internal tags and self-prefix from response
    response = response.replace(/^\[(?:group|dm)\]\s*/i, "").trim();
    response = response.replace(/^Feyblet:\s*/i, "").trim();

    const replyTag = msg.chatType === "group" ? "(group)" : `(dm to ${fromLabel})`;
    await ctx.memory.appendLog(`**Feyblet** ${replyTag}: ${response}`);
    ctx.log(`Response: ${response.slice(0, 300)}`);

    // Quote-reply when answering a directly-addressed group message.
    // Signal threads the reply to the original message so it's visible
    // who feyblet is responding to. DMs don't need quoting; nudge-driven
    // group sends never use this path (they go through the wrapped
    // send_group_message tool).
    const quoteFields = (msg.chatType === "group" && directlyAddressed)
      ? {
          quoteTimestamp: msg.id,
          quoteAuthorUuid: msg.from.id,
          quoteText: expandedText.slice(0, 500),
        }
      : {};

    await bridge.send({
      to: msg.from.phone || msg.from.id,
      text: response,
      groupId: msg.groupId,
      ...quoteFields,
    });

    recordEvent({
      type: "chat_message",
      direction: "out",
      chat: msg.chatType,
      from: "feyblet",
      to: fromLabel,
      text: response,
      groupId: msg.groupId,
    });

    ctx.log(`Replied to ${fromLabel}`);

    // Log radio actions so the radio module knows what conversation did
    if (radioActions.length > 0) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const logPath = path.join(ctx.memory.workspacePath, "radio", "log.md");
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      const entry = `\n## ${timestamp}\n\n**Via chat (${fromLabel}):** ${radioActions.join(" → ")}\n`;
      await fs.appendFile(logPath, entry, "utf-8");
    }

    // Detect coordination-heavy DMs and write to active-threads for executive awareness
    if (msg.chatType === "dm") {
      const coordKeywords = /coordinat|plan|organiz|schedul|follow.?up|remind me|let.?s.*together|can you.*help.*with/i;
      if (coordKeywords.test(expandedText) || coordKeywords.test(response)) {
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const threadsPath = path.join(ctx.memory.workspacePath, "inner", "active-threads.md");
          const now = new Date();
          const dateStr = now.toISOString().slice(0, 10);
          const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
          const threadEntry = `\n## ${fromLabel} (${dateStr} ${timeStr})\n${expandedText.slice(0, 200)}\nFeyblet responded: ${response.slice(0, 200)}\n`;
          await fs.mkdir(path.dirname(threadsPath), { recursive: true });
          await fs.appendFile(threadsPath, threadEntry, "utf-8");
          ctx.log(`Active thread logged: ${fromLabel}`);
        } catch {}
      }
    }
  };
}

// --- Group Message Triage ---

async function triageGroupMessage(
  _ctx: ModuleContext,
  msg: InboundMessage,
  _recentMessages: Array<{ from: string; text: string }>,
): Promise<boolean> {
  const text = msg.text.toLowerCase();

  // Only respond when directly mentioned by name, @tagged, or quoted
  if (FEYBLET_NAMES.some((name) => text.includes(name))) return true;
  if (msg.mentions?.some((m) => m.uuid === FEYBLET_UUID)) return true;
  if (msg.quotedAuthorUuid === FEYBLET_UUID) return true;

  return false;

  // --- LLM triage (disabled — reactivate later) ---
  // const recentContext = _recentMessages.slice(-8).map(m => `${m.from}: ${m.text}`).join("\n");
  //
  // const decision = await completeText(_ctx.model, {
  //   system: `You are Feyblet's triage process. Decide whether Feyblet should respond. Be VERY selective.
  //
  // Respond YES only if:
  // - Someone is directly asking Feyblet something
  // - Someone asks about sauna, bookings, arrivals, or onboarding
  // - There's a natural opening where Feyblet has something genuinely valuable to add
  //
  // Respond NO for: normal chat, jokes, banter, questions to other people, anything where Feyblet has nothing unique to contribute.
  //
  // Output ONLY YES or NO.`,
  //   messages: [{
  //     role: "user",
  //     content: `Recent:\n${recentContext}\n\nLatest from ${msg.from.name || msg.from.id}:\n${msg.text}\n\nShould Feyblet respond?`,
  //   }],
  //   temperature: 0.1,
  //   maxTokens: 8,
  //   apiKey: _ctx.apiKey,
  // });
  //
  // return decision.trim().toUpperCase().startsWith("YES");
}

// --- System Prompt ---

async function buildSystemPrompt(ctx: ModuleContext, memoryContext: string, isGroup: boolean): Promise<string> {
  const vars = await standardVars(ctx, { memoryContext, isGroup });
  return render(conversationTemplate, vars);
}

// --- Helpers ---

function extractRecentExchanges(
  todayLog: string | null,
  maxExchanges: number,
  chatType: "dm" | "group",
  filterSender?: string,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!todayLog) return [];

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const sections = todayLog.split(/^## \d{2}:\d{2}:\d{2}/m).filter(Boolean);

  for (const section of sections.slice(-maxExchanges * 2)) {
    const trimmed = section.trim();
    // Include image/voice entries in exchange history, skip other internal entries
    if (trimmed.startsWith("*[")) {
      if (trimmed.startsWith("*[Image from") || trimmed.startsWith("*[Voice from")) {
        // Append to last user message if it matches the current person
        if (filterSender && trimmed.toLowerCase().includes(filterSender.toLowerCase()) && messages.length > 0) {
          messages[messages.length - 1].content += `\n${trimmed}`;
        }
      }
      continue;
    }

    if (trimmed.startsWith("**Feyblet**")) {
      // Filter feyblet responses by recipient in DM mode
      if (filterSender) {
        // Only include responses tagged to this person, or untagged (legacy)
        const dmToMatch = trimmed.match(/^\*\*Feyblet\*\*\s*\(dm to ([^)]+)\)/);
        if (dmToMatch && dmToMatch[1] !== filterSender) continue;
        const groupMatch = trimmed.match(/^\*\*Feyblet\*\*\s*\(group/);
        if (groupMatch) continue; // skip group responses in DM context
      }
      if (chatType === "group") {
        const dmToMatch = trimmed.match(/^\*\*Feyblet\*\*\s*\(dm to/);
        if (dmToMatch) continue; // skip DM responses in group context
      }
      const content = trimmed.replace(/^\*\*Feyblet\*\*\s*(?:\([^)]*\))?\s*:\s*/, "");
      messages.push({ role: "assistant", content });
    } else {
      const match = trimmed.match(/^\*\*([^*]+)\*\*\s*\(([^)]*)\):\s*([\s\S]+)/);
      if (match) {
        const name = match[1];
        const context = match[2];
        const text = match[3].trim();
        const isGroup = context.includes("group");

        // DMs: only include exchanges with this specific person
        if (filterSender && name !== filterSender) continue;
        // Groups: exclude DM exchanges to avoid leaking private conversations
        if (chatType === "group" && !isGroup) continue;

        const tag = isGroup ? "[group]" : "[dm]";
        messages.push({ role: "user", content: `${tag} ${name}: ${text}` });
      }
    }
  }

  // Ensure starts with user turn
  while (messages.length > 0 && messages[0].role === "assistant") messages.shift();
  return messages.slice(-maxExchanges);
}

async function detectAndLogSeason(
  ctx: ModuleContext,
  text: string,
  from: string,
): Promise<void> {
  if (text.length < 30) return;
  const seasonLog = ctx.tools.find((t: any) => t.name === "season_log");
  if (!seasonLog) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const classification = await ctx.llm.complete({
    system: `Classify this group chat message. If it announces a meal/menu, event/workshop/activity, or party, output EXACTLY one line in format: CATEGORY: description
Categories: meals, events, parties, crispy
If it's just normal chat or not an announcement, output: NONE
CRITICAL: ALL times in your description MUST be absolute 24h format (e.g. "at 17:30"). Convert: "in 5 minutes" at ${timeStr} → "at ${timeStr}+5min", "tonight" → "at 21:00", "after dinner" → "at 21:30", "now" → "at ${timeStr}", "tomorrow" → "tomorrow YYYY-MM-DD". Never output relative times.
Output ONLY the classification line, nothing else.`,
    messages: [{ role: "user", content: `From ${from}: ${text}` }],
    temperature: 0.1,
    maxTokens: 100,
  });

  const trimmed = classification.trim();
  if (trimmed === "NONE" || trimmed.startsWith("NONE")) return;

  const match = trimmed.match(/^(meals|events|parties|crispy):\s*(.+)/i);
  if (match) {
    const category = match[1].toLowerCase();
    const entry = match[2].trim();

    // LLM dedup check — read today's entries and ask if this is already covered
    const categories: Record<string, string> = { events: "season/events.md", parties: "season/parties.md", meals: "season/meals.md", crispy: "season/crispy.md" };
    const today = new Date().toISOString().slice(0, 10);
    try {
      const content = await ctx.memory.readFile(categories[category]);
      if (content) {
        const todayEntries = content.split("\n").filter((l: string) => l.includes(today));
        if (todayEntries.length > 0) {
          const dupCheck = await ctx.llm.complete({
            system: `Is this new entry already covered by one of the existing entries? Answer YES or NO only.`,
            messages: [{ role: "user", content: `New: ${entry}\n\nExisting today:\n${todayEntries.join("\n")}` }],
            temperature: 0,
            maxTokens: 5,
          });
          if (dupCheck.trim().toUpperCase().startsWith("YES")) {
            ctx.log(`Season dedup [${category}]: "${entry.slice(0, 60)}" already covered`);
            return;
          }
        }
      }
    } catch {}

    await seasonLog.execute("auto", { category, entry: `${entry} (announced by ${from})` });
    ctx.log(`Season logged [${category}]: ${entry.slice(0, 60)}`);
  }
}

// --- Module Nudge Handler ---

async function handleModuleNudge(
  ctx: ModuleContext,
  moduleMsg: { from: string; content: string },
): Promise<void> {
  // The chat adapter isn't passed in: nudges resolve through the
  // workspace's send_dm / send_group_message tools (which the agent
  // picks up from the registered tool list) rather than bypassing the
  // tool layer.
  ctx.log(`Handling nudge from ${moduleMsg.from}: ${moduleMsg.content.slice(0, 120)}`);

  // Assemble context for the agent
  const memoryContext = await ctx.memory.assembleConversationContext(moduleMsg.content);
  const systemPrompt = await buildSystemPrompt(ctx, memoryContext, false);

  const agent = new Agent({
    initialState: { model: ctx.model, systemPrompt },
    getApiKey: () => ctx.apiKey,
  });

  // Give conversation its filtered tools (same fallback as the main path).
  const rawAllowedTools = conversationToolNames.length > 0
    ? filterToolsByWhitelist(ctx.tools, conversationToolNames)
    : ctx.tools;
  // Module nudges never come with a triaged direct-address-in-group
  // context, so allowGroupId is always null here — every season-group
  // post attempt from a sibling part is blocked.
  const allowedTools = wrapNoSpontaneousGroupPosts(rawAllowedTools, null);
  agent.setTools(allowedTools);

  let response = "";
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      response += event.assistantMessageEvent.delta;
    }
    if (event.type === "tool_execution_start") {
      ctx.log(`Nudge tool: ${event.toolName}(${JSON.stringify(event.args).slice(0, 100)})`);
    }
  });

  // Craft a prompt that gives the agent the nudge context
  const isGroupNudge = moduleMsg.content.startsWith("send_group:");
  const isDMNudge = moduleMsg.content.startsWith("send_dm:");
  let nudgeCheck = "";
  if (isGroupNudge) {
    nudgeCheck = `\n\nThis is asking you to post in the group chat. Think about whether this is genuinely worth sharing with everyone — has someone already said it? Is it outdated? Is it something better handled as a DM? We all care about not spamming the group. If in doubt, [SILENT].`;
  } else if (isDMNudge) {
    nudgeCheck = `\n\nBefore acting, use chat_history to check your recent DM history with this person. If you've already sent them something similar, or they asked you to stop, say [SILENT].`;
  }
  const prompt = `Another part of you (the ${moduleMsg.from} module) sent you this message:\n\n"${moduleMsg.content}"\n\nAct on it in your own voice. If it asks you to DM someone, craft the message. If you don't think it's worth acting on, say [SILENT].${nudgeCheck}`;

  await agent.prompt(prompt);
  await agent.waitForIdle();

  response = response.replace(/\[silent\]/gi, "").trim();
  if (!response) {
    ctx.log(`Nudge from ${moduleMsg.from}: chose not to act`);
    return;
  }

  // Determine what to do with the response
  if (moduleMsg.content.startsWith("send_dm:")) {
    // Extract the target person from the nudge content
    const toMatch = moduleMsg.content.match(/to['":\s]+(\w[\w\s]*?)['",\}]/);
    const to = toMatch?.[1]?.trim();
    if (to) {
      const person = await ctx.memory.findPerson(to);
      if (person) {
        // TODO: resolve to Signal ID and send — for now log
        ctx.log(`Nudge DM to ${to}: ${response.slice(0, 100)}`);
        await ctx.memory.appendLog(`**Feyblet** (dm to ${to}, via ${moduleMsg.from}): ${response}`);
      }
    }
  } else if (moduleMsg.content.startsWith("send_group:")) {
    ctx.log(`Nudge group message: ${response.slice(0, 100)}`);
    await ctx.memory.appendLog(`**Feyblet** (group, via ${moduleMsg.from}): ${response}`);
    // TODO: send to group via bridge
  } else {
    // Generic request — just log what the agent decided
    ctx.log(`Nudge response (${moduleMsg.from}): ${response.slice(0, 100)}`);
    await ctx.memory.appendLog(`**Feyblet** (via ${moduleMsg.from}): ${response}`);
  }
}

// --- Known Groups Tracker ---

const knownGroups = new Map<string, string>();

async function trackKnownGroup(workspacePath: string, groupId: string, groupName: string): Promise<void> {
  if (knownGroups.get(groupId) === groupName) return; // already tracked
  knownGroups.set(groupId, groupName);

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath = path.join(workspacePath, "community", "known-groups.md");

  const lines = [`# Signal Groups\n`];
  for (const [id, name] of knownGroups) {
    lines.push(`- **${name}**: \`${id}\``);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Capture Signal UUID + phone to a person's profile file. */
const capturedUuids = new Set<string>();
async function captureSignalUuid(ctx: ModuleContext, name: string, uuid: string, phone?: string | null): Promise<void> {
  if (capturedUuids.has(uuid)) return; // already done this session
  capturedUuids.add(uuid);

  const person = await ctx.memory.findPerson(name, phone || undefined);
  if (!person) return;

  // Check if THIS uuid is already in the file — early exit only when the
  // exact same uuid is already present. A placeholder string or some
  // OTHER uuid (e.g. account changed) is treated as "needs update."
  if (person.content.includes(uuid)) return;

  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const filePath = pathMod.join(ctx.memory.workspacePath, "people", `${person.slug}.md`);

  let content = person.content;

  // Frontmatter UUID handling: add if missing, replace if present-but-invalid.
  // The previous version only added when missing, so files seeded with
  // `signal-uuid: "placeholder-uuid-needed"` (or any other malformed value)
  // never got upgraded to the real uuid even after the person posted in a
  // group we're in.
  const VALID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const existingMatch = content.match(/signal-uuid:\s*["']?([\w-]+)["']?/);
  const existingUuid = existingMatch?.[1];
  if (!existingUuid) {
    content = content.replace(/^(---\n)/, `$1signal-uuid: "${uuid}"\n`);
  } else if (!VALID_UUID.test(existingUuid)) {
    content = content.replace(existingMatch![0], `signal-uuid: "${uuid}"`);
  }

  // Add phone to frontmatter if missing and available
  if (phone && !content.includes("phone:")) {
    content = content.replace(/^(---\n)/, `$1phone: "${phone}"\n`);
  }

  if (content !== person.content) {
    await fs.writeFile(filePath, content, "utf-8");
  }
}
