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
import { Agent } from "@mariozechner/pi-agent-core";
import { filterToolsByWhitelist } from "../../../src/mcp/bridge.js";
import { parseFrontmatter } from "../../../src/modules/load-modules.js";
import { parseSections, render } from "../../../src/core/prompt-template.js";
import { standardVars } from "../../../src/core/prompt-vars.js";
import { recordEvent } from "../../../src/core/event-log.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FEYBLET_NAMES = ["feyblet", "feyby", "feybling", "feybient", "feytus", "feyble", "symbient", "simbient", "radio host"];
const FEYBLET_UUID = process.env.FEYBLET_UUID || "26876cef-04fb-4292-b35e-c4ef9194b064";

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
    const SEASON_GROUP = "aX/mc0Cl/SsJQp6ngVqbBL/NYJi0FanGsqn7HMo9Lw4=";
    let groupTag = "";
    if (msg.groupId === SEASON_GROUP) groupTag = ", season";
    else if (msg.groupId) groupTag = ", group";

    // Track known groups so the feyblet can look them up when needed
    if (msg.groupId && msg.groupName) {
      trackKnownGroup(ctx.memory.workspacePath, msg.groupId, msg.groupName).catch(() => {});
    }
    const imageNote = msg.attachments?.filter(a => a.contentType?.startsWith("image/")).length
      ? ` [+${msg.attachments.filter(a => a.contentType?.startsWith("image/")).length} image(s)]`
      : "";
    await ctx.memory.appendLog(
      `**${fromLabel}** (${msg.chatType}${groupTag}): ${msg.text || "(image)"}${imageNote}`,
    );

    // --- Capture Signal UUID to person file ---
    if (msg.from.id && msg.from.name && !msg.from.id.startsWith("+")) {
      captureSignalUuid(ctx, msg.from.name, msg.from.id, msg.from.phone).catch(() => {});
    }

    // --- Silent season logging ---
    if (msg.chatType === "group") {
      detectAndLogSeason(ctx, msg.text, fromLabel).catch((err) => {
        ctx.log(`Season detect error: ${err}`);
      });
    }

    // --- State triggers from chat ---
    const textLower = msg.text.toLowerCase();
    if (textLower.includes("party mode") || textLower.includes("party time")) {
      await (ctx.memory as any).setState("party-mode", true);
      ctx.log("Party mode activated via chat!");
    }

    // --- Silent groups: observe only, never respond ---
    if (msg.chatType === "group" && msg.groupId && SILENT_GROUPS.has(msg.groupId)) {
      groupBuffer.push({ from: fromLabel, text: msg.text, timestamp: msg.timestamp });
      if (groupBuffer.length > MAX_GROUP_BUFFER) groupBuffer.shift();
      return;
    }

    // --- GROUP messages: triage before responding ---
    let directlyAddressed = false;
    if (msg.chatType === "group") {
      groupBuffer.push({ from: fromLabel, text: msg.text, timestamp: msg.timestamp });
      if (groupBuffer.length > MAX_GROUP_BUFFER) groupBuffer.shift();

      const shouldRespond = await triageGroupMessage(ctx, msg, groupBuffer);
      if (!shouldRespond) return;
      directlyAddressed = true; // triage only passes on direct mention/quote/tag
      ctx.log(`Group: decided to respond to ${fromLabel}`);
    }

    // --- Respond using Pi Agent ---
    ctx.log(`${msg.chatType} from ${fromLabel}: ${msg.text.slice(0, 80)}`);
    await bridge.sendTyping?.(msg.from.phone || msg.from.id, msg.groupId);

    const memoryContext = await ctx.memory.assembleConversationContext(
      msg.text,
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
      ? `[Recent group conversation]\n${groupBuffer.slice(-15).map(m => `${m.from}: ${m.text}`).join("\n")}\n\n[Latest message from ${fromLabel}]\n${msg.text}`
      : msg.text;

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
      finalUserContent = msg.text
        ? `${msg.text}\n\n[Voice message transcription]: ${voiceTranscription}`
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
    const allowedTools = conversationToolNames.length > 0
      ? filterToolsByWhitelist(ctx.tools, conversationToolNames)
      : ctx.tools;
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

    await bridge.send({
      to: msg.from.phone || msg.from.id,
      text: response,
      groupId: msg.groupId,
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
      if (coordKeywords.test(msg.text) || coordKeywords.test(response)) {
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const threadsPath = path.join(ctx.memory.workspacePath, "inner", "active-threads.md");
          const now = new Date();
          const dateStr = now.toISOString().slice(0, 10);
          const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
          const threadEntry = `\n## ${fromLabel} (${dateStr} ${timeStr})\n${msg.text.slice(0, 200)}\nFeyblet responded: ${response.slice(0, 200)}\n`;
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
  const allowedTools = conversationToolNames.length > 0
    ? filterToolsByWhitelist(ctx.tools, conversationToolNames)
    : ctx.tools;
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

  // Check if UUID already in file
  if (person.content.includes(`signal-uuid:`) && person.content.includes(uuid)) return;

  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const filePath = pathMod.join(ctx.memory.workspacePath, "people", `${person.slug}.md`);

  let content = person.content;

  // Add signal-uuid to frontmatter if missing
  if (!content.includes("signal-uuid:")) {
    content = content.replace(/^(---\n)/, `$1signal-uuid: "${uuid}"\n`);
  }

  // Add phone to frontmatter if missing and available
  if (phone && !content.includes("phone:")) {
    content = content.replace(/^(---\n)/, `$1phone: "${phone}"\n`);
  }

  if (content !== person.content) {
    await fs.writeFile(filePath, content, "utf-8");
  }
}
