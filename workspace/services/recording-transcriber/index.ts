/**
 * Recording transcriber — passive helper that watches the radio MCP's
 * recording state and produces a transcript + summary markdown file
 * per recording session.
 *
 * Loop:
 *   1. Poll GET {RADIO_MCP}/recordings/status every POLL_INTERVAL_MS.
 *   2. On `is_recording` transition false → true: open a new
 *      `workspace/recordings/<YYYY-MM-DD_HH-MM-SS>.md`, open the audio
 *      stream at /stream/live, start chunked transcription.
 *   3. While recording: every CHUNK_DURATION_MS, slice the buffered
 *      MP3 bytes into a chunk file and POST to Whisper. Append the
 *      transcript line to the .md with its timestamp.
 *   4. On `is_recording` transition true → false: drain the final
 *      chunk, ask the LLM for a summary of the full transcript, and
 *      prepend that summary section to the .md.
 *
 * Feyblet's modules can opt into seeing these recordings via a new
 * `recent-recordings` context provider (workspace/extensions/providers.ts).
 *
 * Started from workspace/extensions/modules.ts as a side-effect at
 * startup. Independent of feyblet's Pi-Agent loops; keeps polling +
 * transcribing even when no module is active.
 */

import { request as httpRequest } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LLMClient } from "../../../src/core/types.js";
import { createLogger } from "../../../src/core/logger.js";

const log = createLogger("rec-transcribe");

const RADIO_MCP_URL = process.env.FEYBLET_RADIO_MCP_URL ?? "http://192.168.10.97:8000";
const WHISPER_URL = process.env.FEYBLET_WHISPER_URL ?? "http://localhost:8001";

const POLL_INTERVAL_MS = 5_000;       // status check cadence
const CHUNK_DURATION_MS = 30_000;     // 30 s of MP3 per Whisper request
const STREAM_TIMEOUT_MS = 120_000;    // bail if no bytes for 2 min
const WHISPER_PROMPT = "feyblet, Feÿtopia, château, Feÿnale, sauna, season";

interface RecordingStatus {
  is_recording: boolean;
  auto_record: boolean;
  current_file: string | null;
  started_at: string | null;
  current_size_bytes: number;
  rotate_seconds: number;
  live_stream_url?: string;
}

interface ActiveSession {
  startedAt: Date;
  mdPath: string;
  abort: AbortController;        // cancels the stream + flush loop on stop
  bytesSinceFlush: Buffer[];     // MP3 bytes accumulated since last flush
  flushTimer: NodeJS.Timeout;    // periodic Whisper flush
  transcript: string[];          // every appended line, kept in memory for summary
}

let session: ActiveSession | null = null;
let lastIsRecording = false;
let pollTimer: NodeJS.Timeout | null = null;
let workspacePath = "";
let llm: LLMClient | null = null;

// ── public entry point ──────────────────────────────────────────────

export interface RecordingTranscriberDeps {
  workspacePath: string;
  llm: LLMClient;
}

export function startRecordingTranscriber(deps: RecordingTranscriberDeps): void {
  workspacePath = deps.workspacePath;
  llm = deps.llm;
  log.info(`watching ${RADIO_MCP_URL}/recordings/status (poll ${POLL_INTERVAL_MS / 1000}s)`);
  pollTimer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  // Run one tick immediately so an in-progress recording at startup is
  // picked up without waiting POLL_INTERVAL_MS.
  void pollOnce();
}

// ── polling + state machine ─────────────────────────────────────────

async function pollOnce(): Promise<void> {
  let status: RecordingStatus;
  try {
    const res = await fetch(`${RADIO_MCP_URL}/recordings/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      log.warn(`status ${res.status}`);
      return;
    }
    status = await res.json() as RecordingStatus;
  } catch (err) {
    // MCP unreachable — silent retry next tick. Don't spam logs.
    return;
  }

  if (status.is_recording && !lastIsRecording) {
    await onRecordingStarted(status);
  } else if (!status.is_recording && lastIsRecording) {
    await onRecordingStopped();
  }
  lastIsRecording = status.is_recording;
}

async function onRecordingStarted(status: RecordingStatus): Promise<void> {
  if (session) {
    log.warn("recording started but a session is already active — ignoring");
    return;
  }
  const startedAt = new Date();
  const stamp = formatStamp(startedAt);
  const mdPath = join(resolve(workspacePath), "recordings", `${stamp}.md`);
  await mkdir(dirname(mdPath), { recursive: true });

  // Initial frontmatter + header. Summary section is prepended later
  // when the recording stops; for now leave a stub so the file is
  // always parsable mid-recording.
  const frontmatter = [
    "---",
    `started: ${startedAt.toISOString()}`,
    `source-file: ${status.current_file ?? ""}`,
    `status: in-progress`,
    "---",
    "",
    `# Recording — ${stamp}`,
    "",
    "## Transcript (live, appended every ~30s as Whisper completes each chunk)",
    "",
  ].join("\n");
  await writeFile(mdPath, frontmatter, "utf-8");

  const abort = new AbortController();
  session = {
    startedAt,
    mdPath,
    abort,
    bytesSinceFlush: [],
    flushTimer: setInterval(() => { void flushChunk(); }, CHUNK_DURATION_MS),
    transcript: [],
  };

  log.info(`recording started → ${mdPath}`);
  void streamLive(abort.signal);
}

async function onRecordingStopped(): Promise<void> {
  if (!session) return;
  log.info(`recording stopped → ${session.mdPath} (finalising)`);
  const s = session;
  session = null;
  clearInterval(s.flushTimer);
  s.abort.abort();

  // Drain anything still buffered before summarising.
  await flushChunk(s);

  if (!llm) {
    log.warn("no LLM client; skipping summary");
    return;
  }
  try {
    const fullTranscript = s.transcript.join("\n").trim();
    if (!fullTranscript) {
      log.info("empty transcript — skipping summary");
      await markFinalized(s.mdPath, s.startedAt, "(no audio captured)");
      return;
    }
    const summary = await llm.complete({
      system: "You are summarising a Château du Feÿ recording transcript. Produce 3–6 short bullet points capturing the substance. Plain text, no markdown bullet syntax — one fact per line. Be specific (names, numbers, decisions). Skip filler.",
      messages: [{ role: "user", content: fullTranscript.slice(-12000) }], // tail; safe with most context windows
      maxTokens: 400,
      temperature: 0.3,
    });
    await markFinalized(s.mdPath, s.startedAt, summary.trim());
    log.info(`finalised ${s.mdPath} (${fullTranscript.length} chars transcript, ${summary.length} chars summary)`);
  } catch (err) {
    log.error(`summarise failed: ${err}`);
    await markFinalized(s.mdPath, s.startedAt, `(summary failed: ${String(err)})`).catch(() => {});
  }
}

// ── live MP3 stream + Whisper chunking ──────────────────────────────

function streamLive(signal: AbortSignal): void {
  const url = new URL(`${RADIO_MCP_URL}/stream/live`);
  let lastByteAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > STREAM_TIMEOUT_MS) {
      log.warn("stream silent past timeout — aborting");
      try { req.destroy(); } catch {}
    }
  }, 10_000);

  const req = httpRequest({
    method: "GET",
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    timeout: STREAM_TIMEOUT_MS,
  }, (res) => {
    if (res.statusCode !== 200) {
      log.error(`stream status ${res.statusCode}`);
      clearInterval(watchdog);
      return;
    }
    res.on("data", (chunk: Buffer) => {
      lastByteAt = Date.now();
      session?.bytesSinceFlush.push(chunk);
    });
    res.on("end", () => {
      clearInterval(watchdog);
      log.info("stream ended (server closed)");
    });
    res.on("error", (err) => {
      clearInterval(watchdog);
      log.warn(`stream error: ${err}`);
    });
  });
  req.on("error", (err) => {
    clearInterval(watchdog);
    log.warn(`stream connect error: ${err}`);
  });
  signal.addEventListener("abort", () => {
    try { req.destroy(); } catch {}
    clearInterval(watchdog);
  });
  req.end();
}

async function flushChunk(forceSession?: ActiveSession): Promise<void> {
  const s = forceSession ?? session;
  if (!s) return;
  if (s.bytesSinceFlush.length === 0) return;

  const mp3 = Buffer.concat(s.bytesSinceFlush);
  s.bytesSinceFlush = [];
  // Skip tiny chunks (< ~0.5s of MP3) — usually just startup noise or
  // tail-end of a recording stop. Whisper returns nothing useful from
  // those and they cost a request.
  if (mp3.length < 4_000) {
    log.info(`skipping tiny chunk (${mp3.length}B)`);
    return;
  }

  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS UTC
  try {
    const text = await transcribeMp3(mp3);
    if (!text.trim()) return;
    const line = `**[${ts}]** ${text.trim()}\n\n`;
    s.transcript.push(`[${ts}] ${text.trim()}`);
    await appendFile(s.mdPath, line, "utf-8");
  } catch (err) {
    log.warn(`whisper failed (${mp3.length}B chunk): ${err}`);
    // Don't stop the session on a single chunk failure — the next one
    // will be attempted normally.
  }
}

async function transcribeMp3(mp3: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([mp3], { type: "audio/mpeg" }), "chunk.mp3");
  form.append("prompt", WHISPER_PROMPT);
  // Whisper service expects multipart/form-data — fetch handles the
  // boundary automatically when body is FormData.
  const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`whisper ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const j = await res.json() as { text?: string };
  return (j.text ?? "").trim();
}

// ── finalisation ────────────────────────────────────────────────────

async function markFinalized(mdPath: string, startedAt: Date, summary: string): Promise<void> {
  const endedAt = new Date();
  const existing = await readFile(mdPath, "utf-8");
  // Replace the in-progress frontmatter + insert a Summary section
  // BEFORE the Transcript section so readers (and the context
  // provider) see the takeaways first.
  const updated = existing
    .replace(/^---\n[\s\S]*?\n---\n/, [
      "---",
      `started: ${startedAt.toISOString()}`,
      `ended: ${endedAt.toISOString()}`,
      `duration_seconds: ${Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)}`,
      `status: complete`,
      "---",
      "",
    ].join("\n"))
    .replace(/^## Transcript /m, [
      "## Summary",
      "",
      summary,
      "",
      "## Transcript ",
    ].join("\n"));
  await writeFile(mdPath, updated, "utf-8");
}

function formatStamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
