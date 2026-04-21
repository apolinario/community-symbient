# Starter Template

Minimal skeleton for a new symbient deployment. Copy this directory into
your deployment repo (or fork the framework), fill in the placeholders,
add your chat/sensor/output adapters as needed, and run.

## Architecture

This framework uses a **modified Concurrent Modular Agent (CMA) architecture**,
cross-pollinated with the Pi Agent (for per-module reasoning) and OpenClaw
(for memory-as-markdown).

The original CMA ([paper](https://arxiv.org/pdf/2508.19042),
[reference impl](https://github.com/AlternativeMachine/concurrent-modular-agent))
draws on subsumption architecture (Brooks), asynchronous message passing,
and Baars's global workspace theory. Modules run concurrently, loosely coupled
via MQTT, and share a vector-store "DSM" (distributed shared memory). Every
module reads and writes the DSM; no central planner.

### What we keep from CMA
- **Concurrent modules.** Each `.md` in `workspace/modules/` runs on
  its own cycle.
- **Loose coupling via MQTT.** `ctx.messages.send(module, content)`
  routes over MQTT to the target module's mailbox. The `nudge_module`
  tool exposes the same.
- **Shared substrate.** Every module reads and writes the same memory.
- **Emergent behavior.** No central planner — modules like `desire`,
  `thinking`, and `magi` run in parallel and influence each other
  through the shared substrate.

### What we modify
- **Memory-as-markdown** (from OpenClaw). Instead of CMA's ChromaDB
  vector store as primary DSM, our DSM is **files on disk**: `SOUL.md`,
  `MEMORY.md`, `inner/*.md`, `memory/YYYY-MM-DD.md`, `people/*.md`. A
  `qmd-index` module layers vector search on top, but files are the
  source of truth — human-readable, editable, diffable.

- **Pi Agent per module.** Each module's cycle instantiates a
  [Pi Agent](https://github.com/mariozechner/pi-mono) which itself runs
  an internal tool-use loop (ask LLM → call tool → re-evaluate → repeat
  until done). So each CMA module is itself a mini while-loop. The
  concurrent layer is the CMA module scheduler; the reactive layer is
  the Pi Agent inside each cycle.

- **Structured event log.** We add an append-only JSONL event stream
  (`workspace/logs/YYYY-MM-DD.jsonl`) alongside markdown. Context
  providers pull from events declaratively in frontmatter; watches
  fire on event transitions. Not in the CMA reference — but consistent
  with the same "shared substrate" principle.

- **Declarative seed prompts + handlebars templates.** Modules define
  their prompt in the `.md` body with `{{currentDateTime}}` etc.,
  and seed context in frontmatter (`context: - source: events, ...`).
  No per-module Python code unless you really need it.

### Cognitive modules (adapted from Alter3)

The cognitive modules below — `thinking`, `desire`, `magi` (inner
dialogue), `autobiographical`, `executive` — are adapted from
[Alter3](https://alternativemachine.co.jp/en/alter3/), the android
project by Alternative Machine that predates and inspired the CMA
formalization. Alter3 runs concurrent cognitive processes that argue,
reflect, and act; CMA is the generalized framework extracted from
that experience.

The CMA reference repo itself ships only bare demos (`chat`, `echo`,
`vision`) — the cognitive architecture lives in the Alter3 instantiation.
We've adapted it for a community symbient (as opposed to an embodied
robot), but the underlying patterns — periodic free reflection,
concrete desire generation, multi-voice inner dialogue,
autobiographical memory rewriting — are Alter3's contribution.

Keep these modules, delete them, or replace with your own cognitive
architecture. The framework is pattern-agnostic; this starter is just
a sensible Alter3/CMA default adapted for a digital-community context.

## Included CMA modules (all optional — delete what you don't want)

- `conversation.md` — reactive chat module. Handles DMs and group
  messages. The only one that's basically required if your symbient
  has a chat surface.
- `thinking.md` — periodic free reflection on recent events. Writes
  to `inner/current-state.md`. 30-minute interval.
- `desire.md` — generates concrete wants based on observed state.
  Writes to `inner/current-desire.md`. 1-hour interval.
- `magi.md` — three-voice inner dialogue (pragmatic/critical/relational).
  Writes to `inner/current-magi.md`. 6-hour interval, starts inactive.
- `autobiographical.md` — periodically rewrites `MEMORY.md` from
  accumulated daily logs. 6-hour interval.
- `executive.md` — intentional self: deliberates, schedules, registers
  watches, nudges other modules. 1-hour regular cycle, plus focused
  scheduled-action mode when `schedule-checker` wakes it.

## Quick start

1. **Identity** — edit `workspace/SOUL.md`. Replace `{{SYMBIENT_NAME}}`,
   `{{COMMUNITY_NAME}}`, and the `{{...}}` prose blocks. This file IS
   the symbient — every module's prompt includes it via `{{memoryContext}}`.

2. **Conversation module** — `workspace/modules/conversation.md` is
   provided as a minimal chat responder. Adjust the voice, tool list,
   and group-vs-DM behavior to match your community.

3. **Chat adapter** — by default the framework uses Signal. If you want
   a different transport (Matrix, Discord, CLI-only), drop a factory in
   `workspace/extensions/adapters/chat/<name>.js`:

   ```javascript
   export default {
     name: "matrix",
     create: (params) => ({
       name: "matrix",
       start: async () => { /* connect */ },
       send: async ({to, text, groupId}) => { /* dispatch */ },
       onMessage: (handler) => { /* register */ },
     }),
   };
   ```

   Then reference it in your config. (Config-driven adapter selection
   lands in a later commit — for now, the framework defaults to Signal
   if nothing else is registered.)

4. **Extensions** — the `workspace/extensions/` files are stubbed with
   commented examples. Uncomment what you need:
   - `helpers.js` — custom `{{placeholder}}` values in prompts
   - `providers.js` — custom seed-prompt context blocks
   - `actions.js` — custom watch action kinds
   - `handlers.js` — custom module-output processing

5. **Add your own modules** — drop any `name.md` into
   `workspace/modules/`. The loader picks it up at startup (or within
   30s via `module-sync` without restart). Frontmatter declares the
   tools, interval, and any `context:` providers. Body is a Handlebars
   template with full access to helpers.

## Directory structure

```
workspace/
  SOUL.md                    # identity — THE most important file
  MEMORY.md                  # curated long-term knowledge (grows over time)
  modules/
    conversation.md          # required (this is how the symbient speaks)
    <other>.md               # thinking, desire, executive, radio — all optional
  people/
    <slug>.md                # one per community member
  season/, inner/, memory/   # operational state (gitignored in practice)
  extensions/
    helpers.js               # Handlebars helpers
    handlers.js              # module output handlers
    providers.js             # context providers
    actions.js               # watch action kinds
    adapters/chat/*.js       # custom chat transports
    adapters/directory/*.js  # custom member directories
  sensors/*.js               # custom sensor implementations (optional)
```

## What the framework provides

You get the following without writing any code:

- **Concurrent module system** — each `.md` in `modules/` runs on its
  own schedule. MQTT inter-module messaging via `nudge_module` tool.
- **Event log** — structured JSONL per day in `logs/`. Emit custom
  event types with `recordEvent()` from `extensions-api`. Query with
  `queryEvents()`.
- **Context providers** — declare `context:` blocks in frontmatter to
  populate seed prompts without code. Built-in providers for current
  time, recent events, upcoming schedule, etc.
- **Watches** — event-driven triggers. `register_watch` tool from any
  module; condition is a simple expression (`temp >= 82`).
  Built-in triggers: `always`, `crossing_up`, `crossing_down`.
- **Pi file tools** — sandboxed `read`/`write`/`edit`/`grep`/`find`/`ls`
  scoped to your workspace with a writable-path allowlist.
- **Memory manager** — daily logs, SOUL/MEMORY, people profiles, and
  automatic context assembly for LLM calls.
- **Schedule/cron** — `schedule` tool creates one-shot or recurring
  actions; `schedule-checker` fires them to the executive module.
- **Hot-reload** — edit `.md` files and they reload within 30s.

## What you need to bring

- An LLM backend (OpenAI-compatible, Anthropic, or Ollama). Set via
  `config/feyblet.json` or env vars.
- A chat transport (default: Signal via signal-cli-rest-api).
- Any sensors, directories, or output channels your community needs.

See the framework's main README for LLM setup and full configuration.
