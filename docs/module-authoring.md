# Writing modules

A module is one markdown file in `workspace/modules/`. Frontmatter declares
when it runs and what it may touch; the body is its prompt. The framework
hot-reloads module files every ~30s — edit and it's live next cycle.

## Frontmatter

```yaml
---
name: gardener              # defaults to the filename
interval: 6h                # cycle cadence ("30s", "15m", "6h", or ms number)
cron: "0 7 * * *"           # optional: fire at clock times instead (interval stays as upper bound)
follows: thinking           # optional: run after another module completes, not on a timer
startActive: true           # false = loaded but dormant until activated
runImmediately: false       # opt a slow module into a first cycle right at boot
tools: [search, read, edit] # whitelist — empty list means NO tools
context:                    # declarative context blocks, resolved by providers
  - source: house-status
model: some-model-id        # optional: different model, same endpoint
llm:                        # optional: full endpoint override for this module
  provider: anthropic
  model: claude-sonnet-4-5
  apiKeyEnv: ANTHROPIC_API_KEY
---
```

`tools:` entries are exact tool names, or an MCP server name (`radio`
matches `radio.*`). `context:` sources are provider names — built-ins plus
whatever `workspace/extensions/providers.ts` registers.

## The body

The body is a Handlebars template rendered fresh each cycle. Built-in vars:

- `{{currentDateTime}}`, `{{currentDate}}`, `{{currentTime}}`, `{{dayOfWeek}}`
- `{{memoryContext}}` — assembled long-term + recent memory
- `{{soul}}` — SOUL.md
- anything `workspace/extensions/helpers.ts` exports

`## Section` headings split the body into named sub-prompts, available to
handlers and template conditionals — this is how a module like magi holds
several voices in one file.

## What a cycle does

Each cycle spins up a fresh agent: system prompt = your rendered body +
assembled context, tools = your whitelist. The agent runs to idle, then the
module's **output handler** decides what happens to the text — the default
appends it to the daily journal. Deployments register custom handlers per
module name in `workspace/extensions/handlers.js`.

State between cycles lives in the files, not the agent: write to memory,
`inner/`, or wherever your deployment's `workspace.writablePaths` allows.

## Coordination

Modules nudge each other through the `nudge_module` tool (point-to-point
MQTT). A nudged module wakes immediately instead of waiting for its timer.
`follows:` chains modules into pipelines. Scheduled one-shots go through
the `schedule` tool; event-driven triggers through `register_watch`.
