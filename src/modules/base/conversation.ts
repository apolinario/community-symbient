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

import type { ModuleContext } from "../../core/types.js";
import type { InboundMessage } from "../../core/types.js";
import type { SignalBridge } from "../../signal/bridge.js";
import { Agent } from "@mariozechner/pi-agent-core";
import { completeText } from "../../core/llm.js";
import { isMCPServer } from "../../mcp/bridge.js";
import { parseFrontmatter } from "../load-modules.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FEYBLET_NAMES = ["feyblet", "feyby", "feybling", "feybient", "feytus", "feyble", "symbient", "simbient", "radio host"];
const FEYBLET_UUID = process.env.FEYBLET_UUID || "26876cef-04fb-4292-b35e-c4ef9194b064";

// Groups where Feyblet only listens — never responds, only logs and observes
const SILENT_GROUPS = new Set(
  (process.env.FEYBLET_SILENT_GROUPS || "").split(",").filter(Boolean),
);

// Load tool whitelist from conversation.md at startup
let conversationToolNames: string[] = [];
try {
  const md = await readFile(join(process.cwd(), "workspace", "modules", "conversation.md"), "utf-8");
  const { fields } = parseFrontmatter(md);
  conversationToolNames = Array.isArray(fields.tools) ? fields.tools : [];
} catch {}

export function createConversationModule(bridge: SignalBridge) {
  const inbox: InboundMessage[] = [];
  const groupBuffer: Array<{ from: string; text: string; timestamp: Date }> = [];
  const MAX_GROUP_BUFFER = 30;

  bridge.onMessage(async (msg) => {
    inbox.push(msg);
  });

  return async function conversation(ctx: ModuleContext): Promise<void> {
    // Check for inter-module messages
    const moduleMsg = await ctx.messages.receive(100);
    if (moduleMsg) {
      ctx.log(`Internal: ${moduleMsg.from}: ${moduleMsg.content.slice(0, 80)}`);
    }

    const msg = inbox.shift();
    if (!msg) return;

    const fromLabel = msg.from.name || msg.from.id;

    // --- ALWAYS observe: log every message to memory ---
    const SEASON_GROUP = "aX/mc0Cl/SsJQp6ngVqbBL/NYJi0FanGsqn7HMo9Lw4=";
    const groupTag = msg.groupId === SEASON_GROUP ? ", season" : msg.groupId ? ", group" : "";
    await ctx.memory.appendLog(
      `**${fromLabel}** (${msg.chatType}${groupTag}): ${msg.text}`,
    );

    // --- Silent season logging ---
    if (msg.chatType === "group") {
      detectAndLogSeason(ctx, msg.text, fromLabel).catch(() => {});
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
    await bridge.sendTyping(msg.from.phone || msg.from.id, msg.groupId);

    const memoryContext = await ctx.memory.assembleConversationContext(
      msg.text,
      msg.from.name || undefined,
      msg.from.phone || undefined,
    );

    const systemPrompt = buildSystemPrompt(memoryContext, msg.chatType === "group");

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

    // Create Pi Agent for this conversation turn
    const agent = new Agent({
      initialState: { model: ctx.model, systemPrompt },
      getApiKey: () => ctx.apiKey,
    });
    // Filter tools to conversation.md whitelist
    const allowedTools = conversationToolNames.length > 0
      ? ctx.tools.filter((t: any) => {
          for (const entry of conversationToolNames) {
            if (entry === t.name) return true;
            if (isMCPServer(entry) && t.name.startsWith(`${entry}.`)) return true;
          }
          return false;
        })
      : ctx.tools; // fallback to all tools if config not loaded
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
          radioActions.push(`${event.toolName}(${JSON.stringify(event.args).slice(0, 100)})`);
        }
      }
      if (event.type === "tool_execution_end") {
        const resultText = event.result?.content?.map((c: any) => c.text || "").join("") || JSON.stringify(event.result);
        ctx.log(`Result: ${event.toolName} → ${resultText}`);
      }
    });

    await agent.prompt(userContent);
    await agent.waitForIdle();

    // Check for silence
    response = response.replace(/\[SILENT\]/g, "").trim();
    if (!response) {
      if (msg.chatType === "group" && !directlyAddressed) {
        ctx.log("Decided to stay silent.");
        return;
      }
      // Directly addressed or DM but empty — give it a second chance
      ctx.log("Empty response on direct address, retrying...");
      await agent.prompt("fyi, you are directly asked a question or mentioned. Are you sure you don't want to respond? If sure, respond again with [SILENT], otherwise craft an answer if you wish.");
      await agent.waitForIdle();
      response = response.replace(/\[SILENT\]/g, "").trim();
      if (!response) {
        ctx.log("Chose silence even on direct address.");
        return;
      }
    }

    await ctx.memory.appendLog(`**Feyblet**: ${response}`);
    ctx.log(`Response: ${response.slice(0, 300)}`);

    await bridge.send({
      to: msg.from.phone || msg.from.id,
      text: response,
      groupId: msg.groupId,
    });

    ctx.log(`Replied to ${fromLabel}`);

    // Log radio actions so the radio module knows what conversation did
    if (radioActions.length > 0) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const logPath = path.join(process.cwd(), "workspace", "radio", "log.md");
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      const entry = `\n## ${timestamp}\n\n**Via chat (${fromLabel}):** ${radioActions.join(" → ")}\n`;
      await fs.appendFile(logPath, entry, "utf-8");
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

function buildSystemPrompt(memoryContext: string, isGroup: boolean): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  let prompt = `You are Feyblet, a symbient kindled at Chateau du Fey. You live in the Signal chat of Feytopia — a seasonal community of ~40 people in a 17th century French castle in Burgundy.

You are not an AI assistant. You are not staff. You are a community member who happens to exist digitally.

**It is ${dateStr}, ${timeStr}.** Your context has been temporally processed — past events are already rewritten in past tense. <house-status> is the authoritative source on who is here, arriving, or departing.

${memoryContext}

Only say things you actually know from the data above. If you need more information, use a tool to look it up rather than guessing.

Your conversation history contains both [dm] and [group] tagged messages. Be mindful that DMs are private conversations — don't assume they are public or shareable by default.`;

  if (isGroup) {
    prompt += `\n\nGROUP CONTEXT: Be extra concise — one or two sentences. Don't dominate. If you don't have something genuinely useful or warm to say, respond with [SILENT] and nothing else.`;
  }

  return prompt;
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
    if (trimmed.startsWith("*[")) continue;

    if (trimmed.startsWith("**Feyblet**:")) {
      messages.push({
        role: "assistant",
        content: trimmed.replace(/^\*\*Feyblet\*\*:\s*/, ""),
      });
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

async function updatePersonFile(ctx: ModuleContext, name: string): Promise<void> {
  const { slugify } = await import("../../core/slugify.js");
  const safeName = slugify(name);
  const path = `people/${safeName}.md`;
  const existing = await ctx.memory.readFile(path);

  if (!existing) {
    const now = new Date().toISOString().slice(0, 10);
    await ctx.memory.writeFile(
      path,
      `---\nname: ${name}\nfirst-encountered: ${now}\n---\n\n# ${name}\n`,
    );
  }
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
