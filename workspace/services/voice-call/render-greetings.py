"""
Render the greeting PCMs to disk in the configured TTS voice.

Run this whenever:
  - you change FEYBLET_CALL_VOICE
  - you edit GREETING_TEXTS in server.py
  - the TTS voice profile changed
  - you want to refresh for any other reason

The server.py NEVER renders these on its own — it only reads them at
import time. To get fresh greetings, run this, then restart the server.

Usage:
  cd workspace/services/voice-call
  uv run render-greetings.py [--voice clone:lou]
"""

import asyncio
import os
import sys
import re
import argparse
from pathlib import Path

import httpx

HERE = Path(__file__).parent.resolve()
PROJECT_ROOT = HERE.parent.parent.parent.resolve()
import json
CONFIG_PATH = PROJECT_ROOT / "config" / "feyblet.json"
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
TTS_URL = CONFIG.get("services", {}).get("tts", {}).get("url", "http://localhost:8000") + "/v1/audio/speech"

GREETING_TEXTS = [
    "Hi! Feÿ radio with feyblet — who's this?",
    "Hello, you're on the Feÿ radio. Feyblet here. Who am I speaking with?",
    "Hey! Feyblet on the Feÿ radio. Who's calling?",
    "Hi, this is feyblet from the Feÿ radio. Who is this?",
    "Hello, Feÿ radio with feyblet. Who do I have the pleasure of?",
]

GREETINGS_DIR = HERE / "greetings"


async def render(text: str, voice: str) -> bytes:
    payload = {
        "model": "qwen3-tts",
        "input": text,
        "voice": voice,
        "response_format": "pcm",
        "stream": True,
        "speed": 1.0,
    }
    chunks: list[bytes] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        async with client.stream("POST", TTS_URL, json=payload) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                raise RuntimeError(f"TTS {resp.status_code}: {err[:200]}")
            async for chunk in resp.aiter_bytes(chunk_size=4800):
                chunks.append(chunk)
    return b"".join(chunks)


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--voice", default=os.environ.get("FEYBLET_CALL_VOICE", "clone:iannis"),
                    help="OmniVoice profile (e.g. clone:iannis, clone:lou). Default: $FEYBLET_CALL_VOICE or clone:iannis.")
    args = ap.parse_args()

    voice = args.voice
    voice_key = re.sub(r"[^a-zA-Z0-9]+", "-", voice).strip("-")
    GREETINGS_DIR.mkdir(exist_ok=True)

    print(f"Rendering {len(GREETING_TEXTS)} greetings in voice '{voice}' to {GREETINGS_DIR}/")
    for i, text in enumerate(GREETING_TEXTS):
        path = GREETINGS_DIR / f"{voice_key}-{i}.pcm"
        print(f"  [{i}] {text!r}")
        try:
            pcm = await render(text, voice)
            path.write_bytes(pcm)
            print(f"      → {path.name} ({len(pcm)} bytes)")
        except Exception as e:
            print(f"      FAILED: {e}", file=sys.stderr)
    print("done")


if __name__ == "__main__":
    asyncio.run(main())
