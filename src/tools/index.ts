/**
 * Feyblet Tools — Pi Agent SDK native tools.
 *
 * All tools use Pi's AgentTool interface with TypeBox schemas
 * for typed, validated parameters. The Pi Agent handles the
 * tool execution loop automatically — no text parsing needed.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../memory/manager.js";
import type { MQTTBus } from "../core/mqtt-bus.js";
import { recordEvent } from "../core/event-log.js";

const QMD_URL = process.env.QMD_URL || "http://localhost:8181";


// --- Person Lookup ---


// --- Memory Search ---

export function createSearchMemoryTool(): AgentTool {
  return {
    name: "search",
    description: "Search everything — memory, people profiles, past conversations, community knowledge, season history, onboarding docs, and more",
    label: "Search",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
    }),
    execute: async (_id, params) => {
      try {
        const res = await fetch(`${QMD_URL}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            searches: [
              { type: "vec", query: params.query.replace(/\n/g, " ").trim() },
              { type: "lex", query: params.query.replace(/\n/g, " ").trim() },
            ],
            collections: ["feyblet"],
            limit: 10,
            maxPerFile: 5,
            rerank: true,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { content: [{ type: "text", text: "Memory search unavailable." }], details: {} };
        const data = (await res.json()) as { results?: Array<{ title: string; file: string; snippet: string; score: number; docid: string }> };
        const results = data.results ?? [];
        if (results.length === 0) return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: {} };

        const text = results
          .map((r) => `**${r.title}** (${r.file}, ${Math.round(r.score * 100)}%)\n${r.chunk || r.snippet}`)
          .join("\n\n");
        return { content: [{ type: "text", text }], details: {} };
      } catch {
        return { content: [{ type: "text", text: "Memory search unavailable." }], details: {} };
      }
    },
  };
}

// --- Read File (REMOVED — replaced by Pi's sandboxed `read` tool in pi-tools.ts) ---

// --- Load More Context ---

export function createChatHistoryTool(memory: MemoryManager): AgentTool {
  return {
    name: "chat_history",
    description: "Load conversation history. Without a name: lists who you've DMed recently. With a name: loads the DM thread with that person. Use to check what you've already said before sending another message.",
    label: "Chat History",
    parameters: Type.Object({
      person: Type.Optional(Type.String({ description: "Person name to load DM history with. Omit to see a list of recent DM contacts." })),
      count: Type.Optional(Type.Number({ description: "How many messages to load (default 20)" })),
    }),
    execute: async (_id, params) => {
      try {
        const fs = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const count = params.count || 20;

        // Read today + yesterday logs
        const today = new Date().toISOString().slice(0, 10);
        const logPath = pathMod.join(process.cwd(), "workspace", "memory", `${today}.md`);
        let log = "";
        try { log = await fs.readFile(logPath, "utf-8"); } catch {}
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        try {
          const yLog = await fs.readFile(pathMod.join(process.cwd(), "workspace", "memory", `${yesterday}.md`), "utf-8");
          log = yLog + "\n" + log;
        } catch {}

        if (!log) return { content: [{ type: "text", text: "No conversation logs found." }], details: {} };

        const lines = log.split("\n");

        if (!params.person) {
          // List recent DM contacts
          const contacts = new Map<string, number>();
          for (const line of lines) {
            const inbound = line.match(/^\*\*([^*]+)\*\*\s*\(dm/);
            if (inbound && inbound[1] !== "Feyblet") {
              contacts.set(inbound[1], (contacts.get(inbound[1]) || 0) + 1);
            }
            const outbound = line.match(/^\*\*Feyblet\*\*\s*\(dm to ([^)]+)\)/);
            if (outbound) {
              const name = outbound[1].replace(/, via .+/, "");
              contacts.set(name, (contacts.get(name) || 0) + 1);
            }
          }
          if (contacts.size === 0) return { content: [{ type: "text", text: "No DM conversations found." }], details: {} };

          const sorted = [...contacts.entries()].sort((a, b) => b[1] - a[1]);
          const list = sorted.map(([name, n]) => `${name} (${n} messages)`).join("\n");
          return { content: [{ type: "text", text: `Recent DM contacts:\n${list}\n\nCall chat_history with a person name to see their conversation.` }], details: {} };
        }

        // Resolve person name via fuzzy matching
        const person = await memory.findPerson(params.person);
        const matchName = person ? person.content.match(/^name:\s*(.+)/m)?.[1]?.trim() : null;
        const searchNames = [params.person.toLowerCase()];
        if (matchName) searchNames.push(matchName.toLowerCase());

        const entries: string[] = [];
        for (const line of lines) {
          const lower = line.toLowerCase();
          const isDM = line.match(/^\*\*([^*]+)\*\*\s*\(dm/) || line.match(/^\*\*Feyblet\*\*\s*\(dm to/);
          if (isDM && searchNames.some(n => lower.includes(n))) {
            entries.push(line);
          }
        }

        if (entries.length === 0) {
          return { content: [{ type: "text", text: `No DM history with "${params.person}"${matchName ? ` (matched: ${matchName})` : ""}.` }], details: {} };
        }

        const header = matchName && matchName.toLowerCase() !== params.person.toLowerCase()
          ? `DM history with ${matchName} (matched from "${params.person}"):\n`
          : `DM history with ${params.person}:\n`;
        return { content: [{ type: "text", text: header + entries.slice(-count).join("\n") }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err}` }], details: {} };
      }
    },
  };
}

// --- Bookings ---


// --- Season Log ---


// --- Web Search (SearXNG) ---

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:4000";

export function createWebSearchTool(): AgentTool {
  return {
    name: "web_search",
    description: "Search the web for information. Use when you need to look up something beyond your memory — facts, events, people, music, news.",
    label: "Web Search",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
    }),
    execute: async (_id, params) => {
      try {
        const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(params.query)}&format=json&categories=general&language=en`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return { content: [{ type: "text", text: `Search failed: ${res.status}` }], details: {} };

        const data = await res.json() as any;
        const results = (data.results || []).slice(0, 5);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found." }], details: {} };
        }

        const formatted = results.map((r: any) =>
          `${r.title}\n${r.url}\n${r.content || ""}`.trim()
        ).join("\n\n");

        return { content: [{ type: "text", text: formatted }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Search error: ${err}` }], details: {} };
      }
    },
  };
}

// --- View Image (REMOVED — replaced by Pi's sandboxed `read` tool which handles images natively) ---

// --- Signal Messaging Tools ---

import type { ChatAdapter } from "../adapters/chat/types.js";

export function createSendDMTool(bridge: ChatAdapter, memory: MemoryManager): AgentTool {
  return {
    name: "send_dm",
    description: "Send a direct message to someone on Signal, optionally with an image attachment. Look up the person first to find their Signal ID.",
    label: "Send DM",
    parameters: Type.Object({
      to: Type.String({ description: "Person name — will be resolved to Signal ID via person lookup" }),
      message: Type.String({ description: "The message to send" }),
      image_path: Type.Optional(Type.String({ description: "Path to an image to attach, e.g. workspace/media/2026-04-08-sarah-123.jpeg" })),
    }),
    execute: async (_id, params) => {
      try {
        // Resolve person to Signal ID (phone or UUID from people file)
        const person = await memory.findPerson(params.to);
        if (!person) {
          return { content: [{ type: "text", text: `Could not find person "${params.to}". Try a different name.` }], details: {} };
        }

        // Extract phone or signal UUID from the person file
        const phoneMatch = person.content.match(/phone:\s*["']?(\+[\d\s]+)["']?/);
        const uuidMatch = person.content.match(/signal-uuid:\s*["']?([\w-]+)["']?/);
        const signalId = phoneMatch?.[1]?.replace(/\s/g, "") || uuidMatch?.[1];

        if (!signalId) {
          return { content: [{ type: "text", text: `Found ${params.to} but no Signal phone/UUID in their profile.` }], details: {} };
        }

        // Build attachments if image provided
        let attachments: string[] | undefined;
        if (params.image_path) {
          const fs = await import("node:fs/promises");
          const pathMod = await import("node:path");
          const fullPath = pathMod.join(process.cwd(), params.image_path);
          const buffer = await fs.readFile(fullPath);
          const ext = pathMod.extname(fullPath).slice(1);
          const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
          attachments = [`data:${mime};base64,${buffer.toString("base64")}`];
        }

        await bridge.send({ to: signalId, text: params.message, attachments });
        const imageNote = params.image_path ? ` [+image: ${params.image_path}]` : "";
        await memory.appendLog(`**Feyblet** (dm to ${params.to}): ${params.message}${imageNote}`);
        return { content: [{ type: "text", text: `DM sent to ${params.to}: "${params.message.slice(0, 100)}"${imageNote}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send DM: ${err}` }], details: {} };
      }
    },
  };
}

export function createSendGroupMessageTool(bridge: ChatAdapter, memory: MemoryManager): AgentTool {
  // Known groups cache — populated from workspace/community/known-groups.md
  const knownGroups = new Map<string, string>(); // name → id
  let loaded = false;
  // Dedup: track recent messages to prevent identical sends
  const recentMessages: string[] = [];

  async function loadKnownGroups() {
    if (loaded) return;
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const content = await fs.readFile(path.join(process.cwd(), "workspace", "community", "known-groups.md"), "utf-8");
      for (const match of content.matchAll(/\*\*(.+?)\*\*:\s*`(.+?)`/g)) {
        knownGroups.set(match[1].toLowerCase(), match[2]);
      }
      loaded = true;
    } catch {}
  }

  return {
    name: "send_group_message",
    description: "Send a message to a Signal group, optionally with an image. You can pass either the group ID or the group name.",
    label: "Send Group Message",
    parameters: Type.Object({
      group_id: Type.String({ description: "The Signal group ID or group name (e.g. 'FEŸTOPIA 2026 - Season 7')" }),
      message: Type.String({ description: "The message to send" }),
      image_path: Type.Optional(Type.String({ description: "Path to an image to attach" })),
    }),
    execute: async (_id, params) => {
      await loadKnownGroups();

      // Dedup: reject identical messages
      if (recentMessages.includes(params.message)) {
        return { content: [{ type: "text", text: `Duplicate message blocked — you just sent this. Not sending again.` }], details: {} };
      }

      // Resolve: if it doesn't look like a base64 ID, try to find it by name
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
        // Build attachments if image provided
        let attachments: string[] | undefined;
        if (params.image_path) {
          const fs = await import("node:fs/promises");
          const pathMod = await import("node:path");
          const fullPath = pathMod.join(process.cwd(), params.image_path);
          const buffer = await fs.readFile(fullPath);
          const ext = pathMod.extname(fullPath).slice(1);
          const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
          attachments = [`data:${mime};base64,${buffer.toString("base64")}`];
        }

        await bridge.send({
          to: "",
          text: params.message,
          groupId,
          attachments,
        });

        // Track for dedup
        recentMessages.push(params.message);
        if (recentMessages.length > 20) recentMessages.shift();

        const imageNote = params.image_path ? ` [+image]` : "";
        await memory.appendLog(`**Feyblet** (group): ${params.message}${imageNote}`);
        return { content: [{ type: "text", text: `Sent to group: "${params.message.slice(0, 100)}"${imageNote}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send: ${err}` }], details: {} };
      }
    },
  };
}

// --- Nudge Module (inter-module MQTT messaging) ---

export function createNudgeModuleTool(bus: MQTTBus, senderName: string): AgentTool {
  const client = bus.clientFor(`nudge-${senderName}`);
  return {
    name: "nudge_module",
    description: "Send a message to another module. Use to ask conversation to DM someone, ask radio to broadcast, ask the DJ to play something, ask the executive to schedule or follow up on something, or coordinate with any module.",
    label: "Nudge Module",
    parameters: Type.Object({
      module: Type.String({ description: "Target module: conversation, radio, radio-dj, executive, thinking, desire, etc." }),
      message: Type.String({ description: "What you want the module to do — it will wake up and act on this with its own judgment" }),
    }),
    execute: async (_id, params) => {
      await client.send(params.module, params.message);
      return { content: [{ type: "text", text: `Nudged ${params.module}: "${params.message.slice(0, 100)}"` }], details: {} };
    },
  };
}

// --- Schedule (messages to future self) ---

export function createScheduleTool(workspacePath: string): AgentTool {
  return {
    name: "schedule",
    description: "Schedule an action for your future self. When the time comes, you'll wake up and execute it immediately. Use `cron` for recurring patterns (preferred) or `when` for one-shot times.",
    label: "Schedule",
    parameters: Type.Object({
      when: Type.Optional(Type.String({ description: "One-shot time: ISO datetime, 'tomorrow 10:00', 'in 3h', 'at 18:30'. Use this OR cron, not both." })),
      cron: Type.Optional(Type.String({ description: "Cron expression for recurring schedules. Examples: '30 11 * * 1-5' (11:30 weekdays), '0 17 * * *' (17:00 daily), '0 9 * * 1' (9:00 Mondays). Format: min hour day month weekday." })),
      prompt: Type.String({ description: "The action to execute — be specific: 'Send a group message reminding everyone GGGG starts in 30 minutes at 12:00'" }),
      context: Type.Optional(Type.String({ description: "Background context for when the action fires" })),
      expires: Type.Optional(Type.String({ description: "When to stop recurring (ISO datetime). Only for cron schedules." })),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      if (!params.when && !params.cron) {
        return { content: [{ type: "text", text: "Provide either `when` (one-shot) or `cron` (recurring)." }], details: {} };
      }

      const schedulePath = path.join(workspacePath, "tasks", "scheduled.json");
      await fs.mkdir(path.dirname(schedulePath), { recursive: true });

      let schedule: any[] = [];
      try { schedule = JSON.parse(await fs.readFile(schedulePath, "utf-8")); } catch {}

      if (params.cron) {
        // Validate cron expression
        try {
          const { Cron } = await import("croner");
          const job = new Cron(params.cron);
          const next = job.nextRun();
          if (!next) {
            return { content: [{ type: "text", text: `Cron "${params.cron}" has no upcoming runs.` }], details: {} };
          }

          let expiresTime: string | null = null;
          if (params.expires) {
            const { parseTime } = await import("../core/time-parser.js");
            const t = await parseTime(params.expires);
            if (t) expiresTime = new Date(t).toISOString();
          }

          const entry = {
            id: `sched-${Date.now()}`,
            cron: params.cron,
            nextRun: next.getTime(),
            prompt: params.prompt,
            context: params.context || null,
            expires: expiresTime,
            created: new Date().toISOString(),
            done: false,
          };

          schedule.push(entry);
          await fs.writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");

          const nextStr = next.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
          return { content: [{ type: "text", text: `Cron scheduled (${params.cron}), next run: ${nextStr}. Action: "${params.prompt.slice(0, 100)}"` }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid cron expression "${params.cron}": ${err}` }], details: {} };
        }
      }

      // One-shot with `when`
      const { parseTime } = await import("../core/time-parser.js");
      const atTime = await parseTime(params.when!);
      if (!atTime) {
        return { content: [{ type: "text", text: `Could not parse time: "${params.when}". Try ISO datetime, "tomorrow 10:00", etc.` }], details: {} };
      }

      const entry = {
        id: `sched-${Date.now()}`,
        when: atTime,
        prompt: params.prompt,
        context: params.context || null,
        created: new Date().toISOString(),
        done: false,
      };

      schedule.push(entry);
      await fs.writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");

      const whenStr = new Date(atTime).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
      return { content: [{ type: "text", text: `Scheduled for ${whenStr}: "${params.prompt.slice(0, 100)}"` }], details: {} };
    },
  };
}

export function createListScheduleTool(workspacePath: string): AgentTool {
  return {
    name: "list_schedule",
    description: "View your scheduled future messages",
    label: "List Schedule",
    parameters: Type.Object({}),
    execute: async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const schedulePath = path.join(workspacePath, "tasks", "scheduled.json");

      let schedule: any[] = [];
      try { schedule = JSON.parse(await fs.readFile(schedulePath, "utf-8")); } catch {}

      const pending = schedule.filter((s: any) => !s.done);
      if (pending.length === 0) {
        return { content: [{ type: "text", text: "No scheduled items." }], details: {} };
      }

      const lines = pending.map((s: any) => {
        if (s.cron) {
          const nextStr = s.nextRun ? new Date(s.nextRun).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "computing...";
          return `[${s.id}] cron: ${s.cron} (next: ${nextStr}): ${s.prompt.slice(0, 100)}`;
        }
        const when = new Date(s.when).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        return `[${s.id}] ${when}: ${s.prompt.slice(0, 100)}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };
}

export function createCancelScheduleTool(workspacePath: string): AgentTool {
  return {
    name: "cancel_scheduled",
    description: "Cancel a scheduled item by ID",
    label: "Cancel Scheduled",
    parameters: Type.Object({
      id: Type.String({ description: "The schedule entry ID to cancel" }),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const schedulePath = path.join(workspacePath, "tasks", "scheduled.json");

      let schedule: any[] = [];
      try { schedule = JSON.parse(await fs.readFile(schedulePath, "utf-8")); } catch {}

      const entry = schedule.find((s: any) => s.id === params.id);
      if (!entry) return { content: [{ type: "text", text: `Not found: ${params.id}` }], details: {} };

      entry.done = true;
      await fs.writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");
      return { content: [{ type: "text", text: `Cancelled: ${entry.prompt.slice(0, 80)}` }], details: {} };
    },
  };
}

// --- Watches (event-driven triggers) ---

export function createRegisterWatchTool(senderName: string): AgentTool {
  return {
    name: "register_watch",
    description: "Register a watch that fires an action when a matching event occurs. Use this instead of a polling cron when the trigger is a specific condition (e.g. sauna hits 82°C, someone arrives). The watch evaluator catches the exact moment the condition becomes true.",
    label: "Register Watch",
    parameters: Type.Object({
      on: Type.Object({
        type: Type.String({ description: "Event type to listen for (e.g. sauna_reading, chat_message, broadcast, arrival)" }),
        where: Type.Optional(Type.String({ description: "Filter expression, e.g. 'temp >= 82' or 'from == \"Aaron\"'. Supports == != < <= > >= && ||." })),
        trigger: Type.Optional(Type.Union([
          Type.Literal("always"),
          Type.Literal("crossing_up"),
          Type.Literal("crossing_down"),
        ], { description: "When to fire. 'crossing_up' = only on the transition into matching (default for thresholds). 'always' = every matching event." })),
      }),
      action: Type.Object({
        kind: Type.String({ description: "Action kind: 'dm', 'group', 'broadcast', or any custom action registered via workspace/extensions/actions.js" }),
      }, { additionalProperties: true, description: "Action params. For 'dm': {to, intent}. For 'group'/'broadcast': {intent}." }),
      once: Type.Optional(Type.Boolean({ description: "If true, watch self-deletes after firing once" })),
      description: Type.Optional(Type.String({ description: "Human-readable description for list_watches" })),
    }),
    execute: async (_id, params) => {
      const { addWatch } = await import("../core/watches.js");
      const full = await addWatch({
        on: params.on,
        action: params.action,
        once: params.once ?? false,
        description: params.description,
        created_by: senderName,
      });
      return { content: [{ type: "text", text: `Registered watch ${full.id}` }], details: {} };
    },
  };
}

export function createListWatchesTool(): AgentTool {
  return {
    name: "list_watches",
    description: "List all registered watches with their filters and actions",
    label: "List Watches",
    parameters: Type.Object({}),
    execute: async () => {
      const { loadWatches } = await import("../core/watches.js");
      const watches = await loadWatches();
      if (watches.length === 0) {
        return { content: [{ type: "text", text: "No watches registered." }], details: {} };
      }
      const lines = watches.map((w) => {
        const triggerTxt = w.on.trigger ?? "always";
        const whereTxt = w.on.where ? ` where ${w.on.where}` : "";
        const onceTxt = w.once ? " (once)" : "";
        const desc = w.description ? `\n    ${w.description}` : "";
        return `• ${w.id}: on ${w.on.type}${whereTxt} [${triggerTxt}]${onceTxt} → ${w.action.kind}${desc}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };
}

export function createCancelWatchTool(): AgentTool {
  return {
    name: "cancel_watch",
    description: "Remove a registered watch by ID",
    label: "Cancel Watch",
    parameters: Type.Object({
      id: Type.String({ description: "Watch ID to remove" }),
    }),
    execute: async (_id, params) => {
      const { removeWatch } = await import("../core/watches.js");
      const removed = await removeWatch(params.id);
      return {
        content: [{ type: "text", text: removed ? `Removed watch ${params.id}` : `No watch with id ${params.id}` }],
        details: {},
      };
    },
  };
}

// --- Radio ---



// --- Radio Calendar ---


// --- Module Management (self-modification) ---

const MODULE_CREATION_LOG = "tasks/module-creation-log.json";

export function createCreateModuleTool(workspacePath: string): AgentTool {
  return {
    name: "create_module",
    description: "Create a new markdown-driven module that will start running automatically. Use for temporary watchers, recurring tasks, or new capabilities.",
    label: "Create Module",
    parameters: Type.Object({
      name: Type.String({ description: "Module name (becomes filename, no spaces)" }),
      interval: Type.String({ description: "How often to run: '5m', '30m', '1h', '6h', '12h'" }),
      tools: Type.Array(Type.String(), { description: "Tool whitelist for this module" }),
      prompt: Type.String({ description: "The module's instructions — what it should do each cycle" }),
      expires: Type.Optional(Type.String({ description: "When to auto-disable: ISO datetime or 'in 7d', 'next monday'" })),
      description: Type.Optional(Type.String({ description: "One-line description" })),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { parseTime } = await import("../core/time-parser.js");
      const { slugify } = await import("../core/slugify.js");

      const safeName = slugify(params.name);
      const modulePath = path.join(workspacePath, "modules", `${safeName}.md`);

      // Guard: check if module already exists
      try { await fs.access(modulePath); return { content: [{ type: "text", text: `Module "${safeName}" already exists. Use a different name.` }], details: {} }; } catch {}

      // Guard: max 20 modules
      const files = await fs.readdir(path.join(workspacePath, "modules"));
      const mdFiles = files.filter((f: string) => f.endsWith(".md"));
      if (mdFiles.length >= 20) {
        return { content: [{ type: "text", text: "Module limit reached (20). Disable or remove an existing module first." }], details: {} };
      }

      // Guard: rate limit — max 1 per week
      const logPath = path.join(workspacePath, MODULE_CREATION_LOG);
      let creationLog: any[] = [];
      try { creationLog = JSON.parse(await fs.readFile(logPath, "utf-8")); } catch {}
      const oneWeekAgo = Date.now() - 7 * 86400000;
      const recentCreations = creationLog.filter((e: any) => e.time > oneWeekAgo);
      if (recentCreations.length >= 1) {
        return { content: [{ type: "text", text: "Module creation rate limit: 1 per week. Last created: " + new Date(recentCreations[0].time).toLocaleDateString() }], details: {} };
      }

      // Guard: minimum interval 5m
      const intervalMatch = params.interval.match(/^(\d+)\s*(m|h)$/);
      if (intervalMatch) {
        const mins = intervalMatch[2] === "h" ? parseInt(intervalMatch[1]) * 60 : parseInt(intervalMatch[1]);
        if (mins < 5) {
          return { content: [{ type: "text", text: "Minimum interval is 5m for self-created modules." }], details: {} };
        }
      }

      // Build frontmatter
      let frontmatter = `---\nname: ${safeName}\ninterval: ${params.interval}\ntools: [${params.tools.join(", ")}]`;
      if (params.expires) {
        const expiresTime = await parseTime(params.expires);
        if (expiresTime) {
          frontmatter += `\nexpires: ${new Date(expiresTime).toISOString()}`;
        }
      }
      frontmatter += `\n---\n\n`;

      const content = frontmatter + (params.description ? `# ${params.name}\n\n${params.description}\n\n` : `# ${params.name}\n\n`) + params.prompt + "\n";
      await fs.writeFile(modulePath, content, "utf-8");

      // Log creation
      creationLog.push({ name: safeName, time: Date.now() });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, JSON.stringify(creationLog, null, 2), "utf-8");

      return { content: [{ type: "text", text: `Module "${safeName}" created. It will start running within 30 seconds.${params.expires ? ` Expires: ${params.expires}` : ""}` }], details: {} };
    },
  };
}

export function createDisableModuleTool(workspacePath: string): AgentTool {
  return {
    name: "disable_module",
    description: "Disable a module by moving it to the disabled directory. It stops running but is preserved.",
    label: "Disable Module",
    parameters: Type.Object({
      name: Type.String({ description: "Module name to disable" }),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { slugify } = await import("../core/slugify.js");

      const safeName = slugify(params.name);
      const srcPath = path.join(workspacePath, "modules", `${safeName}.md`);
      const dstPath = path.join(workspacePath, "modules", "disabled", `${safeName}.md`);

      try {
        await fs.access(srcPath);
      } catch {
        return { content: [{ type: "text", text: `Module "${safeName}" not found.` }], details: {} };
      }

      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await fs.rename(srcPath, dstPath);
      return { content: [{ type: "text", text: `Module "${safeName}" disabled.` }], details: {} };
    },
  };
}

export function createListModulesTool(workspacePath: string): AgentTool {
  return {
    name: "list_modules",
    description: "List all active and disabled modules",
    label: "List Modules",
    parameters: Type.Object({}),
    execute: async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      const active: string[] = [];
      const disabled: string[] = [];

      try {
        const files = await fs.readdir(path.join(workspacePath, "modules"));
        for (const f of files) {
          if (f.endsWith(".md")) active.push(f.replace(".md", ""));
        }
      } catch {}

      try {
        const files = await fs.readdir(path.join(workspacePath, "modules", "disabled"));
        for (const f of files) {
          if (f.endsWith(".md")) disabled.push(f.replace(".md", ""));
        }
      } catch {}

      const lines = [`Active (${active.length}): ${active.join(", ")}`, `Disabled (${disabled.length}): ${disabled.join(", ")}`];
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };
}
