/**
 * Feÿ-specific tool factories. These were hardcoded in src/tools/index.ts
 * but are community-specific (sauna readings, radio broadcasts, FeyOps
 * PMS lookups, season log). They now live here and get wired into the
 * tool list via `workspace/extensions/tools.ts`.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { FeyOpsDB } from "./db.js";
import type { MemoryManager } from "../../../src/memory/manager.js";
import { callMCPTool } from "../../../src/mcp/bridge.js";
import { createLogger } from "../../../src/core/logger.js";
import { recordEvent } from "../../../src/core/event-log.js";

const broadcastLog = createLogger("radio_broadcast");

/**
 * TTS service URL — Feÿ-specific, set at deployment startup from
 * `config.services.tts.url`. Deployments without TTS don't register
 * the radio_broadcast tool (workspace/extensions/tools.ts guards it).
 */
let TTS_API = "";

export function configureFeyopsTools(options: { ttsUrl?: string }): void {
  TTS_API = options.ttsUrl ?? "";
}

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

        recordEvent({
          type: "broadcast",
          message: params.message,
          voice: params.voice,
        });

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

