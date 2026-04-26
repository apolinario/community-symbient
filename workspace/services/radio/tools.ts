/**
 * Radio tools — FM broadcast via Radio MCP with TTS voice cloning.
 * Needs a TTS endpoint configured at deployment (config.services.tts.url).
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { callMCPTool } from "../../../src/mcp/bridge.js";
import { createLogger } from "../../../src/core/logger.js";
import { recordEvent } from "../../../src/core/event-log.js";

const broadcastLog = createLogger("radio_broadcast");

let TTS_API = "";
let workspacePath = "";
export function configureRadioTools(options: { ttsUrl?: string; workspacePath?: string }): void {
  TTS_API = options.ttsUrl ?? "";
  if (options.workspacePath) workspacePath = options.workspacePath;
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

        // All voices are registered as OmniVoice profiles (see voice_library/profiles/).
        // We always send `voice: "clone:<name>"` — this goes through the profile code
        // path in OmniVoice which passes cache_key to the backend, triggering the
        // disk-persisted voice-embed cache. No more voice_path/ref_text inline.
        const VOICE_POOL = [
          "primavera", "lou", "poli", "sparkle",
          "ed_british", "ed_french", "shibley", "sebnem", "elena", "iannis", "plantony",
        ];

        let voiceId: string;
        if (params.voice?.startsWith("clone:")) {
          voiceId = params.voice;
        } else if (params.voice && VOICE_POOL.includes(params.voice)) {
          voiceId = `clone:${params.voice}`;
        } else {
          // No voice specified (or unknown) — random pick from the pool
          voiceId = `clone:${VOICE_POOL[Math.floor(Math.random() * VOICE_POOL.length)]}`;
        }
        broadcastLog.info(`Voice: ${voiceId}`);

        const ttsBody: Record<string, any> = {
          model: "qwen3-tts",
          voice: voiceId,
          input: params.message,
          response_format: "wav",
        };

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

      const schedulePath = path.join(workspacePath, "radio", "schedule.json");
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
      const calPath = path.join(workspacePath, "radio", "calendar.json");

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
