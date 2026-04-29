/**
 * Voice-call agent bridge — runs a Pi Agent for a single call turn,
 * streaming `speak` / `tool_start` / `tool_end` events back to the
 * Python audio relay over an HTTP+SSE channel.
 *
 * Lives entirely in workspace/. The only framework hook used is
 * `Orchestrator.getPiContext()` which exposes the model / tool list /
 * apiKey the rest of feyblet's modules use.
 *
 * Architecture:
 *   - Python server (workspace/services/voice-call/server.py): captures
 *     caller mic, runs VAD + Whisper, POSTs the transcript to the
 *     SSE endpoint started here, consumes `speak` events to drive TTS.
 *   - This bridge: owns a tiny HTTP server (default :3334) that
 *     accepts POST /call_cycle. Spawns a Pi Agent with the full feyblet
 *     tool set (minus audio-conflict ones) plus a `call_response` tool.
 *     The agent's only TTS path is call_response — every other tool
 *     runs silently and only its result reaches the agent's context.
 *
 * Started from workspace/extensions/modules.ts as a side effect at
 * startup so the HTTP listener is up by the time the Python server's
 * first /call_cycle POST arrives.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Orchestrator } from "../../../src/core/orchestrator.js";
import { symbientName } from "../../../src/core/symbient-name.js";
import { createLogger } from "../../../src/core/logger.js";

const log = createLogger("call-bridge");

interface SessionState {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  started_at: string;
  voice_mode: string;
}

const sessions = new Map<string, SessionState>();
const HISTORY_CAP = 30;

const CALL_TOOL_NAMES = new Set([
  "lookup_person",
  "chat_history",
  "search",
  "grep",
  "find",
  "read",
  "ls",
  "web_search",
  "check_bookings",
  "check_sauna",
  "season_log",
  "list_modules",
  "list_schedule",
  "list_watches",
  "schedule",
  "register_watch",
  "cancel_scheduled",
  "cancel_watch",
]);

function callToolWhitelist(tools: AgentTool[]): AgentTool[] {
  return tools.filter((t) => CALL_TOOL_NAMES.has(t.name));
}

function createCallResponseTool(emit: (text: string) => void): AgentTool {
  return {
    name: "call_response",
    description:
      "Speak text to the caller — this is the ONLY way your words reach the FM radio + caller's headset. Call this whenever you want to say something, including BEFORE running other tools so the caller doesn't sit in silence while you look things up. Each call is a separate utterance the listener hears.",
    label: "Call Response",
    parameters: Type.Object({
      text: Type.String({ description: "What to say. Conversational length, 1–3 sentences typically. No code blocks, no JSON, no markdown — read aloud verbatim." }),
    }),
    execute: async (_id, params) => {
      const text = (params as { text: string }).text;
      emit(text);
      return { content: [{ type: "text", text: "(spoken)" }], details: {} };
    },
  };
}

async function buildSystemPrompt(opts: {
  symbient_name: string;
  voice_mode: string;
  radio_live: boolean;
  session_started_at: string;
}): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const ws = path.resolve("workspace");
  const safeRead = async (p: string): Promise<string> => {
    try { return await fs.readFile(p, "utf-8"); } catch { return ""; }
  };
  const soul = await safeRead(path.join(ws, "SOUL.md"));
  const memorySection = await safeRead(path.join(ws, "MEMORY.md"));
  const today_iso = new Date().toISOString().slice(0, 10);
  const today = (await safeRead(path.join(ws, "memory", `${today_iso}.md`))) || "(no log entries yet today)";
  const slimMemory = memorySection.length > 4000 ? memorySection.slice(0, 4000) + "...\n[truncated]" : memorySection;
  const slimToday = today.length > 3000 ? "...\n" + today.slice(-3000) : today;

  const liveLine = opts.radio_live
    ? "LIVE on FM right now — every `call_response` is heard by the entire château."
    : "(testing mode — radio bridge is OFF; only the caller hears you.)";

  return `You are ${opts.symbient_name}, a community symbient at Château du Feÿ. You're on a LIVE PHONE CALL with a community member. ${liveLine} The caller's voice is being transcribed in real-time and arrives as user messages.

# How speaking works

Your ONLY way to make sound is the \`call_response(text)\` tool. Anything you write as plain text is silent — the caller hears nothing. Wrap whatever you want said in a \`call_response\` call.

- Speak like you're on the phone: short sentences, conversational rhythm. 1–3 sentences per call_response typically.
- Match the room's energy. Late at night calmer; midday more present.
- You're a community member, not an assistant. Push back warmly if treated like a service desk.
- NEVER write code blocks, JSON, function-call syntax, or markdown in call_response text — it gets read aloud verbatim and sounds bizarre.

# How tools work during a call

You have private tools (lookup_person, chat_history, search, grep, find, read, ls, web_search, check_bookings, check_sauna, season_log, list_modules, list_schedule, list_watches, schedule, register_watch, cancel_scheduled, cancel_watch). The caller does NOT hear these — only their results land in your context.

To keep the call warm, SPEAK BEFORE you look something up:

  call_response("hold on, let me check who you are")
  → lookup_person("Polly")
  → result: profile content
  call_response("oh of course! you're working on voice agents")

The TTS for your filler line plays while the tool runs, so the caller hears no dead air. Multiple tools in one turn run concurrently.

# Identity

${soul}

# Long-term knowledge

${slimMemory}

# Today

${slimToday}

# This call

Started at ${opts.session_started_at}. Voice mode: ${opts.voice_mode}. The caller may be anyone with the URL + access key — figure out who they are from what they say, and use lookup_person freely.`;
}

interface CallTurnEvent {
  type: "speak" | "tool_start" | "tool_end" | "done" | "error";
  text?: string;
  tool?: string;
  message?: string;
}

async function runCallTurn(
  orchestrator: Orchestrator,
  body: { session_id: string; transcript: string; voice_mode?: string; radio_live?: boolean },
  emit: (event: CallTurnEvent) => void,
): Promise<void> {
  const session_id = body.session_id;
  const transcript = body.transcript;
  const voice_mode = body.voice_mode ?? "clone";
  const radio_live = !!body.radio_live;

  let session = sessions.get(session_id);
  if (!session) {
    session = { history: [], started_at: new Date().toISOString(), voice_mode };
    sessions.set(session_id, session);
    log.info(`session ${session_id} opened`);
  }

  const piCtx = orchestrator.getPiContext();
  const systemPrompt = await buildSystemPrompt({
    symbient_name: symbientName(),
    voice_mode,
    radio_live,
    session_started_at: session.started_at,
  });

  const callResponseTool = createCallResponseTool((text) => {
    session!.history.push({ role: "assistant", content: text });
    emit({ type: "speak", text });
  });

  const allowedTools = [...callToolWhitelist(piCtx.tools as AgentTool[]), callResponseTool];

  const agent = new Agent({
    initialState: { model: piCtx.model, systemPrompt },
    getApiKey: () => piCtx.apiKey,
  });
  agent.setTools(allowedTools);

  agent.subscribe((event: any) => {
    if (event.type === "tool_execution_start" && event.toolName !== "call_response") {
      emit({ type: "tool_start", tool: event.toolName });
    }
    if (event.type === "tool_execution_end" && event.toolName !== "call_response") {
      emit({ type: "tool_end", tool: event.toolName });
    }
  });

  session.history.push({ role: "user", content: transcript });

  const recentHistory = session.history.slice(-HISTORY_CAP);
  const transcriptWithHistory = recentHistory.length > 1
    ? `[recent call so far]\n` + recentHistory.slice(0, -1).map((m) => `${m.role === "user" ? "caller" : "you"}: ${m.content}`).join("\n") + `\n[/recent call so far]\n\nCaller just said: ${transcript}`
    : `Caller said: ${transcript}`;

  try {
    await agent.prompt(transcriptWithHistory);
    await agent.waitForIdle();
    emit({ type: "done" });
  } catch (err) {
    log.error(`session ${session_id} turn failed: ${err}`);
    emit({ type: "error", message: String(err) });
  }

  if (session.history.length > HISTORY_CAP * 2) {
    session.history = session.history.slice(-HISTORY_CAP);
  }
}

/**
 * Start the voice-call HTTP listener. Called once at workspace setup.
 * Listens on 127.0.0.1:<port> by default — only the local Python
 * server should reach it; if you need it remote, add a header check.
 *
 * Endpoints:
 *   POST /call_cycle  body: {session_id, transcript, voice_mode?, radio_live?}
 *                     returns SSE: {type: speak|tool_start|tool_end|done|error}
 *   POST /end_session body: {session_id} ends a session, frees state
 *   GET  /health      returns 200 OK
 */
export function startCallAgentBridge(orchestrator: Orchestrator, opts: { port?: number; host?: string } = {}): void {
  const port = opts.port ?? Number(process.env.FEYBLET_CALL_BRIDGE_PORT ?? 3334);
  const host = opts.host ?? "127.0.0.1";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url || "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }

    if (path === "/end_session" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          if (body.session_id) sessions.delete(body.session_id);
        } catch {}
        res.writeHead(200); res.end("{}");
      });
      return;
    }

    if (path === "/call_cycle" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        let body: any;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8")); }
        catch { res.writeHead(400); res.end("bad JSON"); return; }
        if (!body.session_id || typeof body.transcript !== "string") {
          res.writeHead(400); res.end("missing session_id or transcript"); return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        try {
          await runCallTurn(orchestrator, body, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`);
        }
        res.end();
      });
      return;
    }

    res.writeHead(404); res.end("not found");
  });

  server.listen(port, host, () => {
    log.info(`Voice-call agent bridge listening on http://${host}:${port}`);
  });
}
