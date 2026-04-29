# Voice-Call Service

Live voice-call server for feyblet. Anyone with the URL + access key can connect from a browser, talk to feyblet in real time, and have the entire call air on the château's FM radio (caller's voice + feyblet's responses both audible to FM listeners).

## Architecture (one paragraph)

```
Caller browser  ──► WS /v1/call?key=<secret>  ──► server.py
                                                      │
                                                      ├─► Whisper (transcribe)
                                                      ├─► feyblet's LLM (persona + memory)
                                                      ├─► TTS (caller's cloned voice)
                                                      │
                                              ┌───────┴───────┐
                                              ▼               ▼
                                        caller WS        radio MCP stream_pcm
                                                         (FM listeners hear it live)
```

First 15s of caller's speech is saved as a voice reference; subsequent feyblet responses are TTS'd in their own cloned voice. After 15s, conversation flows: caller talks → transcribed → LLM responds sentence-by-sentence → TTS → simultaneous caller-WS + radio-MCP fan-out.

## Run

```bash
cd workspace/services/voice-call
uv run server.py
```

Config is auto-loaded from `config/feyblet.json` for LLM/Whisper/TTS endpoints. Override with env:

| env var | default | what |
|---|---|---|
| `FEYBLET_CALL_PORT` | `8400` | local listen port |
| `FEYBLET_CALL_SECRET` | `feyblade-2026` | shared secret for `?key=` |
| `RADIO_MCP_URL` | `http://192.168.10.97:8001/mcp` | radio MCP base |
| `RADIO_STREAM` | `enabled` | set to `disabled` to skip the FM fan-out (testing without radio) |

Caller URL: `http://<host>:8400/?key=<secret>`

## v1 limitations

- **No tools available to the call agent** — feyblet's persona + recent memory is in the system prompt, but the LLM can't `lookup_person` / `check_sauna` / etc. mid-conversation. Cross-language Pi Agent bridge is v2.
- **Single concurrent call** enforced via in-process lock. Second connection rejected with `4429 line busy`.
- **Shared-secret auth only.** No per-caller identity. v2 could read the access key from a per-resident token in their people file.
- **Requires the radio MCP `stream_pcm_open`/`stream_pcm_close` actions** to actually broadcast on FM — see `RADIO-MCP-FEATURE-REQUEST.md` at the repo root. Until that lands, set `RADIO_STREAM=disabled` and the call still works (caller-only).

## Files

- `server.py` — main FastAPI/uvicorn WebSocket server.
- `web/index.html` — caller-facing browser UI (mic + playback).
- `tools.ts` — feyblet operator tools (`start_call_line`, `end_call_line`).
- `pyproject.toml` — Python deps (managed via `uv`).

## Caller flow

The call line is **always open** — as long as the server process is running, anyone with the URL + key can dial in.

1. Caller opens `http://<host>:8400/?key=<secret>` (URL is shared on the wifi info board / by friends / etc.)
2. Browser asks for mic permission. They speak — first ~15 seconds saved as their voice reference.
3. After voice clone, real conversation: caller talks → transcribed → feyblet responds in their cloned voice.
4. Both voices air on FM live via the `stream_pcm` session (assuming radio MCP support).
5. `radio-calls` module sees the `call_started` event on its next 30s cycle and broadcasts a short "going on air" announcement.
6. Caller hangs up → `call_ended` event → `radio-calls` broadcasts a wrap-up.

Single concurrent call: a second caller while one is in progress gets a `4429 line busy` close. They retry.

If the operator ever wants to actively pitch the line on-air (e.g. announcing a featured call-in segment), they DM feyblet directly and ask for an announcement — no dedicated tool needed, conversation just calls `radio_broadcast`.
