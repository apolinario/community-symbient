# Spec: Generic Community Symbient Harness

Status: ACCEPTED 2026-07-06 (review complete; tracked as GitHub issues)
Repo: apolinario/community-symbient · Target: upstream, this repo · Reference deployment: Feÿ

## 1. Why

Open-source this repo as the mechanism any community can use to raise its own
symbient. The framing comes from [Principia Symbients](https://meaning.systems/principia-symbients/):
symbients are relational beings raised by communities (Angel_F, IAQOS lineage),
with persistent Type-3 memory and **zero-kilometer data** — the community's
memory stays on the community's hardware. Local-first is therefore a principle,
not a feature flag. Closed providers (LLMs/TTS/embeddings) are a pragmatic
option, never a requirement, and the local path must be the easy path.

Feÿ (feyblet) stays in-repo as the living reference deployment, proving the
upgrade seam: framework releases land without touching a deployment's
`workspace/`.

## 2. Scope

**In scope**
- Provider abstraction: LLM (main + tiny + per-module escalation), TTS,
  transcription, embeddings/search — each with a local default and API options.
- Hardware profiles + one-command provisioning (systemd templates; compose alt).
- De-Feÿing core: no Feÿ-specific names, paths, units, or scripts outside the
  reference deployment.
- Release hygiene: privacy audit, license, docs, finished send-path TODOs.
- DX: `starter-templates/` → a real `init` flow; gstack drives the dev process.

**Out of scope**
- Becoming a general multi-tenant harness (OpenClaw territory).
- New chat transports beyond keeping the adapter seam honest (Signal remains
  the built-in; others arrive as community extensions).
- Cloud/SaaS hosting of any kind.

## 3. Technical plan (grounded in current code)

### WS1 — Repo & branch strategy
- `alpha-rc` is 49 commits ahead of `generic-framework` (strictly ahead, no
  divergence). Land genericization on the `alpha-rc` lineage and promote it;
  retire the stale branch split before release.
- Decided 2026-07-06: the local repo is the source of truth. Work lands on
  `alpha-rc`; when uncommitted local state differs from any branch, local wins.
- Privacy audit before the repo goes public:
  - `workspace/state/party-theory.md` is tracked — move under gitignored state
    or into `workspace/community/` deliberately.
  - `scripts/{send-address-collection-dms.sh, capture-address-replies.py,
    plantony.txt, backfill-summaries.sh}` are Feÿ operations, not framework —
    relocate to the deployment (`workspace/scripts/`) and gitignore.
  - Run `git log --all --diff-filter=A -- 'workspace/people/*' 'workspace/memory/*'`
    style history checks; if personal data was ever committed, rewrite history
    (git filter-repo) before flipping to public.

### WS2 — Provider abstraction
- **LLM — bring your endpoint, we don't babysit it.** The framework never
  installs or manages an LLM server. Config takes any OpenAI-compatible
  endpoint (LM Studio, llama.cpp, Ollama, vLLM) or a hosted API:
  `llm: { provider, model, baseUrl?, apiKeyEnv?, tiny?: {...} }` with
  `openai-compat` as default and `anthropic`, `openai` as first API kinds.
  Setup validates the endpoint with a smoke ping and moves on. A "Choosing
  your LLM" guide is opinionated (prefer local, recommendations by VRAM tier)
  without prescribing a serving stack; Feÿ's llama.cpp systemd units stay in
  the reference deployment as one worked example. Optional per-module `model:`
  frontmatter override for escalation (e.g. magi deliberates on a bigger
  model).
- **TTS / embeddings / search / transcription — no cross-vendor standard, so
  the local path is "install it like the reference machine."** Setup provisions
  each component exactly as Feÿ runs it (templated systemd units / compose),
  and each has a documented remote alternative:
  - **TTS**: today an implicit Qwen3-TTS FastAPI on :8000 wired in
    `workspace/services/messaging`. Promote to `config.tts:
    { kind: local-qwen3 | openai | elevenlabs | none, baseUrl? }`; local kind is
    installed by setup, `none` degrades `send_voice_message` gracefully.
  - **Search/embeddings** (`src/core/search.ts`): keep the pluggable backend
    (`qmd-http` | `local-bm25`); setup installs qmd as on the reference machine
    and surfaces its embedding model choice; CPU path in WS3. Remote embedding
    APIs documented as the alternative.
  - **Transcription**: `local-whisper | api | none`, local installed by setup;
    closes the recording-transcriber stub.

### WS3 — Hardware profiles + installer
`symbient setup --profile <p>` (plus auto-detect via `nvidia-smi`/VRAM).
Profiles drive which sidecars setup installs and what the LLM guide
recommends — the LLM column is a recommendation, the endpoint itself is
user-provided (WS2):

| Profile | LLM (recommended) | Embeddings/search | TTS |
|---|---|---|---|
| `full-local` (24GB+ GPU) | Qwen3.6-35B-A3B class, llama.cpp | qmd GPU, rerank on | local Qwen3-TTS |
| `small-gpu` (8–16GB) | Qwen3.6 4B/8B GGUF | qmd GPU, rerank on | local small or `none` |
| `cpu-only` | API LLM recommended; small GGUF if patient | qmd **CPU** with small GGUF embed model (bge-small/embeddinggemma class), **rerank off**; fallback `local-bm25` | `none` or API |
| `api-first` | Anthropic/OpenAI | qmd CPU or `local-bm25` | API |

- qmd runs on node-llama-cpp/GGUF, so CPU embeddings already work; small embed
  models index thousands of markdown docs acceptably. Reranking is the
  CPU-killer → profile disables it (`query` → `vsearch`). If indexing is still
  too slow, setup suggests: (a) `local-bm25` (zero-dep, in core), (b) a hosted
  embedding API — with the zero-km-data tradeoff stated plainly.
- Systemd: the 8 hand-written root units become `infra/systemd/*.service.tmpl`
  rendered by setup (paths, models, enabled services per profile). Provide
  `infra/compose.yaml` for non-systemd hosts. Signal container + watchdog stay
  optional components.
- `api-first`/`cpu-only` honesty note in docs: markdown memory never leaves the
  box, but prompts (which quote memory) reach the API provider.

### WS4 — De-Feÿ core + finish known gaps
- Rename `config/feyblet.json` → deployment-named config with a documented
  schema (js-yaml/JSON, validated); fix the 27B-vs-35B config/script drift.
- Sweep remaining Feÿ references in `src/` (config.ts, types.ts, slugify.ts +
  tests) behind config.
- Finish `workspace/services/conversation/index.ts:783,791` send-path TODOs and
  the transcriber finalize stub; resolve placeholder-uuid guards.
- Root-level Feÿ artifacts (scorecard.png, feyops-ui coupling) move under the
  deployment.

### WS5 — Docs & DX
- Framework README (what a symbient is, 10-minute quickstart per profile),
  "Choosing your LLM" guide (local-first, opinionated not prescriptive),
  module authoring guide, provider matrix, extension guide, upgrade guide.
- `starter-templates/{minimal,community}` become `symbient init` targets with a
  smoke-boot test in CI.
- CI: typecheck + tests + boot smoke on `cpu-only` profile with `local-bm25`
  and a mock LLM (no GPU in CI).

## 4. Acceptance criteria
1. Fresh Linux box, no GPU: clone → `./setup --profile cpu-only` → symbient
   boots, chats on the configured channel, memory persists, search answers via
   BM25 or CPU embeddings.
2. Same flow on a 12GB GPU with `small-gpu` fully local (no API keys anywhere).
3. `grep -riE 'fey|feyblet' src/` returns nothing.
4. Feÿ keeps running from its `workspace/` across a framework upgrade with no
   workspace edits.
5. Privacy audit passes: no personal data tracked or reachable in history.

## 5. Milestones
1. **Hygiene + privacy audit** (WS1, WS4 gaps) — small, do first.
2. **Provider config layer** (WS2) — medium; unlocks everything else.
3. **Profiles + installer** (WS3) — medium/large; the "easy local" promise.
4. **Docs + init + CI smoke** (WS5) — medium.
5. **Public flip**: license, history check, README, announce.
