/**
 * Feyblet Tools — Pi Agent SDK native tools.
 *
 * All tools use Pi's AgentTool interface with TypeBox schemas
 * for typed, validated parameters. The Pi Agent handles the
 * tool execution loop automatically — no text parsing needed.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { FeyOpsDB } from "../feyops/db.js";
import type { MemoryManager } from "../memory/manager.js";
import { callMCPTool } from "../mcp/bridge.js";
import type { MQTTBus } from "../core/mqtt-bus.js";

import { createLogger } from "../core/logger.js";

const QMD_URL = process.env.QMD_URL || "http://localhost:8181";
const TTS_API = process.env.TTS_API_URL || "http://localhost:8000";
const broadcastLog = createLogger("radio_broadcast");

// --- Sauna ---

export function createCheckSaunaTool(memory: MemoryManager): AgentTool {
  return {
    name: "check_sauna",
    description: "Check the current sauna temperature — returns the latest reading and whether it's heating up or cooling down",
    label: "Check Sauna",
    parameters: Type.Object({}),
    execute: async () => {
      const log = await memory.readTodayLog();
      if (!log) return { content: [{ type: "text", text: "No sauna data today." }], details: {} };

      const readings = log.match(/\*\[Sauna\]\*.*?(\d+\.?\d*)°C.*$/gm);
      if (!readings || readings.length === 0) {
        return { content: [{ type: "text", text: "No sauna readings today." }], details: {} };
      }

      const latest = readings[readings.length - 1];
      const temp = parseFloat(latest.match(/(\d+\.?\d*)°C/)?.[1] || "0");

      let trend = "";
      if (readings.length >= 2) {
        const prev = parseFloat(readings[readings.length - 2].match(/(\d+\.?\d*)°C/)?.[1] || "0");
        if (temp > prev + 2) trend = ", heating up";
        else if (temp < prev - 2) trend = ", cooling down";
        else trend = ", holding steady";
      }

      const status = temp > 70 ? "hot — ready to use" : temp > 40 ? "warming up" : "cold";

      return {
        content: [{ type: "text", text: `Sauna: ${temp}°C (${status}${trend}). ${readings.length} readings today.` }],
        details: {},
      };
    },
  };
}

// --- Person Lookup ---

export function createLookupPersonTool(db: FeyOpsDB, memory: MemoryManager): AgentTool {
  return {
    name: "lookup_person",
    description: "Look up a person by name — shows their profile, current room, booking dates, and whether they're here now",
    label: "Person Lookup",
    parameters: Type.Object({
      name: Type.String({ description: "Person name to look up" }),
    }),
    execute: async (_id, params) => {
      const name = params.name.trim();
      const today = new Date().toISOString().slice(0, 10);
      const parts: string[] = [];

      // Search bookings
      const allBookings = db.getBookings();
      const lower = name.toLowerCase();
      const matched = allBookings.filter((b) => {
        const guestLower = b.guest.toLowerCase();
        return guestLower.includes(lower) || lower.includes(guestLower.split(" ")[0]);
      });

      if (matched.length > 0) {
        const guests = [...new Set(matched.map((b) => b.guest))];
        for (const guest of guests) {
          const bookings = matched.filter((b) => b.guest === guest);
          parts.push(`**${guest}**`);
          for (const b of bookings) {
            let status: string;
            if (b.checkout <= today) status = "departed";
            else if (b.checkin <= today) status = "HERE NOW";
            else {
              const days = Math.ceil((new Date(b.checkin).getTime() - new Date(today).getTime()) / 86400000);
              status = `arriving in ${days} day${days === 1 ? "" : "s"}`;
            }
            parts.push(`  ${b.room} (${b.venue}): ${b.checkin} → ${b.checkout} — ${status}`);
          }
        }
      } else {
        parts.push(`No bookings found for "${name}".`);
      }

      // Check people profile
      const person = await memory.readPerson(name);
      if (person) {
        const fmMatch = person.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) parts.push(`\nProfile: ${fmMatch[1].trim()}`);
      }

      return { content: [{ type: "text", text: parts.join("\n") }], details: {} };
    },
  };
}

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

export function createCheckBookingsTool(db: FeyOpsDB): AgentTool {
  return {
    name: "check_bookings",
    description: "Check booking system — arrivals, departures, who's here today, room occupancy",
    label: "Check Bookings",
    parameters: Type.Object({
      query: Type.String({ description: "What to check: 'today', 'arrivals', 'departures', or a general question" }),
    }),
    execute: async (_id, params) => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const allBookings = db.getBookings();
      const isPlaceholder = (name: string) => {
        const lower = name.toLowerCase();
        return lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden");
      };
      const real = allBookings.filter((b) => !isPlaceholder(b.guest));
      const currentGuests = real.filter((b) => b.checkin <= today && b.checkout > today);
      const parts: string[] = [];

      parts.push(`**Currently here**: ${new Set(currentGuests.map(b => b.guest)).size} guests`);

      const todayArrivals = real.filter((b) => b.checkin === today);
      if (todayArrivals.length > 0) parts.push(`**Arriving today**: ${todayArrivals.map(b => `${b.guest} (${b.room})`).join(", ")}`);

      const todayDepartures = real.filter((b) => b.checkout === today);
      if (todayDepartures.length > 0) parts.push(`**Departing today**: ${todayDepartures.map(b => `${b.guest} (${b.room})`).join(", ")}`);

      const tomorrowArrivals = real.filter((b) => b.checkin === tomorrow);
      if (tomorrowArrivals.length > 0) parts.push(`**Arriving tomorrow**: ${tomorrowArrivals.map(b => `${b.guest} (${b.room})`).join(", ")}`);

      return { content: [{ type: "text", text: parts.join("\n") }], details: {} };
    },
  };
}

// --- Season Log ---

export function createSeasonLogTool(workspacePath: string): AgentTool {
  const appendFile = async (path: string, data: string, encoding: string) => {
    const fs = await import("node:fs/promises");
    await fs.appendFile(path, data, encoding as BufferEncoding);
  };
  const join = (...parts: string[]) => parts.join("/");

  const categories: Record<string, string> = {
    events: "season/events.md",
    parties: "season/parties.md",
    meals: "season/meals.md",
    crispy: "season/crispy.md",
  };

  return {
    name: "season_log",
    description: "Log something to the season record — events, parties, meals, or crispy bits",
    label: "Season Log",
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("events"),
        Type.Literal("parties"),
        Type.Literal("meals"),
        Type.Literal("crispy"),
      ], { description: "Category to log to" }),
      entry: Type.String({ description: "What to log" }),
    }),
    execute: async (_id, params) => {
      if (!categories[params.category]) {
        return { content: [{ type: "text", text: `Unknown category. Use: ${Object.keys(categories).join(", ")}` }], details: {} };
      }
      const fs = await import("node:fs/promises");
      const filePath = join(workspacePath, categories[params.category]);
      const today = new Date().toISOString().slice(0, 10);

      // Check for duplicate — read today's entries and skip if similar
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const todayEntries = content.split("\n").filter((l: string) => l.includes(`**${today}:**`));
        const entryLower = params.entry.toLowerCase().slice(0, 60);
        const isDuplicate = todayEntries.some((e: string) => {
          const existing = e.toLowerCase();
          // Check if the core topic already exists (first 60 chars similarity)
          return existing.includes(entryLower.slice(0, 30));
        });
        if (isDuplicate) {
          return { content: [{ type: "text", text: `Already logged something similar to ${params.category} today. Recent entries:\n${todayEntries.slice(-3).join("\n")}` }], details: {} };
        }
      } catch {}

      const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const line = `\n*   **${today} ${timeStr}:** ${params.entry}\n`;
      await appendFile(filePath, line, "utf-8");
      return { content: [{ type: "text", text: `Logged to ${params.category}: "${params.entry}"` }], details: {} };
    },
  };
}

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

import type { SignalBridge } from "../signal/bridge.js";

export function createSendDMTool(bridge: SignalBridge, memory: MemoryManager): AgentTool {
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

export function createSendGroupMessageTool(bridge: SignalBridge, memory: MemoryManager): AgentTool {
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

// --- Radio ---

export function createRadioBroadcastTool(): AgentTool {
  return {
    name: "radio_broadcast",
    description: "Broadcast a spoken message on the château's FM radio. Music auto-ducks while speaking.",
    label: "Radio Broadcast",
    parameters: Type.Object({
      message: Type.String({ description: "Text to speak on air" }),
      voice: Type.Optional(Type.String({ description: "Voice to use — e.g. 'clone:iannis' for voice library, or omit for random community voice" })),
    }),
    execute: async (_id, params) => {
      try {
        const fs = await import("node:fs/promises");
        const http = await import("node:http");
        const os = await import("node:os");
        const pathMod = await import("node:path");

        // Generate TTS with random voice
        const VOICES_DIR = pathMod.join(process.cwd(), "workspace", "voices");
        const voices = [
          {
            path: `${VOICES_DIR}/primavera.wav`,
            ref_text: "So this is Aminance. You can see the currant population of Aminance. There will be many more families. So Aminance are blockchain-based lifeforms.",
          },
          {
            path: `${VOICES_DIR}/lou_short.wav`,
            ref_text: "Welcome everyone to be on the future of work. I think most of you of the high-mine know my name, I'm Liu, and...",
          },
          {
            path: `${VOICES_DIR}/poli_voiceover.wav`,
            ref_text: "We were tired of systems that tell us what to fear, what to optimize for, and what to expect. What we lack are spaces where people can imagine futures together. Trying to reclaim imagine...",
          },
          {
            path: `${VOICES_DIR}/sparkle.wav`,
            ref_text: "Hello, my name is Unimportant and I'm here to teach you how maps work. Welcome to the Sparkle platform, it's very easy.",
          },
          {
            path: `${VOICES_DIR}/ed_brittish_short.wav`,
            ref_text: "Now, what I will say to you, Apollonio, is that the future of Feÿtopian radio depends upon our embrace of the...",
          },
          {
            path: `${VOICES_DIR}/ed_french_2.wav`,
            ref_text: "Ici, ici, à l'enfant de l'Américaine Grille, oui, à l'Américaine Grille, avec des bagages, ici, je suis juste paré à la gare. Et c'est vraiment...",
          },
          {
            path: `${VOICES_DIR}/shibley.wav`,
            ref_text: "Good morning, Feÿtopia. This is Shipply. I'm coming in to ask you how do you feel about your eggs today.",
          },
          {
            path: `${VOICES_DIR}/sebnem.wav`,
            ref_text: "Hello, Feÿtopia. I hope everyone is enjoying their week of embodiment. Today's a beautiful day, and I hope we meet for a game of volleyball.",
          },
          {
            path: `${VOICES_DIR}/elena.wav`,
            ref_text: "Hi, Poly, amore. I'm here looking at you to the other side of the window. You will look so cool with these new glasses.",
          },
        ];
        // Clone voices from the voice library (fast, ~2.5s)
        const cloneVoices = ["clone:iannis"];

        // Use specified voice or pick a random one (including clone voices)
        let ttsBody: Record<string, any>;
        if (params.voice?.startsWith("clone:")) {
          broadcastLog.info(`Voice: ${params.voice}`);
          ttsBody = {
            model: "qwen3-tts",
            voice: params.voice,
            input: params.message,
            response_format: "wav",
          };
        } else if (!params.voice) {
          // Random selection from all voices (ref + clone)
          const totalVoices = voices.length + cloneVoices.length;
          const pick = Math.floor(Math.random() * totalVoices);
          if (pick < voices.length) {
            const voice = voices[pick];
            broadcastLog.info(`Voice: ${voice.path.split("/").pop()}`);
            ttsBody = {
              model: "qwen3-tts",
              voice: "default",
              input: params.message,
              response_format: "wav",
              voice_path: voice.path,
              ref_text: voice.ref_text,
            };
          } else {
            const cloneVoice = cloneVoices[pick - voices.length];
            broadcastLog.info(`Voice: ${cloneVoice}`);
            ttsBody = {
              model: "qwen3-tts",
              voice: cloneVoice,
              input: params.message,
              response_format: "wav",
            };
          }
        } else {
          const voice = voices[Math.floor(Math.random() * voices.length)];
          broadcastLog.info(`Voice: ${voice.path.split("/").pop()}`);
          ttsBody = {
            model: "qwen3-tts",
            voice: "default",
            input: params.message,
            response_format: "wav",
            voice_path: voice.path,
            ref_text: voice.ref_text,
          };
        }

        const ttsRes = await fetch(`${TTS_API}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ttsBody),
          signal: AbortSignal.timeout(120000),
        });
        if (!ttsRes.ok) {
          const err = await ttsRes.text();
          throw new Error(`TTS ${ttsRes.status}: ${err.slice(0, 200)}`);
        }

        // Save audio, boost volume 2x with ffmpeg, then serve
        const rawBuffer = Buffer.from(await ttsRes.arrayBuffer());
        const tmpName = `feyblet-radio-${Date.now()}.wav`;
        const tmpPath = pathMod.join(os.tmpdir(), tmpName);
        const rawPath = tmpPath.replace(".wav", "-raw.wav");
        await fs.writeFile(rawPath, rawBuffer);

        const { execSync } = await import("node:child_process");
        try {
          execSync(`ffmpeg -y -i "${rawPath}" -filter:a "volume=2.0" "${tmpPath}"`, { timeout: 15000 });
          await fs.unlink(rawPath).catch(() => {});
        } catch {
          await fs.rename(rawPath, tmpPath);
        }
        const audioBuffer = await fs.readFile(tmpPath);

        // Serve via temporary HTTP server (radio Pi is on a different machine)
        const port = 9876 + Math.floor(Math.random() * 100);
        const myIp = process.env.HOST_IP || "192.168.10.130";
        const audioUrl = `http://${myIp}:${port}/${tmpName}`;

        await new Promise<void>((resolve, reject) => {
          let served = false;
          const server = http.createServer((req, res) => {
            served = true;
            broadcastLog.info(`Pi fetched WAV (${audioBuffer.length} bytes)`);
            res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audioBuffer.length.toString() });
            res.end(audioBuffer);
          });
          server.listen(port, () => {
            broadcastLog.info(`Serving on ${audioUrl}`);
            callMCPTool("radio", "ai_mic", { action: "play_url", url: audioUrl })
              .then((r) => broadcastLog.info(`MCP accepted: ${r.slice(0, 100)}`))
              .catch((e) => broadcastLog.error(`MCP error: ${e}`));
          });
          setTimeout(() => {
            server.close();
            if (served) {
              broadcastLog.info("Success — WAV served and played");
            } else {
              broadcastLog.warn("Timeout — Pi never fetched the WAV");
            }
            resolve();
          }, 30000);
        });

        // Clean up
        setTimeout(() => fs.unlink(tmpPath).catch(() => {}), 60000);

        return { content: [{ type: "text", text: `Broadcasting: "${params.message.slice(0, 80)}..."` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Broadcast failed: ${err}` }], details: {} };
      }
    },
  };
}

export function createRadioScheduleTool(): AgentTool {
  return {
    name: "radio_schedule",
    description: "Schedule a future radio broadcast. Time format: 'in 5m' or 'at 18:30'",
    label: "Schedule Broadcast",
    parameters: Type.Object({
      time: Type.String({ description: "When: 'in 5m', 'in 1h', 'at 18:30'" }),
      message: Type.String({ description: "Text to broadcast, or 'generate' to let Feyblet write it" }),
      context: Type.Optional(Type.String({ description: "Context hint if message is 'generate'" })),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      let atTime: number;
      const inMatch = params.time.match(/^in\s+(\d+)\s*(m|h|min|hour)/i);
      const atMatch = params.time.match(/^at\s+(\d{1,2}):(\d{2})/i);

      if (inMatch) {
        const multiplier = inMatch[2].startsWith("h") ? 60 : 1;
        atTime = Date.now() + parseInt(inMatch[1]) * multiplier * 60 * 1000;
      } else if (atMatch) {
        const now = new Date();
        atTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(atMatch[1]), parseInt(atMatch[2])).getTime();
        if (atTime < Date.now()) atTime += 24 * 60 * 60 * 1000;
      } else {
        return { content: [{ type: "text", text: "Invalid time format. Use 'in 5m' or 'at 18:30'." }], details: {} };
      }

      const schedulePath = path.join(process.cwd(), "workspace", "radio", "schedule.json");
      let schedule: Array<Record<string, unknown>> = [];
      try { schedule = JSON.parse(await fs.readFile(schedulePath, "utf-8")); } catch {}

      schedule.push({ id: `sched-${Date.now()}`, at: atTime, script: params.message, context: params.context });
      await fs.mkdir(path.dirname(schedulePath), { recursive: true });
      await fs.writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");

      return { content: [{ type: "text", text: `Scheduled for ${new Date(atTime).toLocaleTimeString()}` }], details: {} };
    },
  };
}

// --- Radio Calendar ---

export function createRadioCalendarTool(): AgentTool {
  return {
    name: "radio_calendar",
    description: "Manage the radio programming grid — view, add, or remove recurring programs and upcoming one-off slots",
    label: "Radio Calendar",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("view"),
        Type.Literal("add_recurring"),
        Type.Literal("remove_recurring"),
        Type.Literal("add_upcoming"),
        Type.Literal("clear_upcoming"),
      ], { description: "What to do" }),
      program: Type.Optional(Type.Object({
        name: Type.String({ description: "Program name, e.g. 'Morning Bloom Report'" }),
        description: Type.Optional(Type.String({ description: "What this program is about" })),
        schedule: Type.Optional(Type.String({ description: "When it runs: 'daily 8:00', 'weekdays 12:00', 'fridays 19:00'" })),
        duration_min: Type.Optional(Type.Number({ description: "Approximate duration in minutes" })),
      })),
      upcoming: Type.Optional(Type.Object({
        at: Type.String({ description: "When: ISO timestamp or 'in 30m', 'at 18:30'" }),
        script: Type.String({ description: "What to broadcast (text or 'generate')" }),
        context: Type.Optional(Type.String({ description: "Context for generation" })),
      })),
      program_name: Type.Optional(Type.String({ description: "Name of program to remove" })),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const calPath = path.join(process.cwd(), "workspace", "radio", "calendar.json");

      let cal: any;
      try {
        cal = JSON.parse(await fs.readFile(calPath, "utf-8"));
      } catch {
        cal = { meta: { description: "Radio programming grid", last_updated: null }, recurring: [], upcoming: [], history: [] };
      }

      switch (params.action) {
        case "view": {
          const recurring = cal.recurring.length > 0
            ? cal.recurring.map((p: any) => `- **${p.name}** (${p.schedule}): ${p.description || "no description"}`).join("\n")
            : "No recurring programs yet. The grid is open.";

          const upcoming = cal.upcoming.filter((u: any) => !u.done).slice(0, 5);
          const upcomingStr = upcoming.length > 0
            ? upcoming.map((u: any) => `- ${new Date(u.at).toLocaleString()}: ${u.script.slice(0, 60)}`).join("\n")
            : "Nothing scheduled.";

          const recent = cal.history.slice(-5);
          const recentStr = recent.length > 0
            ? recent.map((h: any) => `- ${h.when}: ${h.what.slice(0, 60)}`).join("\n")
            : "No broadcast history yet.";

          return {
            content: [{ type: "text", text: `**Recurring Programs:**\n${recurring}\n\n**Upcoming:**\n${upcomingStr}\n\n**Recent Broadcasts:**\n${recentStr}` }],
            details: {},
          };
        }

        case "add_recurring": {
          if (!params.program) return { content: [{ type: "text", text: "Provide program details." }], details: {} };
          cal.recurring.push({
            name: params.program.name,
            description: params.program.description || "",
            schedule: params.program.schedule || "daily",
            duration_min: params.program.duration_min || 5,
            created: new Date().toISOString(),
            active: true,
          });
          cal.meta.last_updated = new Date().toISOString();
          await fs.writeFile(calPath, JSON.stringify(cal, null, 2), "utf-8");
          return { content: [{ type: "text", text: `Added recurring program: "${params.program.name}" (${params.program.schedule})` }], details: {} };
        }

        case "remove_recurring": {
          if (!params.program_name) return { content: [{ type: "text", text: "Provide program_name to remove." }], details: {} };
          const before = cal.recurring.length;
          cal.recurring = cal.recurring.filter((p: any) => p.name !== params.program_name);
          if (cal.recurring.length === before) return { content: [{ type: "text", text: `Program "${params.program_name}" not found.` }], details: {} };
          cal.meta.last_updated = new Date().toISOString();
          await fs.writeFile(calPath, JSON.stringify(cal, null, 2), "utf-8");
          return { content: [{ type: "text", text: `Removed program: "${params.program_name}"` }], details: {} };
        }

        case "add_upcoming": {
          if (!params.upcoming) return { content: [{ type: "text", text: "Provide upcoming broadcast details." }], details: {} };
          let atTime: number;
          const atStr = params.upcoming.at;
          const inMatch = atStr.match(/^in\s+(\d+)\s*(m|h)/i);
          const atMatch = atStr.match(/^at\s+(\d{1,2}):(\d{2})/i);
          if (inMatch) {
            atTime = Date.now() + parseInt(inMatch[1]) * (inMatch[2].startsWith("h") ? 3600000 : 60000);
          } else if (atMatch) {
            const now = new Date();
            atTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(atMatch[1]), parseInt(atMatch[2])).getTime();
            if (atTime < Date.now()) atTime += 86400000;
          } else {
            atTime = Date.parse(atStr) || Date.now() + 600000;
          }

          cal.upcoming.push({
            id: `cal-${Date.now()}`,
            at: atTime,
            script: params.upcoming.script,
            context: params.upcoming.context,
            done: false,
          });
          cal.meta.last_updated = new Date().toISOString();
          await fs.writeFile(calPath, JSON.stringify(cal, null, 2), "utf-8");
          return { content: [{ type: "text", text: `Scheduled for ${new Date(atTime).toLocaleString()}` }], details: {} };
        }

        case "clear_upcoming": {
          cal.upcoming = [];
          cal.meta.last_updated = new Date().toISOString();
          await fs.writeFile(calPath, JSON.stringify(cal, null, 2), "utf-8");
          return { content: [{ type: "text", text: "Cleared all upcoming broadcasts." }], details: {} };
        }

        default:
          return { content: [{ type: "text", text: "Unknown action." }], details: {} };
      }
    },
  };
}

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
