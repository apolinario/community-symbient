# Minimal Symbient Starter

The smallest viable deployment. A symbient that answers chat messages,
has a SOUL identity, keeps daily logs, and nothing else.

Copy this directory, fill in `workspace/SOUL.md`, point `config/config.json`
at your LLM + chat transport, and run. No cognitive modules, no custom
services, no workspace code — just framework defaults.

## What's inside

```
workspace/
  SOUL.md              — the symbient's identity (edit this)
  MEMORY.md            — long-term memory (grows on its own)
  config/config.json   — LLM, chat adapter, MQTT
  modules/
    conversation.md    — the chat prompt (framework's chat-reactor uses this)
```

No `extensions/` folder — the framework uses its own defaults. When you
want to customize something (custom helper, handler, tool, provider),
create `extensions/<kind>.js` as shown in the community starter.

## What the symbient does

On each incoming chat message:
1. Framework reactive chat module (`chat-reactor`) wakes up
2. Assembles context: SOUL + MEMORY + person profile (if you have
   `workspace/people/*.md`) + relevance-ranked memory chunks via the
   built-in BM25 search
3. Runs the Pi Agent with `modules/conversation.md` as system prompt
4. Sends the response back via the chat adapter

That's it. No thinking module, no desire module, no executive, no radio.
Chat in, chat out.

## Search

This starter uses the framework's built-in **`local-bm25`** search backend:
an in-process BM25 index over `workspace/**/*.md`. No external service to
run, no embedder, no GPU — just term-frequency scoring with the standard
BM25 formula. The index re-scans modified files on each query (cached
between calls; full re-walk at most once a minute).

Trade-off: lex-only. Queries match on shared keywords, not on semantic
similarity. For "find the conversation about onboarding even when the
word 'onboarding' wasn't used," upgrade to the community starter's
`qmd-http` backend (qmd at https://github.com/mariozechner/qmd) which
adds vector search + reranking.

## Prerequisites

- An LLM (local or API): OpenAI-compatible, Anthropic, or Ollama.
- **MQTT broker** (for inter-module messaging, even if you only have one
  module): mosquitto is fine. Config defaults to localhost:1883.
- A chat transport. Default is **Signal** via signal-cli-rest-api
  (bbernhard/signal-cli-rest-api Docker image). For Matrix/Discord/CLI
  write a custom adapter (see community starter for the pattern).

That's the entire prereq list — no qmd, no Python, no embedder.

## Run

```bash
# 1. Edit workspace/SOUL.md (replace {{PLACEHOLDERS}})
# 2. Edit workspace/config/config.json (LLM URL, chat adapter params)
# 3. From the framework root:
SYMBIENT_CONFIG=./starter-templates/minimal/workspace/config/config.json \
  npm run dev
```

## Extending

When you need more than reactive chat, look at `starter-templates/community`
for the richer pattern — cognitive modules (thinking, desire, executive),
memory enricher, context providers, workspace services, and full vector
search via qmd. Copy what you need; leave what you don't.
