# Configuring your symbient

The runtime looks for its config in this order:

1. `$SYMBIENT_CONFIG` — path to any JSON file (how external deployments
   run; `./setup init` prints the exact invocation)
2. `config/symbient.json` — for an in-repo deployment (gitignored by
   default so your config never lands in the distribution repo)

Start from the example (strict JSON — no comments in the real file):

```sh
cp config/symbient.example.json config/symbient.json
```

Validation runs at boot (TypeBox, `src/core/config-schema.ts`) — a
misshaped config fails loudly with per-field errors. Unknown extra keys
are allowed; deployment extensions read whatever they need.

## Field reference

| Field | Meaning |
|---|---|
| `name` | The symbient's identity + MQTT topic prefix + systemd unit name. Pick once, keep. |
| `workspacePath` | The workspace dir (SOUL.md, modules/, memory). Absolute path recommended for external deployments. |
| `workspace.writablePaths` | Prefixes (besides `MEMORY.md`, `people/`) the file tools may write to. |
| `mqtt` | Broker for inter-module nudges — a stock local mosquitto. |
| `llm.provider` + `llm.baseUrl` | With `baseUrl`: any OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama :11434/v1, vLLM). Without: a hosted provider (`anthropic`, `openai`) resolved natively — add `apiKeyEnv`. See `docs/choosing-your-llm.md`. |
| `llm.model` | Model id as the endpoint reports it (`curl <baseUrl>/v1/models`). |
| `llm.tinyModel` / `tinyBaseUrl` | Optional small model for time parsing / image captions. Remove if unused. |
| `llm.contextWindow` / `maxTokens` | Only for compat endpoints the SDK can't introspect. |
| `services.search` | `{"backend":"local-bm25"}` needs nothing; `qmd-http` + `url` for the qmd sidecar (better recall, needs the daemon). |
| `services.whisper.url` | Optional — enables voice-message transcription. Remove if unused. |
| `services.tts` | Optional — any `/v1/audio/speech` server enables voice tools; `apiKeyEnv` for hosted. Remove if unused. |
| `services.searxng.url` | Optional — enables `web_search`. Remove if unused. |
| `services.<anything>` | Extra services are passed through to your workspace extensions. |
| `adapters.chat` | `signal` built-in (params: your registered `account`, the signal-cli-rest-api host/port, dm/group policies + allowlists) or `null` to run headless. Other transports register via `workspace/extensions/adapters/chat/`. |
| `adapters.directory` | Person-directory backend from your extensions, or `null`. |
| `scheduling.defaultTarget` | Module that receives scheduled items with no explicit target. |
| `mcp_servers` | `[{ "name", "url" }]` — each server's tools appear as `name.*`. |
| `modules.<name>` | Per-module overrides of the markdown frontmatter: `intervalMs`, `cron`, `startActive`, `runImmediately`, `model`, or a full `llm` endpoint override (escalation). |

Empty-string values in the example mean "fill in or delete the key" —
optional services activate on presence.
