/**
 * Attachment processing — downloads, saves, and analyses chat attachments.
 *
 * Images: saved to workspace/media/, described via tiny vision model, returned as vision content.
 * Audio/voice: saved to workspace/media/, transcribed via Whisper, returned as text.
 *
 * The framework fetches attachment binaries through a chat-adapter-provided
 * REST endpoint (`attachmentBaseUrl`). Only chat transports that expose
 * such an endpoint (e.g. signal-cli-rest-api at /v1/attachments/{id})
 * support attachment fetch; others should leave it unset and pass already-
 * downloaded buffers some other way.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tinyComplete } from "./tiny-llm.js";
import { prompt } from "./prompts.js";

let attachmentBaseUrl = "";
let whisperUrl = "";

export function configureAttachmentServices(options: {
  /** REST base URL of the chat adapter's attachment fetcher. The framework
   *  appends `/v1/attachments/{id}` (signal-cli-rest-api shape). Leave
   *  unset for adapters without REST attachment fetch. */
  attachmentBaseUrl?: string;
  /** Whisper-compatible /v1/audio/transcriptions endpoint. */
  whisperUrl?: string;
  /** Workspace root. Attachments are written under `<workspacePath>/media/`. */
  workspacePath?: string;
}): void {
  attachmentBaseUrl = options.attachmentBaseUrl ?? "";
  whisperUrl = options.whisperUrl ?? "";
  if (options.workspacePath) {
    mediaDir = join(options.workspacePath, "media");
  }
}

// Resolved at startup via configureAttachmentServices(). The cwd-based
// fallback only fires if a deployment forgets to wire it — keeps the
// module functional but a deliberate config call is the supported path.
let mediaDir = join(process.cwd(), "workspace", "media");

export interface Attachment {
  id: string;
  contentType: string;
  filename?: string;
  size: number;
}

export interface ProcessedAttachments {
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  transcriptions: string[];
  logs: string[];
}

export async function processAttachments(
  attachments: Attachment[],
  fromLabel: string,
): Promise<ProcessedAttachments> {
  await mkdir(mediaDir, { recursive: true });

  const result: ProcessedAttachments = { images: [], transcriptions: [], logs: [] };

  for (const att of attachments) {
    try {
      const buffer = await downloadAttachment(att.id);
      if (!buffer) continue;

      const ext = att.contentType.split("/")[1]?.split(";")[0] || "bin";
      const filename = `${new Date().toISOString().slice(0, 10)}-${fromLabel.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.${ext}`;
      await writeFile(join(mediaDir, filename), buffer);

      if (att.contentType.startsWith("image/")) {
        await processImage(buffer, att.contentType, filename, fromLabel, result);
      } else if (att.contentType.startsWith("audio/")) {
        await processAudio(buffer, att.contentType, ext, filename, fromLabel, result);
      }
    } catch (err) {
      result.logs.push(`Failed to process attachment ${att.id}: ${err}`);
    }
  }

  return result;
}

async function downloadAttachment(id: string): Promise<Buffer | null> {
  if (!attachmentBaseUrl) return null;
  const res = await fetch(`${attachmentBaseUrl}/v1/attachments/${id}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function processImage(
  buffer: Buffer,
  contentType: string,
  filename: string,
  fromLabel: string,
  result: ProcessedAttachments,
): Promise<void> {
  const b64 = buffer.toString("base64");
  result.images.push({ type: "image", data: b64, mimeType: contentType });
  result.logs.push(`Image saved: workspace/media/${filename} (${Math.round(buffer.length / 1024)}KB)`);

  // Describe via tiny vision model
  let desc = "image";
  try {
    const text = await tinyComplete({
      messages: [{ role: "user", content: [
        { type: "text", text: prompt("describe-image") },
        { type: "image_url", image_url: { url: `data:${contentType};base64,${b64}` } },
      ]}],
      maxTokens: 50,
      timeoutMs: 10000,
    });
    if (text) {
      desc = text;
      result.logs.push(`Image description: ${desc}`);
    }
  } catch {}

  result.logs.push(`memory:*[Image from ${fromLabel}]* ${desc} (workspace/media/${filename})`);
}

async function processAudio(
  buffer: Buffer,
  contentType: string,
  ext: string,
  filename: string,
  fromLabel: string,
  result: ProcessedAttachments,
): Promise<void> {
  result.logs.push(`Voice saved: workspace/media/${filename} (${Math.round(buffer.length / 1024)}KB)`);

  if (!whisperUrl) {
    result.transcriptions.push(`[voice message from ${fromLabel} — transcription unavailable; configure config.services.whisper.url]`);
    return;
  }

  try {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: contentType }), `voice.${ext}`);
    formData.append("model", "base");

    const res = await fetch(`${whisperUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (res.ok) {
      const data = await res.json() as any;
      const transcript = data.text?.trim();
      if (transcript) {
        result.transcriptions.push(transcript);
        result.logs.push(`Voice transcription: ${transcript.slice(0, 200)}`);
        result.logs.push(`memory:*[Voice from ${fromLabel}]* "${transcript}"`);
      }
    } else {
      result.logs.push(`Whisper error: ${res.status}`);
    }
  } catch (err) {
    result.logs.push(`Whisper error: ${err}`);
  }
}
