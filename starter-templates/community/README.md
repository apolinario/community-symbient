# Community Symbient Starter

A deployment for a community with a cognitive inner life — thinking,
desire, inner dialogue (magi), autobiographical memory, and an
executive that deliberates and acts. Modeled on Feÿ's pattern (adapted
from [Alter3](https://alternativemachine.co.jp/en/alter3/)) but
stripped of anything Feÿ-specific: no PMS, no FM radio, no sauna
sensor, no booking system.

## Architecture

Concurrent modular agent — concurrent modules, loose coupling via MQTT,
shared markdown memory as the substrate. Per-module reasoning runs the
Pi Agent (each cycle is a tool-use loop). Layered on top: a structured
event log + declarative context providers + watches + scheduling.

## What's inside

```
workspace/
  SOUL.md              — symbient identity (edit this)
  MEMORY.md            — long-term memory (autobiographical rewrites it)
  config/config.json   — LLM, search backend, chat adapter, MQTT
  modules/
    conversation.md    — chat prompt
    thinking.md        — periodic free reflection → inner/current-state.md
    desire.md          — concrete wants → inner/current-desire.md
    magi.md            — three-voice inner dialogue → inner/current-magi.md
    autobiographical.md — periodic MEMORY.md rewrite
    executive.md       — intentional self: schedules, watches, nudges
  extensions/
    handlers.js        — output handlers for thinking/desire/magi/autobio
    providers.ts       — context providers: inner-mood, recent-dms,
                         recent-group-chat, recent-days, daily-summary,
                         active-states
    modules.ts         — registers qmd-index; add custom modules here
    helpers.js         — custom Handlebars helpers (stub)
    actions.js         — custom watch action kinds (stub)
  services/
    qmd-index/         — keeps the qmd index in sync (BM25 + vectors)
```

Framework-provided things your deployment gets automatically:
- Agent-module runner (reads `.md` modules, runs Pi Agent per cycle)
- Memory manager (SOUL/MEMORY/daily logs/person profiles, pluggable
  search backend)
- Event log, watches, schedule, hot-reload
- Built-in chat adapter (Signal — configure in config.json)
- Built-in code modules: schedule-checker, watch-evaluator, module-sync,
  conversation (reactive chat reactor)

## Search

This starter uses the **`qmd-http`** search backend (qmd —
https://github.com/mariozechner/qmd) for full vector + BM25 search with
optional reranking. Run qmd locally and point `services.search.url` at
it. The `qmd-index` module shells out to `qmd update` and `qmd embed`
on a timer to keep the index fresh — paths come from `BUN_PATH` /
`QMD_CLI` env vars.

If you don't want to run qmd, the framework also ships a `local-bm25`
backend (in-process, lex-only, zero external deps). Switch by setting
`services.search.backend` to `"local-bm25"` and removing `qmd-index`
from `enabled_modules`.

## How context flows

Each `.md` module declares context it wants in frontmatter:

```yaml
context:
  - source: recent-group-chat
  - source: recent-days
  - source: inner-mood
```

The providers (inner-mood, recent-dms, etc.) live in
`workspace/extensions/providers.ts` — deployment-owned. Add, remove, or
customize as your community evolves. The framework ships three built-in
providers: `events` (queries the event log), `current-time`,
`upcoming-scheduled`. Everything else is yours.

## Scheduling and the executive

The `schedule` tool drops one-shot or recurring actions into
`workspace/tasks/scheduled.json`. When an item is due, the
`schedule-checker` module nudges the target — `config.scheduling.defaultTarget`
sets the default; this starter routes scheduled actions to the
`executive` module so it can deliberate before acting. Each `schedule`
call can override per-item with a `target` parameter.

## Extending into a richer deployment

If your community has bookings, sensors, or a broadcast system, look at
Feÿ's deployment in the main repo (`workspace/services/feyops/`,
`workspace/services/radio/`, `workspace/services/sauna/`). Pattern:

1. Write a service folder (`workspace/services/<name>/`).
2. Add its modules + tools there.
3. Register in `workspace/extensions/modules.ts` (factory + config).
4. Add new context providers in `workspace/extensions/providers.ts` if
   the service has queryable data.

## Prerequisites

- LLM (local or API).
- **qmd** (https://github.com/mariozechner/qmd) running locally —
  defaults to http://localhost:8181. Point `services.search.url` at it.
- **MQTT broker** (mosquitto is fine; defaults to localhost:1883).
- A chat transport — Signal via signal-cli-rest-api, or write a custom
  ChatAdapter in `workspace/extensions/adapters/chat/<name>.ts`.

## Run

```bash
# 1. Edit workspace/SOUL.md (replace {{PLACEHOLDERS}})
# 2. Edit workspace/config/config.json (LLM, chat adapter params)
# 3. Set BUN_PATH and QMD_CLI env vars so qmd-index can shell out
#    (only needed if you want auto-reindex; qmd's own daemon is
#    independent).
# 4. From the framework root:
SYMBIENT_CONFIG=./starter-templates/community/workspace/config/config.json \
  BUN_PATH=/path/to/bun \
  QMD_CLI=/path/to/qmd/dist/cli/qmd.js \
  npm run dev
```

## Included cognitive modules (adapted from Alter3)

These are optional. Delete any you don't want; the framework doesn't
care. Current defaults:

- `conversation` — reactive chat (framework's chat-reactor uses
  `modules/conversation.md` as the system prompt).
- `thinking` — 30m interval. Reflects on recent events, writes to
  `inner/current-state.md`.
- `desire` — 1h interval. Generates concrete wants from community
  signals, writes to `inner/current-desire.md`.
- `magi` — 6h interval, starts inactive. Three-voice inner dialogue
  (pragmatic/critical/relational) writing to `inner/current-magi.md`.
- `autobiographical` — 6h interval. Rewrites `MEMORY.md` based on
  accumulated experience.
- `executive` — 1h interval. Intentional self: deliberates, uses
  `schedule` / `register_watch` / `nudge_module` to act. Also enters
  focused mode when `schedule-checker` wakes it with a scheduled action.
