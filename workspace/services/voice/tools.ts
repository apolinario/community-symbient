/**
 * Voice message tool — generates TTS from a message and sends it as a Signal
 * audio attachment (DM or group). Uses the same TTS endpoint and voice
 * library as radio_broadcast, but routes the audio to Signal instead of FM.
 *
 * Voices come from workspace/voices.json (`[{name, path, ref_text}]`). The
 * `voice` param accepts a name, a workspace-relative wav path, or a TTS
 * library reference like `clone:iannis`. Omit for a random pick.
 *
 * Requires config.services.tts.url and a chat adapter.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ChatAdapter } from "../../../src/adapters/chat/types.js";
import type { MemoryManager } from "../../../src/memory/manager.js";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { createLogger } from "../../../src/core/logger.js";
import { recordEvent } from "../../../src/core/event-log.js";

const log = createLogger("send_voice_message");

interface VoiceEntry {
  name: string;
  path: string;
  ref_text: string;
}

async function loadVoices(workspacePath: string): Promise<VoiceEntry[]> {
  try {
    const raw = await readFile(join(workspacePath, "voices.json"), "utf-8");
    return JSON.parse(raw) as VoiceEntry[];
  } catch {
    return [];
  }
}

// Every voice in voices.json is registered as an OmniVoice profile
// (see voice_library/profiles/). We always send the TTS server a
// `clone:<name>` selector, which flows through the profile code path and
// triggers the disk-persisted voice-embed cache. No more voice_path /
// ref_text inline (those used to bypass the cache).
function resolveVoice(
  request: string | undefined,
  voices: VoiceEntry[],
): string {
  if (request?.startsWith("clone:")) return request;

  if (request) {
    const match = voices.find((v) => v.name === request || v.path === request || v.path.endsWith(`/${request}`));
    if (match) return `clone:${match.name}`;
    throw new Error(`Voice "${request}" not found. Available: ${voices.map((v) => v.name).join(", ") || "(none)"}. Or use clone:<id>.`);
  }

  if (voices.length === 0) throw new Error("No voices available in voices.json");
  const pick = voices[Math.floor(Math.random() * voices.length)];
  return `clone:${pick.name}`;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) fields[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

export function createSendVoiceMessageTool(deps: {
  workspacePath: string;
  ttsUrl: string;
  chatAdapter: ChatAdapter;
  memory: MemoryManager;
}): AgentTool {
  // Read voices synchronously at tool-creation time so the description lists
  // what's currently available. Requires voices.json to exist at startup;
  // editing it later needs a restart to refresh the tool description.
  let voiceNamesList = "(voices.json not found)";
  try {
    const raw = readFileSync(join(deps.workspacePath, "voices.json"), "utf-8");
    const voices = JSON.parse(raw) as VoiceEntry[];
    voiceNamesList = voices.map((v) => v.name).join(", ");
  } catch {
    // keep default
  }

  return {
    name: "send_voice_message",
    description:
      "Send a voice message to a person (DM) or group via Signal. " +
      "Generates TTS audio and attaches it. " +
      "Specify `to` (person name — resolved via people/*.md) OR `groupId` — exactly one. " +
      `Available voices: ${voiceNamesList}. ` +
      "Pass one of those names as `voice`, or use `clone:<id>` for the TTS library, or omit for a random community voice.",
    label: "Send Voice Message",
    parameters: Type.Object({
      to: Type.Optional(Type.String({ description: "Person name to DM (resolved via the directory). Required if groupId is not set." })),
      groupId: Type.Optional(Type.String({ description: "Signal group id. Required if to is not set." })),
      message: Type.String({ description: "Text to speak. Write like you'd actually talk — no emojis, no markdown, no URLs. TTS reads it aloud." }),
      voice: Type.Optional(Type.String({ description: "Voice selector: a name from voices.json, a workspace-relative wav path, or clone:<id>. Omit for random." })),
    }),
    execute: async (_id, params) => {
      if (!params.to && !params.groupId) {
        return { content: [{ type: "text", text: "Need either `to` or `groupId`." }], details: {} };
      }
      if (params.to && params.groupId) {
        return { content: [{ type: "text", text: "Set `to` OR `groupId`, not both." }], details: {} };
      }

      let recipient: string | undefined;
      if (params.to) {
        // Accept a raw Signal id (phone or UUID) as-is.
        if (/^\+\d{6,}$/.test(params.to) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(params.to)) {
          recipient = params.to;
        } else {
          const person = await deps.memory.findPerson(params.to);
          if (!person) {
            return { content: [{ type: "text", text: `Could not find "${params.to}" in people/.` }], details: {} };
          }
          const fm = parseFrontmatter(person.content);
          recipient = fm["signal-uuid"] ?? fm.signalUuid ?? fm["signal_uuid"] ?? fm.phone;
          if (!recipient) {
            return { content: [{ type: "text", text: `Found ${person.slug} but they have no signal-uuid or phone in their profile.` }], details: {} };
          }
        }
      }

      try {
        const voices = await loadVoices(deps.workspacePath);
        const voiceId = resolveVoice(params.voice, voices);
        log.info(`voice=${voiceId}`);

        const ttsBody: Record<string, unknown> = {
          model: "qwen3-tts",
          voice: voiceId,
          input: params.message,
          response_format: "wav",
        };

        const ttsRes = await fetch(`${deps.ttsUrl}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ttsBody),
          signal: AbortSignal.timeout(120000),
        });
        if (!ttsRes.ok) {
          const err = await ttsRes.text();
          return { content: [{ type: "text", text: `TTS error ${ttsRes.status}: ${err.slice(0, 200)}` }], details: {} };
        }

        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        const dataUri = `data:audio/aac;base64,${audioBuffer.toString("base64")}`;

        await deps.chatAdapter.send({
          to: recipient ?? "",
          groupId: params.groupId,
          text: "",
          attachments: [dataUri],
        });

        recordEvent({
          type: "voice_message",
          to: recipient ?? null,
          groupId: params.groupId ?? null,
          message: params.message,
          voice: voiceId,
        });

        return {
          content: [{
            type: "text",
            text: `Voice message sent (${audioBuffer.length} bytes) to ${params.to ?? `group ${params.groupId}`} with ${voiceId}.`,
          }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
        };
      }
    },
  };
}
