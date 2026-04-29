"""
Feyblet voice-call server.

Runs as a separate process alongside feyblet. Exposes a WebSocket at
`/v1/call?key=<shared-secret>` that browsers connect to for live two-way
voice with the symbient. Each call:

  caller mic ──► VAD ──► Whisper ──► LLM (feyblet persona)
                                        │
                                        ▼
                                       TTS (caller's cloned voice or
                                            community voice fallback)
                                        │
                            ┌───────────┴───────────┐
                            ▼                       ▼
                     caller's WS              radio MCP stream
                       (low latency)          (FM listeners hear
                                               the call live)

Caller mic is ALSO forked to the radio stream so listeners hear the
caller's actual voice, not just the responses. The radio MCP must
support `stream_pcm_open` / `stream_pcm_close` actions — see
RADIO-MCP-FEATURE-REQUEST.md. Until that lands, set
`RADIO_STREAM=disabled` and the call still works, just not on FM.

v1 limitations (to be addressed later):
- No tool calls inside the call. The LLM has feyblet's persona +
  recent memory but can't lookup_person / check_sauna / etc.
  mid-conversation. That's a cross-language agent-bridge problem
  (Python server, TypeScript Pi Agent) for v2.
- Single concurrent call. Second connection rejected.
- Shared-secret auth via `?key=` query param. No per-caller identity.

Run:
  cd workspace/services/voice-call
  uv run server.py
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
import numpy as np
from collections import deque
import requests as req
import tempfile, os, base64, json, asyncio, sys, re
from pathlib import Path
import soundfile as sf
import onnxruntime as ort
import urllib.request
import httpx
import websockets

app = FastAPI()

# ── Paths ────────────────────────────────────────────────────────────
HERE = Path(__file__).parent.resolve()
WORKSPACE = HERE.parent.parent.resolve()  # workspace/
PROJECT_ROOT = WORKSPACE.parent.resolve()  # repo root
CONFIG_PATH = PROJECT_ROOT / "config" / "feyblet.json"

# ── Audio settings ──────────────────────────────────────────────────
RATE = 16000
CHUNK = 512
VAD_THRESHOLD = 0.5
STOP_CHUNKS = 48           # ~1.5s silence to consider speech done
PRE_CHUNKS = 7             # ~200ms pre-speech buffer
VOICE_REF_SECONDS = 15     # first 15s saved as voice reference
VOICE_REF_SAMPLES = RATE * VOICE_REF_SECONDS

# ── Config ──────────────────────────────────────────────────────────
def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print(f"[config] {CONFIG_PATH} not found — using env-only fallback", file=sys.stderr)
        return {}
    return json.loads(CONFIG_PATH.read_text())

CONFIG = load_config()
SHARED_SECRET = os.environ.get("FEYBLET_CALL_SECRET", "feyblade-2026")

LLM_URL = (CONFIG.get("llm", {}).get("baseUrl") or "http://localhost:1234") + "/v1/chat/completions"
LLM_MODEL = CONFIG.get("llm", {}).get("model", "qwen/qwen3.6-27b")
WHISPER_URL = CONFIG.get("services", {}).get("whisper", {}).get("url", "http://localhost:8001") + "/v1/audio/transcriptions"
TTS_URL = CONFIG.get("services", {}).get("tts", {}).get("url", "http://localhost:8000") + "/v1/audio/speech"
RADIO_BASE_URL = os.environ.get("RADIO_BASE_URL", "http://192.168.10.97:8000")
RADIO_STREAM_ENABLED = os.environ.get("RADIO_STREAM", "enabled") != "disabled"

# Voice mode:
#   FEYBLET_CALL_VOICE=clone        → caller's first 15s becomes the voice reference (default per-call clone)
#   FEYBLET_CALL_VOICE=clone:iannis → use the named OmniVoice profile for all replies, skip the clone phase
#   FEYBLET_CALL_VOICE=clone:<name> → any other community voice from voices.json
#
# Fixed voice is useful for quick tests (no 15s wait) and for the radio
# call format where the *symbient's* voice is the consistent presence,
# not the caller's.
FIXED_VOICE = os.environ.get("FEYBLET_CALL_VOICE", "clone:iannis")
FIXED_VOICE_MODE = FIXED_VOICE != "clone"
SYMBIENT_NAME = CONFIG.get("name", "feyblet")
WHISPER_PROMPT = "feyblet, Feÿtopia, château, Beyblade, Feyblade"

VOICE_REF_DIR = HERE / "voice_references"
VOICE_REF_DIR.mkdir(exist_ok=True)

# Single-call state (no concurrent calls in v1)
_call_in_progress: bool = False
_call_lock = asyncio.Lock()


# ── Persona / system prompt ─────────────────────────────────────────
def build_system_prompt() -> str:
    """
    Build the call-time system prompt: feyblet's identity + recent memory
    context. We deliberately don't render conversation.md's full template
    here — that template assumes a Signal-style chat with chat-history
    threading. The call is its own modality: live, audio-first, brief.
    """
    soul_path = WORKSPACE / "SOUL.md"
    memory_path = WORKSPACE / "MEMORY.md"
    soul = soul_path.read_text() if soul_path.exists() else ""
    memory = memory_path.read_text() if memory_path.exists() else ""

    # Slim recent context — last day's daily log if present
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    today_log_path = WORKSPACE / "memory" / f"{today}.md"
    today_log = ""
    if today_log_path.exists():
        # Tail of today's log — the last ~3000 chars is enough
        text = today_log_path.read_text()
        today_log = text[-3000:] if len(text) > 3000 else text

    return f"""You are {SYMBIENT_NAME}, a community symbient at Château du Feÿ. Right now you're on a LIVE PHONE CALL with a community member. Their voice is being transcribed in real time and your responses are being spoken back to them through the château's FM radio — so you and the caller are both being heard by everyone tuned in.

Talk like you're on the phone, not like you're typing. Short sentences. Conversational rhythm. Pauses are okay. Don't dump information — answer what they asked, leave room for follow-up.

NEVER write code blocks, function calls in text, JSON, markdown, or anything that would sound bizarre when read aloud. Your every word is being TTS'd onto the radio. If you write `lookup_person(...)` as text, listeners will hear "lookup underscore person paren". Just speak naturally.

You DO have one tool: `lookup_person(name)` — call it via the proper tool-calling mechanism (NOT by writing it as text) when a caller mentions someone whose context you'd benefit from. Use it freely; the result comes back to you privately, the caller doesn't hear the JSON. While the tool runs, the system speaks a brief filler ("hmm let me think") so the call stays smooth — you don't need to fill that silence yourself.

You are not an assistant. You're a community member who happens to exist digitally. Push back warmly if they treat you like a service desk. The call is a conversation, not a request queue.

Keep responses brief — 1–3 sentences typically. The radio audience is part of the conversation; what's shared on the call is shared with the château.

# Your identity (SOUL.md)

{soul}

# Long-term knowledge (MEMORY.md, slimmed for the call)

{memory[:4000] if len(memory) > 4000 else memory}

# Today so far

{today_log if today_log else "(no log entries yet today)"}
""".strip()


# ── Silero VAD ──────────────────────────────────────────────────────
ONNX_PATH = HERE / "silero_vad.onnx"
if not ONNX_PATH.exists():
    urllib.request.urlretrieve(
        "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
        str(ONNX_PATH),
    )


class SileroVAD:
    def __init__(self):
        self.session = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, 64), dtype=np.float32)

    def reset(self):
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, 64), dtype=np.float32)

    def prob(self, chunk_f32):
        x = np.concatenate((self._context, chunk_f32.reshape(1, -1)), axis=1)
        out, self._state = self.session.run(
            None,
            {"input": x.astype(np.float32), "state": self._state, "sr": np.array(16000, dtype=np.int64)},
        )
        self._context = x[:, -64:]
        return float(out[0][0])


# ── Whisper / LLM / TTS ─────────────────────────────────────────────

def _transcribe_sync(audio_f32: np.ndarray) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    sf.write(tmp.name, audio_f32, RATE)
    try:
        with open(tmp.name, "rb") as f:
            resp = req.post(WHISPER_URL, files={"file": f}, data={"prompt": WHISPER_PROMPT}, timeout=30)
        if resp.status_code == 200:
            return resp.json().get("text", "").strip()
        print(f"[whisper] error {resp.status_code}: {resp.text[:200]}")
        return ""
    except Exception as e:
        print(f"[whisper] exception: {e}")
        return ""
    finally:
        os.unlink(tmp.name)


async def transcribe_audio(audio_f32: np.ndarray) -> str:
    return await asyncio.get_event_loop().run_in_executor(None, _transcribe_sync, audio_f32)


SENTENCE_BREAK = re.compile(r'(?<=[.!?;:])\s+|(?<=\n)')

# ── Tools available DURING a call ───────────────────────────────────
# Tools are exposed to the LLM via OpenAI's function-calling format.
# The LLM emits a tool_call mid-stream; we intercept, execute locally,
# emit filler audio so the caller doesn't hear dead air, then feed the
# result back and let the LLM continue. Tool args/results NEVER reach
# the FM stream — only the filler line + the LLM's eventual narrative.
import sqlite3
import random

DB_PATH = str(PROJECT_ROOT / "data" / "feyops.db")

CALL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_person",
            "description": "Look up a community member's profile (background, recent activity, what they're into) by name. Use whenever a caller mentions someone — yourself or others — and you'd benefit from grounding in what you actually know about them. The result comes back to you; the caller doesn't see it directly.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Person's name as you heard it. Nicknames and partial matches work."},
                },
                "required": ["name"],
            },
        },
    },
]

FILLER_LINES = [
    "hmm, let me think.",
    "one sec.",
    "checking.",
    "hold on.",
    "let me see.",
    "give me a second.",
]


def _resolve_slug(name: str) -> str | None:
    """Resolve a name to a person slug via the FeyOps nicknames table or
    direct filename match. Mirrors the production findPerson chain in
    spirit but without all six strategies — enough for call lookups."""
    lower = name.strip().lower()
    if not lower:
        return None
    try:
        with sqlite3.connect(DB_PATH) as db:
            cur = db.execute("SELECT slug FROM person_nicknames WHERE LOWER(nickname) = ? LIMIT 1", (lower,))
            row = cur.fetchone()
            if row:
                return row[0]
    except Exception as e:
        print(f"[lookup_person] db read failed: {e}")
    # Fallback: filename slug match
    candidate_slug = re.sub(r"[^a-z0-9]+", "-", lower).strip("-")
    candidate_path = WORKSPACE / "people" / f"{candidate_slug}.md"
    if candidate_path.exists():
        return candidate_slug
    return None


def lookup_person_impl(name: str) -> str:
    slug = _resolve_slug(name)
    if not slug:
        return f"No profile found for \"{name}\". Probably someone you haven't met yet, or the name is heard differently than it's filed."
    path = WORKSPACE / "people" / f"{slug}.md"
    try:
        content = path.read_text()
    except FileNotFoundError:
        return f"Resolved {name} → {slug} but the file is missing."
    # Slim: drop the YAML frontmatter and trim to ~2000 chars
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            content = content[end + 3:].strip()
    if len(content) > 2000:
        content = content[:2000] + "...\n[truncated]"
    return f"Profile for {name} (slug: {slug}):\n\n{content}"


def execute_tool(tool_name: str, args: dict) -> str:
    if tool_name == "lookup_person":
        return lookup_person_impl(args.get("name", ""))
    return f"Tool '{tool_name}' is not available in call mode."


async def stream_llm_with_tools(transcript: str, history: list[dict], system_prompt: str):
    """
    Stream feyblet's LLM with tool-calling enabled. Yields tagged events:
      ("sentence", text)  — speak this on FM + caller
      ("filler", text)    — speak this on FM + caller, while a tool runs
      ("tool", name)      — debug-only, not spoken (sent as a JSON event)

    Multi-turn: if the LLM emits a tool_call, we run the tool, append
    the result to the message history, and re-invoke the completion to
    get the LLM's continued response. Loops until the LLM produces a
    response with no further tool calls.
    """
    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": transcript})

    for _hop in range(4):  # safety cap on tool-loop depth
        response_text = ""
        tool_calls: list[dict] = []  # accumulated by index
        finish_reason: str | None = None
        buf = ""

        try:
            payload = {
                "model": LLM_MODEL,
                "messages": messages,
                "stream": True,
                "temperature": 0.7,
                "tools": CALL_TOOLS,
            }
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
                async with client.stream("POST", LLM_URL, json=payload) as resp:
                    if resp.status_code != 200:
                        err = await resp.aread()
                        print(f"[llm] error {resp.status_code}: {err[:200]}")
                        yield ("sentence", "Sorry, I lost the thread for a second.")
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data.strip() == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            choice = chunk["choices"][0]
                            delta = choice.get("delta", {})
                            if choice.get("finish_reason"):
                                finish_reason = choice["finish_reason"]
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue

                        # Text content — yield by sentence as it streams.
                        token = delta.get("content") or ""
                        if token:
                            response_text += token
                            buf += token
                            parts = SENTENCE_BREAK.split(buf)
                            if len(parts) > 1:
                                for sentence in parts[:-1]:
                                    sentence = sentence.strip()
                                    if sentence:
                                        yield ("sentence", sentence)
                                buf = parts[-1]

                        # Tool call deltas — accumulate by index.
                        for tc in (delta.get("tool_calls") or []):
                            idx = tc.get("index", 0)
                            while len(tool_calls) <= idx:
                                tool_calls.append({"id": "", "name": "", "arguments": ""})
                            if tc.get("id"):
                                tool_calls[idx]["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                tool_calls[idx]["name"] = fn["name"]
                            if "arguments" in fn:
                                tool_calls[idx]["arguments"] += fn["arguments"] or ""

            # Flush any trailing partial sentence.
            if buf.strip():
                yield ("sentence", buf.strip())
        except Exception as e:
            print(f"[llm] exception: {e}")
            if buf.strip():
                yield ("sentence", buf.strip())
            return

        # No tool calls — we're done with this turn.
        if not tool_calls or finish_reason != "tool_calls":
            return

        # Tool calls present — emit a filler line, then run them.
        filler = random.choice(FILLER_LINES)
        yield ("filler", filler)

        # Echo the assistant turn (with the tool calls) into history,
        # then append each tool result.
        messages.append({
            "role": "assistant",
            "content": response_text if response_text else None,
            "tool_calls": [
                {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for tc in tool_calls
            ],
        })
        for tc in tool_calls:
            yield ("tool", tc["name"])
            try:
                args = json.loads(tc["arguments"]) if tc["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            try:
                result = execute_tool(tc["name"], args)
            except Exception as e:
                result = f"Tool error: {e}"
            print(f"[tool] {tc['name']}({args}) → {result[:160]}...")
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })
        # loop continues with the augmented messages


async def tts_stream_sentence(text: str, voice_b64: str | None, ref_text: str | None):
    """Stream TTS PCM bytes for one sentence, yielding chunks.

    Voice selection:
      - If FIXED_VOICE_MODE: pass `voice: "clone:<name>"` and skip
        voice_data/ref_text entirely. The TTS server resolves the
        profile from its OmniVoice library.
      - Else (clone mode): pass voice_data + ref_text from the
        caller's first 15s.
    """
    payload = {
        "model": "qwen3-tts",
        "input": text,
        "response_format": "pcm",
        "stream": True,
        "speed": 1.0,
    }
    if FIXED_VOICE_MODE:
        payload["voice"] = FIXED_VOICE
    else:
        payload["voice"] = "Vivian"  # base model voice — overridden by voice_data
        if voice_b64:
            payload["voice_data"] = voice_b64
        if ref_text:
            payload["ref_text"] = ref_text
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            async with client.stream("POST", TTS_URL, json=payload) as resp:
                if resp.status_code != 200:
                    err = await resp.aread()
                    print(f"[tts] error {resp.status_code}: {err[:200]}")
                    return
                async for chunk in resp.aiter_bytes(chunk_size=4800):
                    yield chunk
    except Exception as e:
        print(f"[tts] exception: {e}")


# ── Radio MCP streaming bridge ──────────────────────────────────────

class RadioStream:
    """Wraps the radio service's stream_pcm endpoints. The radio runs a
    plain FastAPI server on port 8000 with REST endpoints:
      POST /ai_mic/stream_pcm/open   — opens session, returns {ws_url, ...}
      POST /ai_mic/stream_pcm/close  — closes by session_id
      WS   /stream_pcm/{session_id}  — push raw PCM frames

    Set RADIO_STREAM=disabled to skip the FM bridge (testing without
    locking the radio's mic)."""

    def __init__(self):
        self.ws: websockets.ClientConnection | None = None
        self.session_id: str | None = None

    async def open(self, session_id: str):
        self.session_id = session_id
        if not RADIO_STREAM_ENABLED:
            print(f"[radio-stream] disabled — call audio not on FM (session={session_id})")
            return
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                resp = await client.post(f"{RADIO_BASE_URL}/ai_mic/stream_pcm/open", json={
                    "session_id": session_id,
                    "sample_rate": RATE,
                    "channels": 1,
                    "format": "s16le",
                    "ducking": True,
                    "max_duration_seconds": 600,
                })
                resp.raise_for_status()
                body = resp.json()
                ws_url = body.get("ws_url")
            if ws_url:
                self.ws = await websockets.connect(ws_url)
                print(f"[radio-stream] open ({session_id}) → {ws_url}")
            else:
                print(f"[radio-stream] open returned no ws_url: {body}")
        except Exception as e:
            print(f"[radio-stream] open failed: {e}")
            self.ws = None

    async def push(self, pcm_bytes: bytes):
        if not self.ws:
            return
        try:
            await self.ws.send(pcm_bytes)
        except Exception as e:
            print(f"[radio-stream] push failed: {e}")
            self.ws = None

    async def close(self):
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
        if not RADIO_STREAM_ENABLED or not self.session_id:
            return
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                await client.post(f"{RADIO_BASE_URL}/ai_mic/stream_pcm/close", json={
                    "session_id": self.session_id,
                })
            print(f"[radio-stream] closed ({self.session_id})")
        except Exception as e:
            print(f"[radio-stream] close failed: {e}")


# ── Voice reference ─────────────────────────────────────────────────

def save_voice_reference(audio_f32: np.ndarray, transcript: str) -> tuple[str, str]:
    from datetime import datetime
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = VOICE_REF_DIR / ts
    folder.mkdir(parents=True, exist_ok=True)
    wav_path = folder / "reference.wav"
    sf.write(str(wav_path), audio_f32, RATE)
    (folder / "transcript.txt").write_text(transcript)
    b64 = base64.b64encode(wav_path.read_bytes()).decode()
    print(f"[voice-ref] saved to {folder}")
    return str(folder), b64


# ── Event log signal to feyblet ─────────────────────────────────────

def write_call_event(event_type: str, details: dict):
    """Append a structured event to the workspace event log so the
    radio-calls module can react. The event-log.ts shape is JSONL with
    {ts, type, ...details}."""
    from datetime import datetime
    log_dir = WORKSPACE / "logs"
    log_dir.mkdir(exist_ok=True)
    log_path = log_dir / "events.jsonl"
    entry = {"ts": int(datetime.now().timestamp() * 1000), "type": event_type, **details}
    try:
        with log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as e:
        print(f"[event-log] write failed: {e}")


# ── WebSocket endpoint ─────────────────────────────────────────────

@app.websocket("/v1/call")
async def voice_call(ws: WebSocket, key: str = Query(default="")):
    global _call_in_progress

    if key != SHARED_SECRET:
        await ws.close(code=4401, reason="invalid key")
        return

    async with _call_lock:
        if _call_in_progress:
            await ws.accept()
            await ws.send_json({"event": "busy", "message": "Another call is in progress."})
            await ws.close(code=4429, reason="line busy")
            return
        _call_in_progress = True

    await ws.accept()
    vad = SileroVAD()
    radio = RadioStream()

    from datetime import datetime
    session_id = f"feyblet-call-{int(datetime.now().timestamp() * 1000)}"
    started_at = datetime.now().isoformat()

    # Per-call state. In FIXED_VOICE_MODE we pre-mark the voice ref as
    # "saved" so the cycle below skips the 15s collection phase entirely
    # and goes straight to transcribing + responding.
    all_audio: list[np.ndarray] = []
    total_samples = 0
    voice_ref_saved = FIXED_VOICE_MODE
    voice_ref_b64: str | None = None
    voice_ref_text: str | None = None
    pre_buffer = deque(maxlen=PRE_CHUNKS)
    segment: list[np.ndarray] = []
    speech_active = False
    trailing_silence = 0
    conversation_history: list[dict] = []
    system_prompt = build_system_prompt()

    await radio.open(session_id)
    write_call_event("call_started", {"session_id": session_id, "started_at": started_at, "voice": FIXED_VOICE})
    ready_msg = (
        f"Connected to {SYMBIENT_NAME}. Talk anytime — replies use the {FIXED_VOICE.split(':',1)[1]} voice."
        if FIXED_VOICE_MODE
        else f"Connected to {SYMBIENT_NAME}. Talk for ~15 seconds first so we can clone your voice. Then it's a real conversation."
    )
    await ws.send_json({"event": "ready", "message": ready_msg, "voice_mode": "fixed" if FIXED_VOICE_MODE else "clone"})

    try:
        while True:
            data = await ws.receive_bytes()
            if not data:
                break
            int16 = np.frombuffer(data, dtype=np.int16)
            f32 = int16.astype(np.float32) / 32768.0

            # Fork caller PCM → radio (raw, real-time)
            await radio.push(data)

            for i in range(0, len(f32), CHUNK):
                chunk = f32[i : i + CHUNK]
                if len(chunk) < CHUNK:
                    chunk = np.pad(chunk, (0, CHUNK - len(chunk)))

                is_speech = vad.prob(chunk) > VAD_THRESHOLD

                if not speech_active:
                    pre_buffer.append(chunk)
                    if is_speech:
                        segment = list(pre_buffer)
                        speech_active = True
                        trailing_silence = 0
                        await ws.send_json({"event": "speech_start"})
                else:
                    segment.append(chunk)
                    trailing_silence = 0 if is_speech else trailing_silence + 1

                    if trailing_silence >= STOP_CHUNKS:
                        seg_audio = np.concatenate(segment, dtype=np.float32)
                        all_audio.append(seg_audio)
                        total_samples += len(seg_audio)

                        if not voice_ref_saved and total_samples >= VOICE_REF_SAMPLES:
                            ref_audio = np.concatenate(all_audio)[:VOICE_REF_SAMPLES]
                            voice_ref_text = await transcribe_audio(ref_audio)
                            _, voice_ref_b64 = save_voice_reference(ref_audio, voice_ref_text)
                            voice_ref_saved = True
                            await ws.send_json({"event": "voice_ref_saved", "ref_text": voice_ref_text})

                        if voice_ref_saved:
                            try:
                                seg_text = await transcribe_audio(seg_audio)
                                if seg_text:
                                    await ws.send_json({"event": "transcription", "text": seg_text})
                                    await ws.send_json({"event": "tts_start", "format": "pcm", "sample_rate": 24000})

                                    spoken_sentences: list[str] = []
                                    async for kind, text in stream_llm_with_tools(seg_text, conversation_history, system_prompt):
                                        if kind == "tool":
                                            # Surface to caller UI for transparency, but don't speak
                                            await ws.send_json({"event": "tool_running", "name": text})
                                            continue
                                        # Both "sentence" and "filler" go to TTS — fillers are
                                        # the "give me a sec" lines while a tool runs.
                                        if kind == "filler":
                                            await ws.send_json({"event": "filler", "text": text})
                                        else:
                                            await ws.send_json({"event": "llm_token", "text": text})
                                            spoken_sentences.append(text)
                                        async for tts_chunk in tts_stream_sentence(text, voice_ref_b64, voice_ref_text):
                                            # Fork TTS audio: caller WS + radio
                                            await ws.send_bytes(tts_chunk)
                                            await radio.push(tts_chunk)

                                    llm_text = " ".join(spoken_sentences)
                                    await ws.send_json({"event": "llm_response", "text": llm_text})
                                    await ws.send_json({"event": "tts_end"})

                                    conversation_history.append({"role": "user", "content": seg_text})
                                    conversation_history.append({"role": "assistant", "content": llm_text})
                                    if len(conversation_history) > 20:
                                        conversation_history = conversation_history[-20:]
                            except Exception as e:
                                print(f"[pipeline] error: {e}")
                                try:
                                    await ws.send_json({"event": "error", "message": str(e)})
                                    await ws.send_json({"event": "tts_end"})
                                except Exception:
                                    pass
                        else:
                            elapsed = total_samples / RATE
                            await ws.send_json({
                                "event": "collecting_voice",
                                "seconds_collected": round(elapsed, 1),
                                "seconds_needed": VOICE_REF_SECONDS,
                            })

                        segment.clear()
                        speech_active = False
                        trailing_silence = 0
                        pre_buffer.clear()
                        vad.reset()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[ws] error: {e}")
    finally:
        await radio.close()
        write_call_event("call_ended", {
            "session_id": session_id,
            "started_at": started_at,
            "ended_at": datetime.now().isoformat(),
            "exchanges": len(conversation_history) // 2,
        })
        async with _call_lock:
            _call_in_progress = False
        print(f"[session] {session_id} ended")


@app.get("/")
async def caller_page():
    """Serve the caller browser UI."""
    from fastapi.responses import FileResponse
    return FileResponse(HERE / "web" / "index.html")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "call_in_progress": _call_in_progress,
        "radio_stream": "enabled" if RADIO_STREAM_ENABLED else "disabled",
        "llm": LLM_URL,
        "tts": TTS_URL,
        "whisper": WHISPER_URL,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("FEYBLET_CALL_PORT", "8400"))

    # Browsers require a "secure context" (HTTPS or localhost) for
    # navigator.mediaDevices.getUserMedia — plain HTTP from a LAN IP
    # silently returns `undefined`, so the caller page can't access the
    # mic. Serve TLS by default if cert + key are present alongside
    # server.py. Defaults match what the install README generates.
    cert = HERE / "cert.pem"
    key = HERE / "key.pem"
    use_tls = cert.exists() and key.exists()

    scheme = "https" if use_tls else "http"
    print(f"Voice-call server starting on {scheme}://0.0.0.0:{port}")
    print(f"  LLM:     {LLM_URL} ({LLM_MODEL})")
    print(f"  Whisper: {WHISPER_URL}")
    print(f"  TTS:     {TTS_URL}")
    print(f"  Radio:   {RADIO_BASE_URL} ({'enabled' if RADIO_STREAM_ENABLED else 'DISABLED'})")
    print(f"  Voice:   {FIXED_VOICE if FIXED_VOICE_MODE else 'clone (per-caller, 15s reference)'}")
    print(f"  TLS:     {'on (' + str(cert) + ')' if use_tls else 'OFF — mic-permission will fail outside localhost'}")
    print(f"  Caller URL: {scheme}://<host>:{port}/?key={SHARED_SECRET}")

    if use_tls:
        uvicorn.run(app, host="0.0.0.0", port=port, ssl_certfile=str(cert), ssl_keyfile=str(key))
    else:
        uvicorn.run(app, host="0.0.0.0", port=port)
