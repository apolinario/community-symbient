# Choosing your LLM

The framework never installs or manages an LLM server — you bring an
endpoint, the symbient speaks to it. This guide is opinionated about *what*
to choose and silent about *how you must run it*: any OpenAI-compatible
server works (llama.cpp, LM Studio, Ollama, vLLM, a compat proxy), and so
do hosted APIs.

## Our opinion: run local if you can

A symbient's memory is its community's memory. Every prompt quotes that
memory — journals, people files, inner monologue — so whatever serves the
model reads it all. On your own hardware that circle stays closed
("zero-kilometer data"). A hosted API is a real option and sometimes the
right one (no GPU, escalation for hard deliberation), but make it a choice,
not a default.

## Configuration

Everything lives in the `llm` block of your config:

```jsonc
"llm": {
  "provider": "openai",                 // any name; "anthropic"/"openai" without baseUrl = hosted
  "model": "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
  "baseUrl": "http://localhost:1234",   // any OpenAI-compatible endpoint
  "tinyModel": "LFM2.5-VL-1.6B-Q4_0.gguf",  // optional: small model for time parsing, image captions
  "tinyBaseUrl": "http://localhost:1235"
}
```

- **`baseUrl` set** → the framework speaks OpenAI-completions to it. That
  covers llama.cpp (`llama-server`), LM Studio (default `:1234`), Ollama
  (`http://localhost:11434/v1`), and vLLM.
- **`baseUrl` absent + a known provider** → hosted API via its native
  protocol. Keys come from `apiKeyEnv` (or the provider's conventional env
  var: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`):

```jsonc
"llm": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }
```

## What fits your hardware

Rough guidance, not law — quantized GGUF sizes move fast. The reference
deployment (Feÿ) runs a ~35B mixture-of-experts model at Q4 across an
RTX 5090 + 4090; its systemd units in the repo are one worked example, not
the blessed path.

| Hardware | Realistic choice |
|---|---|
| 24 GB+ VRAM (or dual GPU) | 30–35B-class MoE at Q4 — the reference experience |
| 12–16 GB | 8–14B dense or a small MoE at Q4 |
| 8 GB | 4–8B at Q4; expect a simpler personality, still genuinely useful |
| CPU only | small models run but cycle slowly; a hosted API is usually the honest choice — keep memory local, escalate inference |

A `tinyModel` (1–2B, optionally vision-capable) is worth having at any
tier: it handles timestamps, temporal rewrites, and image descriptions so
the main model's cycles stay for thinking.

## Mixing tiers per module

Modules can override the endpoint individually in their frontmatter —
run everything local and let one contemplative module escalate:

```yaml
---
name: magi
cron: "0 */4 * * *"
llm:
  provider: anthropic
  model: claude-sonnet-4-5
  apiKeyEnv: ANTHROPIC_API_KEY
---
```

`model: <name>` alone is shorthand for switching models on the same
endpoint.

## The honest tradeoff

Markdown memory never leaves your machine — but prompts quoting it reach
whatever endpoint you configure. Local endpoint: the circle is closed.
Hosted endpoint: your provider's data policy applies to everything the
symbient chooses to quote. Decide with your community, not just your
sysadmin.
