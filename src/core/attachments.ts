/**
 * Attachment processing — downloads, saves, and processes Signal attachments.
 *
 * Images: saved to workspace/media/, described via tiny LLM, returned as vision content.
 * Audio/Voice: saved to workspace/media/, transcribed via Whisper, returned as text.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tinyComplete } from "./tiny-llm.js";

/**
 * Runtime service URLs — set once at startup from config. If a URL is
 * empty, the corresponding feature degrades gracefully: no Whisper →
 * voice messages aren't transcribed; no SIGNAL_API → Signal attachments
 * can't be fetched (deployment isn't using Signal, so this never gets
 * called).
 */
let signalApiUrl = "";
let whisperUrl = "";

export function configureAttachmentServices(options: {
  signalApiUrl?: string;
  whisperUrl?: string;
}): void {
  signalApiUrl = options.signalApiUrl ?? "";
  whisperUrl = options.whisperUrl ?? "";
}

const MEDIA_DIR = join(process.cwd(), "workspace", "media");

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
  await mkdir(MEDIA_DIR, { recursive: true });

  const result: ProcessedAttachments = { images: [], transcriptions: [], logs: [] };

  for (const att of attachments) {
    try {
      const buffer = await downloadAttachment(att.id);
      if (!buffer) continue;

      const ext = att.contentType.split("/")[1]?.split(";")[0] || "bin";
      const filename = `${new Date().toISOString().slice(0, 10)}-${fromLabel.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.${ext}`;
      await writeFile(join(MEDIA_DIR, filename), buffer);

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
  if (!signalApiUrl) return null;
  const res = await fetch(`${signalApiUrl}/v1/attachments/${id}`, {
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
        { type: "text", text: "Describe this image in one sentence." },
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
