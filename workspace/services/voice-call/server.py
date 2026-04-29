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


# Persona, system prompt, tool execution all live in agent-bridge.ts now.
# This Python server is just the audio I/O layer.


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


# ── Call-agent bridge (in-process Pi Agent on the TS side) ──────────
# All cognition + tool use happens on the TS side via a small HTTP
# listener started by workspace/extensions/modules.ts. This server
# just POSTs the transcribed user turn and consumes SSE events.
CALL_BRIDGE_URL = os.environ.get("FEYBLET_CALL_BRIDGE_URL", "http://127.0.0.1:3334")

async def stream_call_cycle(session_id: str, transcript: str, voice_mode: str, radio_live: bool, greeted_with: str | None = None):
    """POST a user turn to the call-agent bridge; yield SSE events.
    `greeted_with` is the pre-rendered greeting text spoken on connect
    (e.g. "Hi! Feÿ radio with feyblet — who's this?"). Passed through to
    the bridge so the agent knows it has already greeted the caller and
    shouldn't re-greet."""
    payload = {
        "session_id": session_id,
        "transcript": transcript,
        "voice_mode": voice_mode,
        "radio_live": radio_live,
        "greeted_with": greeted_with,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            async with client.stream("POST", f"{CALL_BRIDGE_URL}/call_cycle", json=payload) as resp:
                if resp.status_code != 200:
                    err = await resp.aread()
                    print(f"[bridge] error {resp.status_code}: {err[:200]}")
                    yield {"type": "error", "message": f"bridge {resp.status_code}"}
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        yield json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        print(f"[bridge] exception: {e}")
        yield {"type": "error", "message": str(e)}


async def end_call_session(session_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            await client.post(f"{CALL_BRIDGE_URL}/end_session", json={"session_id": session_id})
    except Exception:
        pass


# All Python-side tooling/LLM code is gone — cognition lives on the TS
# side via the call-agent bridge. See stream_call_cycle / end_call_session
# above.


# ── Greeting WAVs (pre-rendered TTS that plays the moment a call connects) ──
# Greetings are PRE-RENDERED ahead of time and immutable at runtime.
# To refresh them, run: `uv run render-greetings.py` separately.
# This server NEVER regenerates them — startup loads from disk; if a
# file is missing the greeting block is skipped silently for that index.

GREETING_TEXTS = [
    "Hi! Feÿ radio with feyblet — who's this?",
    "Hello, you're on the Feÿ radio. Feyblet here. Who am I speaking with?",
    "Hey! Feyblet on the Feÿ radio. Who's calling?",
    "Hi, this is feyblet from the Feÿ radio. Who is this?",
    "Hello, Feÿ radio with feyblet. Who do I have the pleasure of?",
]

GREETINGS_DIR = HERE / "greetings"

import re as _re_for_voice_key
import random as _random_for_greeting


def _voice_key_for_cache() -> str:
    base = FIXED_VOICE if FIXED_VOICE_MODE else "clone-default"
    return _re_for_voice_key.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-")


def _load_greetings_from_disk() -> list[tuple[str, bytes]]:
    """Synchronous load of pre-rendered greeting PCMs at module import.
    Skips files that don't exist; the result is the immutable cache the
    call handler picks from. To refresh, run render-greetings.py."""
    voice_key = _voice_key_for_cache()
    out: list[tuple[str, bytes]] = []
    for i, text in enumerate(GREETING_TEXTS):
        path = GREETINGS_DIR / f"{voice_key}-{i}.pcm"
        try:
            data = path.read_bytes()
            if data:
                out.append((text, data))
        except FileNotFoundError:
            print(f"[greeting] missing {path.name} — run render-greetings.py to create it", flush=True)
    return out


# Loaded once at import — immutable for the life of the process.
GREETINGS_CACHE: list[tuple[str, bytes]] = _load_greetings_from_disk()
print(f"[greeting] loaded {len(GREETINGS_CACHE)} pre-rendered greetings ({_voice_key_for_cache()})", flush=True)


async def play_greeting(ws, radio) -> str | None:
    """Pick a random pre-rendered greeting and stream it to caller WS
    + radio. Returns the greeting text spoken, or None if cache empty.
    Streamed in larger 8KB chunks for faster onset."""
    if not GREETINGS_CACHE:
        return None
    text, pcm = _random_for_greeting.choice(GREETINGS_CACHE)
    CHUNK_BYTES = 8192  # ~170ms of audio per chunk at 24kHz int16
    for i in range(0, len(pcm), CHUNK_BYTES):
        chunk = pcm[i : i + CHUNK_BYTES]
        try:
            await ws.send_bytes(chunk)
        except Exception as e:
            print(f"[greeting] caller WS send failed: {e}", flush=True)
            return text
        await radio.push(chunk)
    print(f"[greeting] played \"{text}\" ({len(pcm)} bytes)", flush=True)
    return text


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
        self.bytes_sent = 0
        self.push_failures = 0

    async def open(self, session_id: str):
        self.session_id = session_id
        self.bytes_sent = 0
        self.push_failures = 0
        if not RADIO_STREAM_ENABLED:
            print(f"[radio-stream] disabled — call audio not on FM (session={session_id})", flush=True)
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
                print(f"[radio-stream] OPEN ok session={session_id} ws={ws_url}", flush=True)
            else:
                print(f"[radio-stream] OPEN got no ws_url, body={body}", flush=True)
        except Exception as e:
            print(f"[radio-stream] OPEN FAILED session={session_id} err={e!r}", flush=True)
            self.ws = None

    async def push(self, pcm_bytes: bytes):
        if not self.ws:
            self.push_failures += 1
            if self.push_failures == 1:
                print(f"[radio-stream] PUSH skipped — ws is None (session={self.session_id})", flush=True)
            return
        try:
            await self.ws.send(pcm_bytes)
            self.bytes_sent += len(pcm_bytes)
            # Heartbeat every ~64 KB so we know audio is flowing
            if self.bytes_sent and self.bytes_sent % (64 * 1024) < len(pcm_bytes):
                print(f"[radio-stream] flowing — {self.bytes_sent} bytes sent (session={self.session_id})", flush=True)
        except Exception as e:
            self.push_failures += 1
            print(f"[radio-stream] PUSH FAILED after {self.bytes_sent} bytes: {e!r}", flush=True)
            self.ws = None

    async def close(self):
        if self.ws:
            try:
                await self.ws.close()
            except Exception as e:
                print(f"[radio-stream] ws close error: {e!r}", flush=True)
            self.ws = None
        if not RADIO_STREAM_ENABLED or not self.session_id:
            return
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                await client.post(f"{RADIO_BASE_URL}/ai_mic/stream_pcm/close", json={
                    "session_id": self.session_id,
                })
            print(f"[radio-stream] CLOSE session={self.session_id} total_bytes={self.bytes_sent} push_failures={self.push_failures}", flush=True)
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
    # conversation history is owned by the TS-side agent bridge; we just
    # forward transcripts and stream back speak events.
    turn_count = 0

    await radio.open(session_id)
    write_call_event("call_started", {"session_id": session_id, "started_at": started_at, "voice": FIXED_VOICE})
    ready_msg = (
        f"Connected to {SYMBIENT_NAME}. Speak anytime."
        if FIXED_VOICE_MODE
        else f"Connected to {SYMBIENT_NAME}. Talk for ~15 seconds first so we can clone your voice. Then it's a real conversation."
    )
    await ws.send_json({"event": "ready", "message": ready_msg, "voice_mode": "fixed" if FIXED_VOICE_MODE else "clone"})

    # Play a pre-rendered greeting so feyblet picks up first, like a
    # radio host answering a call. The greeting also asks who's calling
    # so the caller's first reply contains their name.
    greeted_with: str | None = None
    if GREETINGS_CACHE:
        await ws.send_json({"event": "tts_start", "format": "pcm", "sample_rate": 24000})
        greeted_with = await play_greeting(ws, radio)
        if greeted_with:
            await ws.send_json({"event": "llm_token", "text": greeted_with})
        await ws.send_json({"event": "tts_end"})

    # Stale-session watchdog: if no caller mic frame arrives for
    # IDLE_TIMEOUT_S, assume the tab was closed (browser sends frames
    # every ~128ms during a normal call, so a multi-second silence is
    # always abnormal). The agent could be mid-cycle on a long tool
    # call, so we use a generous-but-finite window.
    IDLE_TIMEOUT_S = 30.0

    try:
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=IDLE_TIMEOUT_S)
            except asyncio.TimeoutError:
                print(f"[session] {session_id} idle for {IDLE_TIMEOUT_S}s — closing", flush=True)
                break
            # Browser sends a JSON text frame `{"hangup":true}` on the
            # Hang up button click, before closing the WS. This is the
            # snappy-hangup path; for unclean closes the watchdog catches.
            if msg.get("type") == "websocket.disconnect":
                print(f"[session] {session_id} client disconnected", flush=True)
                break
            if msg.get("text") is not None:
                if '"hangup"' in msg["text"]:
                    print(f"[session] {session_id} caller hung up", flush=True)
                    break
                continue
            data = msg.get("bytes")
            if not data:
                continue
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
                                    from starlette.websockets import WebSocketState
                                    async for event in stream_call_cycle(session_id, seg_text, FIXED_VOICE if FIXED_VOICE_MODE else "clone", RADIO_STREAM_ENABLED, greeted_with=greeted_with):
                                        # Snappy-hangup: if the caller closed the WS while
                                        # the agent was mid-stream, drop the rest of this
                                        # turn rather than narrating to a dead socket.
                                        if ws.client_state != WebSocketState.CONNECTED:
                                            print(f"[session] {session_id} client gone mid-cycle — aborting turn", flush=True)
                                            break
                                        kind = event.get("type")
                                        if kind == "speak":
                                            text = event.get("text", "")
                                            if not text:
                                                continue
                                            spoken_sentences.append(text)
                                            await ws.send_json({"event": "llm_token", "text": text})
                                            async for tts_chunk in tts_stream_sentence(text, voice_ref_b64, voice_ref_text):
                                                # Fork TTS audio: caller WS + radio
                                                await ws.send_bytes(tts_chunk)
                                                await radio.push(tts_chunk)
                                        elif kind == "tool_start":
                                            await ws.send_json({"event": "tool_running", "name": event.get("tool", "")})
                                        elif kind == "tool_end":
                                            await ws.send_json({"event": "tool_done", "name": event.get("tool", "")})
                                        elif kind == "error":
                                            await ws.send_json({"event": "error", "message": event.get("message", "")})

                                    llm_text = " ".join(spoken_sentences)
                                    await ws.send_json({"event": "llm_response", "text": llm_text})
                                    await ws.send_json({"event": "tts_end"})
                                    turn_count += 1
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
        await end_call_session(session_id)
        write_call_event("call_ended", {
            "session_id": session_id,
            "started_at": started_at,
            "ended_at": datetime.now().isoformat(),
            "turns": turn_count,
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
