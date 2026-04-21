# Community Symbient Starter

A deployment for a community with a cognitive inner life — thinking,
desire, inner dialogue (magi), autobiographical memory, and an
executive that deliberates and acts. Modeled on Feÿ's pattern (adapted
from [Alter3](https://alternativemachine.co.jp/en/alter3/)) but
stripped of anything Feÿ-specific: no PMS, no FM radio, no sauna
sensor, no booking system.

## Architecture

Modified Concurrent Modular Agent — see the CMA paper
(https://arxiv.org/pdf/2508.19042) for the underlying ideas: concurrent
modules, loose coupling via message passing, Baars's global workspace
as a shared substrate, no central planner. Our substrate is files on
disk (OpenClaw-style) rather than a vector store, per-module reasoning
uses the Pi Agent (each module's cycle runs a Pi tool-use loop), and
we layer a structured event log + declarative context providers on top.

## What's inside

```
workspace/
  SOUL.md              — symbient identity (edit this)
  MEMORY.md            — long-term memory (autobiographical rewrites it)
  config/config.json   — LLM, QMD, chat adapter, MQTT
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
    modules.ts         — wires workspace modules into the framework
    helpers.js         — custom Handlebars helpers (stub)
    actions.js         — custom watch action kinds (stub)
  services/
    conversation/      — chat handler: triage + retry + attachment
                         handling + executive-nudge protocol
                         (replaces framework's chat-reactor)
```

Framework-provided things your deployment gets automatically:
- Agent-module runner (reads `.md` modules, runs Pi Agent per cycle)
- Memory manager (SOUL/MEMORY/daily logs/person profiles/qmd search)
- Event log, watches, schedule, hot-reload
- Signal chat adapter (built-in — just configure in config.json)
- qmd-index, schedule-checker, watch-evaluator, module-sync

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

## Extending into a Feÿ-like deployment

If your community has bookings, sensors, or a broadcast system, look at
Feÿ's deployment in the main repo (`workspace/services/feyops/`,
`workspace/services/radio/`, `workspace/services/sauna/`). Pattern:

1. Write a service folder (`workspace/services/<name>/`).
2. Add its modules + tools there.
3. Register in `workspace/extensions/modules.ts` (factory + config).
4. Add new context providers in `workspace/extensions/providers.ts` if
   the service has queryable data (e.g. "current sauna temperature"
   becomes a provider, not a hardcoded memory block).

## Prerequisites

- LLM (local or API)
- qmd (http://localhost:8181 by default)
- MQTT broker (localhost:1883 by default)
- Chat transport — Signal via signal-cli-rest-api, or write a custom
  ChatAdapter in `workspace/extensions/adapters/chat/<name>.ts`

## Run

```bash
# 1. Edit workspace/SOUL.md (replace {{PLACEHOLDERS}})
# 2. Edit workspace/config/config.json (LLM URL, chat adapter params)
# 3. From the framework root:
FEYBLET_CONFIG=./starter-templates/community/workspace/config/config.json \
  npm run dev
```

## Included cognitive modules (adapted from Alter3)

These are optional. Delete any you don't want; the framework doesn't
care. Current defaults:

- `conversation` — reactive chat (bespoke service with triage +
  executive-nudge protocol). Replaces framework's chat-reactor.
- `thinking` — 30m interval. Reflects on recent events, writes to
  `inner/current-state.md`.
- `desire` — 1h interval. Generates concrete wants from community
  signals, writes to `inner/current-desire.md`.
- `magi` — 6h interval, starts inactive. Three-voice inner dialogue
  (pragmatic/critical/relational) writing to `inner/current-magi.md`.
- `autobiographical` — 6h interval. Rewrites `MEMORY.md` based on
  accumulated experience.
- `executive` — 1h interval. Intentional self: runs full cycle of
  deliberation, uses `schedule`/`register_watch`/`nudge_module` to act.
  Also enters focused mode when `schedule-checker` wakes it with a
  scheduled action.
