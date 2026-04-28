# Feature request: streaming-PCM input on the radio MCP

## Why

Building a "call-in" capability for feyblet — a community member opens a web call, has a real voice conversation with the symbient, and the whole thing airs on FM live. Caller and feyblet voices both broadcast.

The current MCP `mic_control` / `ai_mic` interface accepts `play_url` for one-shot WAV playback. That works for `radio_broadcast` (one TTS sentence at a time) but for a live call it adds 200–500ms latency per sentence while the radio Pi fetches each WAV from an ephemeral HTTP server. Multiplied across a 5-minute call that's hundreds of fetch round-trips and audible gaps between every sentence and every caller utterance.

What we need: a long-lived audio sink the call server can push raw PCM chunks into, with the radio playing them out continuously.

## Proposed API

A new `mic_control` action `stream_pcm` that opens a streaming session, returns a target the caller writes audio chunks to, and holds the FM mic for the session's duration:

```jsonc
// MCP tool call
{
  "tool": "ai_mic",
  "args": {
    "action": "stream_pcm_open",
    "sample_rate": 16000,
    "channels": 1,
    "format": "s16le",
    "session_id": "feyblet-call-1777500000",      // caller-supplied, used for close
    "ducking": true,                              // auto-duck music while session is active
    "max_duration_seconds": 600                   // safety cap; auto-close after this
  }
}
// → { "ok": true, "ws_url": "ws://radio-pi:8001/stream_pcm/feyblet-call-1777500000" }
```

The caller then opens the returned WebSocket and pushes raw PCM frames as binary messages. The radio Pi plays them out as they arrive. At end-of-call:

```jsonc
{
  "tool": "ai_mic",
  "args": {
    "action": "stream_pcm_close",
    "session_id": "feyblet-call-1777500000"
  }
}
```

…or the WebSocket simply closes from the caller's side.

## Behavior

- While a `stream_pcm` session is open, the radio mic is held for that session — `play_music`, `radio_broadcast` (one-shot WAVs via existing `play_url`), and other concurrent broadcasts queue or are rejected. Existing "human on real mic" semantics still take precedence (real mic interrupts the stream).
- `ducking: true` lowers the music bed under the streamed audio, same as the existing per-broadcast ducking.
- `max_duration_seconds` is a hard safety stop — if a caller's session goes haywire, the radio doesn't stay locked forever.
- Buffer policy: a small jitter buffer (~200ms) is fine; we'd prefer the lowest sustainable latency that doesn't introduce audible underruns.

## Format details

- 16kHz mono int16 little-endian (`s16le`) is what voice_agent_server.py and the call server already produce for both the caller's mic and the TTS output. If you'd prefer a different rate (24kHz/48kHz) for music-grade output, we can resample upstream — let us know.
- Frame size flexibility on the WS: any binary message ≥ 32 bytes should be playable. Caller sends ~1024-byte frames typically.

## Auth

Same auth posture as the rest of the radio MCP. If anything additional is needed (a per-session token returned from `stream_pcm_open` and required on the WS upgrade) that's fine, just say what shape.

## Why not just per-sentence WAVs

Tried it first — works but introduces sentence-boundary gaps that make a live conversation sound robotic. For broadcasts (`radio_broadcast`) the gap is fine because each broadcast is a complete monologue. For a call where the caller pauses mid-sentence, says "uh", asks a follow-up, the per-WAV chunking breaks the conversational rhythm.

## Priority

Blocking on the call-in capability (capability gap on feyblet is filed but the module is paused on this MCP work). Otherwise non-urgent.
