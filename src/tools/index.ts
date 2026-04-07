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
            query: params.query,
            collections: ["feyblet"],
            limit: 10,
            maxPerFile: 5,
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

// --- Load More Context ---

export function createLoadMoreTool(): AgentTool {
  return {
    name: "load_more",
    description: "Load more conversation history with a person or from the group. Use when you need more context but don't know exactly what to search for — like scrolling up in a chat.",
    label: "Load More",
    parameters: Type.Object({
      person: Type.Optional(Type.String({ description: "Person name to load DM history with. Omit for group chat history." })),
      count: Type.Optional(Type.Number({ description: "How many messages to load (default 20)" })),
    }),
    execute: async (_id, params) => {
      try {
        const fs = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const count = params.count || 20;

        // Read today's log
        const today = new Date().toISOString().slice(0, 10);
        const logPath = pathMod.join(process.cwd(), "workspace", "memory", `${today}.md`);
        let log: string;
        try { log = await fs.readFile(logPath, "utf-8"); } catch {
          return { content: [{ type: "text", text: "No log for today." }], details: {} };
        }

        // Also try yesterday
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        try {
          const yLog = await fs.readFile(pathMod.join(process.cwd(), "workspace", "memory", `${yesterday}.md`), "utf-8");
          log = yLog + "\n" + log;
        } catch {}

        const lines = log.split("\n");
        const entries: string[] = [];

        if (params.person) {
          // Filter to DM exchanges with this person
          const personLower = params.person.toLowerCase();
          for (const line of lines) {
            const isFromPerson = line.match(/^\*\*([^*]+)\*\*\s*\(dm/) && line.toLowerCase().includes(personLower);
            const isFeybletTo = line.match(/^\*\*Feyblet\*\*\s*\(dm to/) && line.toLowerCase().includes(personLower);
            if (isFromPerson || isFeybletTo) {
              entries.push(line);
            }
          }
        } else {
          // Group messages
          for (const line of lines) {
            if (line.match(/^\*\*([^*]+)\*\*\s*\(group/) || line.match(/^\*\*Feyblet\*\*\s*\(group/)) {
              entries.push(line);
            }
          }
        }

        if (entries.length === 0) {
          return { content: [{ type: "text", text: `No ${params.person ? `DM history with ${params.person}` : "group messages"} found.` }], details: {} };
        }

        const selected = entries.slice(-count);
        return { content: [{ type: "text", text: selected.join("\n") }], details: {} };
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

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8888";

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

// --- View Image (load image into LLM context) ---

export function createViewImageTool(): AgentTool {
  return {
    name: "view_image",
    description: "Load a previously shared image into your vision. Use when someone asks about an image that was shared earlier — search memory for the image path first.",
    label: "View Image",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file, e.g. workspace/media/2026-04-04-sarah-1234.jpg" }),
    }),
    execute: async (_id, params) => {
      try {
        const fs = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const fullPath = pathMod.join(process.cwd(), params.path);
        const buffer = await fs.readFile(fullPath);
        const ext = pathMod.extname(fullPath).slice(1);
        const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";

        return {
          content: [
            { type: "image", data: buffer.toString("base64"), mimeType } as any,
            { type: "text", text: `Image loaded: ${params.path}` },
          ],
          details: {},
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Could not load image: ${err}` }], details: {} };
      }
    },
  };
}

// --- Signal Messaging Tools ---

import type { SignalBridge } from "../signal/bridge.js";

export function createSendDMTool(bridge: SignalBridge, memory: MemoryManager): AgentTool {
  return {
    name: "send_dm",
    description: "Send a direct message to someone on Signal. Look up the person first to find their Signal ID.",
    label: "Send DM",
    parameters: Type.Object({
      to: Type.String({ description: "Person name — will be resolved to Signal ID via person lookup" }),
      message: Type.String({ description: "The message to send" }),
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

        await bridge.send({ to: signalId, text: params.message });
        await memory.appendLog(`**Feyblet** (dm to ${params.to}): ${params.message}`);
        return { content: [{ type: "text", text: `DM sent to ${params.to}: "${params.message.slice(0, 100)}"` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send DM: ${err}` }], details: {} };
      }
    },
  };
}

export function createSendGroupMessageTool(bridge: SignalBridge): AgentTool {
  // Known groups cache — populated from workspace/community/known-groups.md
  const knownGroups = new Map<string, string>(); // name → id
  let loaded = false;

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
    description: "Send a message to a Signal group. You can pass either the group ID or the group name.",
    label: "Send Group Message",
    parameters: Type.Object({
      group_id: Type.String({ description: "The Signal group ID or group name (e.g. 'FEŸTOPIA 2026 - Season 7')" }),
      message: Type.String({ description: "The message to send" }),
    }),
    execute: async (_id, params) => {
      await loadKnownGroups();

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
        await bridge.send({
          to: "",
          text: params.message,
          groupId,
        });
        return { content: [{ type: "text", text: `Sent to group: "${params.message.slice(0, 100)}"` }], details: {} };
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
    description: "Send a message to another module. Use to ask conversation to DM someone, ask radio to broadcast, ask the DJ to play something, or coordinate with any module.",
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
    description: "Schedule a message to your future self. When the time comes, you'll wake up with full context and agency to act on it.",
    label: "Schedule",
    parameters: Type.Object({
      when: Type.String({ description: "When: ISO datetime, 'tomorrow 10:00', 'next friday 14:00', 'in 3d', 'at 18:30', or natural language" }),
      prompt: Type.String({ description: "Message to your future self — what to think about or do" }),
      context: Type.Optional(Type.String({ description: "Background context to preserve for when you wake up" })),
      recurrence: Type.Optional(Type.Union([
        Type.Literal("once"),
        Type.Literal("daily"),
        Type.Literal("weekly"),
      ], { description: "How often: once (default), daily, weekly" })),
      expires: Type.Optional(Type.String({ description: "When to stop recurring (ISO datetime or natural language)" })),
    }),
    execute: async (_id, params) => {
      const { parseTime } = await import("../core/time-parser.js");
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      const atTime = await parseTime(params.when);
      if (!atTime) {
        return { content: [{ type: "text", text: `Could not parse time: "${params.when}". Try ISO datetime, "tomorrow 10:00", "next friday afternoon", etc.` }], details: {} };
      }

      let expiresTime: number | null = null;
      if (params.expires) {
        expiresTime = await parseTime(params.expires);
      }

      const schedulePath = path.join(workspacePath, "tasks", "scheduled.json");
      await fs.mkdir(path.dirname(schedulePath), { recursive: true });

      let schedule: any[] = [];
      try { schedule = JSON.parse(await fs.readFile(schedulePath, "utf-8")); } catch {}

      const entry = {
        id: `sched-${Date.now()}`,
        when: atTime,
        prompt: params.prompt,
        context: params.context || null,
        recurrence: params.recurrence || "once",
        expires: expiresTime,
        created: new Date().toISOString(),
        done: false,
      };

      schedule.push(entry);
      await fs.writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");

      const whenStr = new Date(atTime).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
      return { content: [{ type: "text", text: `Scheduled for ${whenStr}: "${params.prompt.slice(0, 100)}"${params.recurrence && params.recurrence !== "once" ? ` (${params.recurrence})` : ""}` }], details: {} };
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
        const when = new Date(s.when).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        return `[${s.id}] ${when}${s.recurrence !== "once" ? ` (${s.recurrence})` : ""}: ${s.prompt.slice(0, 100)}`;
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
    }),
    execute: async (_id, params) => {
      try {
        const fs = await import("node:fs/promises");
        const http = await import("node:http");
        const os = await import("node:os");
        const pathMod = await import("node:path");

        // Generate TTS with random voice
        const voices = [
          {
            path: "/home/plantoidz/Downloads/primavera.wav",
            ref_text: "So this is aminals. So you can see the current population of aminals. There will be many more families. So aminals are blockchain-based life forms and they exist as an NFT. So this is Sepolia for now because this is like not perfectly finished. But anyway, so every one of them is an NFT",
          },
          {
            path: "/home/plantoidz/Downloads/lou_short.wav",
            ref_text: "Welcome everyone to beyond the future of work, most of you of the hive mind know my name, I'm Lou, and",
          },
          {
            path: "/home/plantoidz/Downloads/poli_voiceover.wav",
            ref_text: "We were tired of systems that tell us what to fear, what to optimize for, and what to expect. What we lack are spaces where people can imagine futures together. Trying to reclaim imagination from disalgorithmic fatalism, we created an artistic intervention called abductive pathways",
          },
          {
            path: "/home/plantoidz/Downloads/sparkle.wav",
            ref_text: "Hello, my name is Unimportant and I'm here to teach you how maps work. Welcome to the Sparkle platform. It's very easy to use. Up here we see the schedule where you can jump to events happening right now directly. Here's the chat, public and private. Connect with others and store your deepest darkest secrets. If at any point you're asked to enable your microphone and webcam, just say yes. Here are the spaces that you can explore. In the lobby, these portals here will take you to different maps. These maps will change every two hours. You can always access the lobby if you have any queries or feel uncomfortably lost. We operate a one-way system in this party, so keep on going forwards and enjoy.",
          },
          {
            path: "/home/plantoidz/Downloads/ed_brittish_short.wav",
            ref_text: "Now what I will say to you up in Apolinario is that um the the future of Feytopia radio depends upon our embrace of the fantastical and not uh to be underestimated beauty of the human voice, uh, concerned as it is with the elimination of all forms of uh disparition and the the seizure, if one will, of what is so beautiful about the inclement perdition that surrounds each and every one of us as we wangle our way through the systematic imagination of uh evenly futures And beyond that, what I'd, you know, emphasise is that um not just Sonic Sphere and Mindmax, but the party on the moon too, and the as yet unpublished but much anticipated general theory of parties, is, of course like a systematic way of understanding the the fortune, the imagination, the beauty of everyday life, its um vicissitudes.",
          },
          {
            path: "/home/plantoidz/Downloads/ed_french_2.wav",
            ref_text: "This is Alan from uh the American uh grill. We have the American grill uh with the burgers. Uh it is just by a lagar. Uh it is very nice. Uh we have burgers, uh pizza, uh um Conetta ice cream. Uh it is uh great. Uh you come down here whenever you want. Uh we uh welcome the Feytopians",
          },
          {
            path: "/home/plantoidz/Downloads/shibley.wav",
            ref_text: "Good morning, Feytopia. This is Shibley. I'm coming in to ask you how do you feel about your eggs today? How could you be more egg? Has the egg entered your life? What is the meaning of egg? Did we all come from egg? Egg can mean a lot of things, such as the shape of your brain. The curvature of Polly's head. It is referential to the beginning of life. Some of you might remember egg from most notably Salvador Dali's house. And if you don't know how eggs claim to fame, well, let's talk to the chicken.",
          },
        ];
        const voice = voices[Math.floor(Math.random() * voices.length)];
        broadcastLog.info(`Voice: ${voice.path.split("/").pop()}`);

        const ttsRes = await fetch(`${TTS_API}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qwen3-tts",
            voice: "default",
            input: params.message,
            response_format: "wav",
            voice_path: voice.path,
            ref_text: voice.ref_text,
          }),
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
