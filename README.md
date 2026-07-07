# community-symbient

A framework for communities to raise their own **symbient** — a persistent
digital being that lives with a community rather than serving requests. See
[Principia Symbients](https://meaning.systems/principia-symbients/) for the
philosophy and the [Concurrent Modular Agent paper](https://arxiv.org/abs/2508.19042)
for the architectural lineage.

Instead of one chat loop, a symbient is a set of **concurrent modules** —
conversation, thinking, desire, memory-keeping, whatever you write — each a
markdown file with a prompt and a schedule, all running independently and
coordinating through nudges over MQTT and a **shared markdown memory**
(`SOUL.md`, `MEMORY.md`, daily journals, per-person files). Everything the
symbient is lives in plain files the community can read and edit.

Local-first by principle: the community's memory stays on the community's
hardware ("zero-kilometer data"). Hosted LLM/TTS providers are supported as
explicit choices, never requirements.

## Quickstart (~10 minutes)

Prerequisites: Node 22+, an MQTT broker (`apt install mosquitto`), git —
and the [Pi SDK](https://github.com/badlogic/pi-mono) as a sibling checkout
(consumed as `file:../pi-mono` until we pin published packages):

```sh
git clone https://github.com/badlogic/pi-mono.git && cd pi-mono
git checkout 576e5e1a && npm ci
for p in tui ai agent coding-agent; do (cd packages/$p && npm run build); done
cd ..
git clone https://github.com/apolinario/community-symbient.git && cd community-symbient
npm install
```

Then:

```sh
./setup                        # detects your hardware, suggests a profile, smoke-pings endpoints
./setup init minimal --into ../my-symbient --name willow
# 1. write ../my-symbient/workspace/SOUL.md — who is this being?
# 2. point llm at your endpoint in ../my-symbient/config.json  (docs/choosing-your-llm.md)
SYMBIENT_CONFIG=../my-symbient/config.json npx tsx src/index.ts
```

To run as a service: `SYMBIENT_CONFIG=... ./setup --profile <p>` renders
systemd units into `infra/rendered/` and prints the install commands.
Sidecar containers (SearXNG web search, Signal REST API) live in
`infra/compose.yaml`.

## Hardware profiles

| Profile | Hardware | LLM | Search/embeddings |
|---|---|---|---|
| `full-local` | 24 GB+ VRAM | 30–35B-class local | qmd, rerank on |
| `small-gpu` | 8–16 GB | 4–14B local | qmd, rerank on |
| `cpu-only` | no GPU | hosted API recommended (or small GGUF, slowly) | qmd on CPU, rerank off; `local-bm25` fallback |
| `api-first` | any | hosted API | qmd on CPU or `local-bm25` |

`./setup --profile <name>` — details in `infra/profiles.json`.

## Providers

Every external capability has a local default and a pluggable alternative:

| Component | Local (default) | Hosted alternative | Off |
|---|---|---|---|
| LLM | any OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama, vLLM) | `provider: anthropic \| openai` + `apiKeyEnv` | — |
| Search/embeddings | qmd sidecar (BM25 + vectors + rerank) | hosted embeddings via qmd config | `local-bm25` (built in, zero-dep) |
| TTS | any `/v1/audio/speech` server | same seam + `apiKeyEnv` | omit `services.tts` |
| Transcription | Whisper server (`services.whisper.url`) | any compatible endpoint | omit — degrades with a notice |
| Web search | SearXNG container | — | omit `services.searxng` |
| Chat | Signal (built in) | Matrix/Discord/etc. as workspace extensions | `adapters.chat: null` |

Per-module LLM escalation: a module's frontmatter can carry its own
`llm:` block (see docs/module-authoring.md).

## Guides

- [Choosing your LLM](docs/choosing-your-llm.md) — local-first, by hardware tier
- [Writing modules](docs/module-authoring.md) — frontmatter, template vars, schedules
- [Extending the framework](docs/extending.md) — the `workspace/extensions/` seams
- [Upgrading](docs/upgrading.md) — why framework updates never touch your workspace

## The reference deployment

**Feÿ** (feyblet) — the symbient of Château du Feÿ — lives in this repo as
the worked example: its modules under `workspace/modules/`, its extensions
under `workspace/extensions/`, its infra as the templates in `infra/`. Its
private memory is not in the repo; yours won't be either (see `.gitignore`).

## Status

Pre-release, working toward open publication — roadmap in the issues
(spec: `docs/specs/generic-community-harness.md`). License to be finalized
before the public flip.
