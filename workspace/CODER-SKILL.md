# Coder Skill — How to Author Modules, Tools, and Watches

Reference for the `coder` part of the symbient when it's writing code for an approved capability gap. **Read this before designing.**

The framework runs your `.md` modules and `.ts` tools at fixed intervals or in response to events. Getting the wiring right is non-negotiable: a missing frontmatter field, a wrong scheduling pattern, or a path outside the allowed prefixes turns a useful capability into either a bricked module or a runaway loop. Every section below describes a contract the framework enforces — none of it is decorative.

---

## File layout

The repo is organized so the framework (`src/`) and the deployment (`workspace/`) are independent. You only ever write into `workspace/`. Three locations matter:

- `workspace/modules/<name>.md` — markdown-driven agent modules. The framework loads each `.md` here as a module, runs it on a schedule, feeds it tools.
- `workspace/extensions/{tools,handlers,helpers,providers,modules}.{ts,js}` — code-driven extensions registered at startup. Add a new tool or context provider here.
- `workspace/services/<name>/*.ts` — supporting code that an extension imports (db wrappers, helpers, third-party clients).

Anything else (`src/`, `config/`, etc.) is off-limits. The `open_capability_pr` tool will reject paths outside these three prefixes.

---

## Module markdown format

Every `.md` file in `workspace/modules/` is one module. The framework parses it as:

```
---
<YAML frontmatter — required for any non-default behavior>
---

<Handlebars-rendered system prompt body>
```

**The `---` fence on the FIRST line is mandatory.** A file that starts with `#` or any non-fence line gets `fields: {}` from the parser, which means: name defaults to filename, interval defaults to **60 seconds**, every tool is available, module starts active. That default is almost never what you want for a capability — most capabilities are daily, hourly, or watch-fired.

### Frontmatter fields

| field            | type                  | default                  | what it does |
|------------------|-----------------------|--------------------------|--------------|
| `name`           | string                | filename without `.md`   | Module identifier. Keep it equal to the filename to avoid surprises. |
| `interval`       | duration string or ms | `60s`                    | How often the module's cycle runs. Accepts `"500ms"`, `"30s"`, `"5m"`, `"3h"`, etc. |
| `tools`          | string[]              | `[]` → all tools         | Whitelist. **Always set this** to the minimum your module actually needs. An empty array means "all tools available." |
| `startActive`    | boolean               | `true`                   | If `false`, the module is registered but doesn't run until something activates it. |
| `runImmediately` | boolean               | `false`                  | If `true`, the first cycle runs at startup instead of waiting for the first interval tick. Useful for status modules. |
| `follows`        | string                | —                        | Make this module fire only after the named module completes a cycle. Builds simple pipelines without hardcoding cron times. |
| `dashboardLogTag`| string                | heuristic                | Custom tag the dashboard regex matches when filtering this module's daily-log entries. |
| `dashboardFiles` | string[]              | `[]`                     | Workspace-relative paths shown in the per-module dashboard panel. |
| `context`        | provider declarations | `[]`                     | Declarative context blocks merged into the prompt — see below. |

### Body

Everything after the closing `---` is a Handlebars template. It becomes the system prompt for the agent that runs each cycle. You can use:

- `{{currentTime}}`, `{{currentDate}}`, `{{currentDateTime}}`, `{{dayOfWeek}}` — built-in time helpers.
- `{{memoryContext}}` — assembled SOUL.md + MEMORY.md context.
- `{{soul}}` — just SOUL.md.
- Any deployment-registered helper from `workspace/extensions/helpers.ts` — e.g. `{{innerState}}`, `{{currentDesire}}`, `{{pendingCapabilityGaps}}`.
- `## section` headings split the body — the part above any `## ...` becomes the main template; subsequent H2 sections become named sub-prompts available to handlers.

The body is **prompt content**, not config. Writing "## Schedule\n- Runs daily at 12:00" tells the LLM that's the intent, but it doesn't actually create a schedule. Use frontmatter or a watch.

### Context providers

The `context:` frontmatter array declares structured context blocks merged into the prompt every cycle. Example:

```yaml
context:
  - source: current-time
  - source: pending-capability-gaps
  - source: recent-dms
    count: 20
    with: Apolinário
  - source: house-status
```

Each entry's `source` matches a registered provider in `workspace/extensions/providers.ts`. Available sources at the time of writing: `house-status`, `sauna`, `season-today`, `current-meal`, `recent-broadcasts`, `inner-mood`, `recent-dms`, `recent-group-chat`, `recent-days`, `daily-summary`, `active-states`, `most-played-songs`, `active-threads`, `pending-capability-gaps`, plus framework-shipped `current-time`, `events-recent`. Read `workspace/extensions/providers.ts` if you need to confirm the current list.

---

## Three scheduling patterns

Pick the one that matches the capability — getting this wrong is the most common failure mode.

### A. Interval

Use when "every N minutes/hours" is the right cadence and the module will check its own conditions on each tick. Set `interval: 5m` or `interval: 1h` in frontmatter. The module body should include logic to decide whether *this particular tick* should act.

```yaml
---
name: hourly-check
interval: 1h
startActive: true
tools: [check_sauna, radio_broadcast]
---
Each cycle, check the sauna temp. If above 70°C and you haven't broadcast in the past 4 hours, announce it on the radio.
```

### B. Cron (specific time of day or day of week)

Use when the capability genuinely needs to fire at a specific clock time ("daily at noon", "weekdays at 9am"). The framework's `schedule_checker` polls cron entries from `workspace/tasks/scheduled.json`. Don't hand-edit that file — register a cron via the `register_watch` tool with a `schedule` action, OR have your module call the `schedule` tool with a cron expression on its first run.

For a daily-at-noon module:

```yaml
---
name: daily-noon-broadcast
interval: 24h
startActive: true
runImmediately: false
tools: [schedule, list_schedule]
---
On your very first cycle, register a cron schedule with: schedule(cron: "0 12 * * *", prompt: "fire daily noon broadcast", target: "daily-noon-broadcast"). On subsequent cycles when nudged with a "scheduled_action" payload, do the actual work.
```

For most cases though, prefer simply setting `interval: 24h` and using `dayOfWeek`/`currentTime` helpers in the prompt to gate behavior. Cron only when "exact time" is load-bearing.

### C. Watch (event-driven)

Use when the capability should react to *events*, not the clock — "when sauna passes 80°C", "when a new booking arrives", "when someone DMs the symbient with X". Watches live in `workspace/state/watches.json` and are evaluated by the `watch-evaluator` framework module. Register via the `register_watch` tool. Watch shape:

```json
{
  "id": "watch-<unique>",
  "on": {
    "type": "<event_type>",
    "trigger": "always" | "crossing_up" | "crossing_down",
    "where": "<expression>"
  },
  "action": { "kind": "dm" | "group" | "nudge", ... }
}
```

Supported `where` operators: `==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=`, `&&`, `||`. Field access on event payloads only — no method calls, no regex literals, no assignment. Look at `src/core/condition-eval.ts` for the exact grammar before authoring complex `where` expressions.

---

## Tools, handlers, and providers

If the gap needs a new **tool** (something the agent can call from inside a cycle, like `check_weather`):

1. Write the tool factory in `workspace/services/<name>/tools.ts` exporting `createXxxTool(deps): AgentTool`.
2. Register it in `workspace/extensions/tools.ts` inside the default-export factory: `tools.push(createXxxTool({...deps}))`.
3. Whitelist it in any module that should be able to call it.

If the gap needs a new **context provider** (something that injects content into prompts, like `weekly-weather`):

1. Write the provider object in `workspace/extensions/providers.ts` with shape `{ async execute(decl, ctx) { return "<content block>" }, source: "weekly-weather" }`.
2. Add it to the default-export object.
3. Reference it in any module's frontmatter `context:` block.

If the gap needs **post-cycle output processing** (something that runs *after* the agent finishes, like writing to a custom log file):

1. Add a key matching the module's `name` to the default export of `workspace/extensions/handlers.js`. The function receives `(ctx, output, toolTrace, toolCalls)`.
2. The framework will call it after every cycle of the module with that name.

---

## Path constraints (enforced by `open_capability_pr`)

Writes restricted to:
- `workspace/modules/`
- `workspace/extensions/`
- `workspace/services/`

You cannot write into `workspace/inner/`, `workspace/state/`, `workspace/memory/`, `workspace/people/`, `src/`, `config/`, `.gitignore`, package files, or anywhere else. Inner-state files are *read* by your module at runtime via the `read` tool; they're *written* by the running module via the `edit`/`write` tools (which the running module has, but the PR tool does not).

If your module needs an inner-state file (e.g. a roster, a log), don't ship it in the PR. Have the module create it on first run via `write`/`edit`.

---

## Worked example: a daily roster-driven broadcast module

This is the shape the Feyblade simulator should have had. Daily noon, draws from a stored roster, simulates, broadcasts. The roster file is created on first run, not shipped in the PR.

```yaml
---
name: feyblade-simulator
interval: 1h
startActive: true
runImmediately: true
tools: [read, write, edit, radio_broadcast, check_bookings]
context:
  - source: current-time
  - source: house-status
---

It is {{currentDateTime}}. The day is {{dayOfWeek}}.

You run a daily Feyblade tournament. The interval is 1h but you only act once per day around noon — check the current time and stop early if outside the 12:00–13:00 window OR if today's tournament already happened (the battle log records the last fire date).

## Roster

Read `inner/feyblade-roster.json`. If the file doesn't exist, initialize it with the current residents from house-status — assign each a playful blade name and stats (power 5–10, defense 5–10) — and write it. Add new residents on subsequent days. Remove departed ones.

## Battle

Run a single-elimination bracket. Each match: roll d20 per fighter, add power, +1 per defense point above 7. Higher total wins. Continue until a champion remains.

## Broadcast

Call radio_broadcast with a 20-second announcement: name today's champion, name one notable upset or moment. Sign off with "FEYBLADE — LET IT RIP". Append the result to inner/feyblade-battle-log.md so subsequent cycles know not to re-fire today.
```

Key choices made above and why:

- `interval: 1h` not `24h`: gives the module multiple chances to fire if the system was down at exactly noon. The "fire once per day" gate is the battle log check, not the interval.
- `runImmediately: true`: lets the operator validate it works at deploy time without waiting an hour.
- Roster lives at `inner/feyblade-roster.json`, NOT shipped in the PR — created on first run by the module's own `write` tool call.
- Tool whitelist is minimal — no `send_dm`, no `web_search`, etc. Only what this module actually needs.
- Context blocks include `house-status` so the module can see who's currently at the château without needing `check_bookings` every tick.

---

## Common pitfalls

1. **No frontmatter fence.** File starts with `# Title` instead of `---`. Module loads but uses every default — interval 60s, all tools, etc. Always start with `---`.
2. **Describing schedule in prose instead of frontmatter.** "Runs daily at noon" in the body is *just text the LLM reads*. The actual schedule comes from `interval` or a watch.
3. **YAML data block in the body.** Putting roster/config data inside ```yaml fences in the prompt body means the LLM has to re-parse it as text every cycle. Store data in a separate file the module reads/writes.
4. **Tools whitelist left empty.** `tools: []` falls back to *all* tools — usually too permissive and a source of capability creep. Always specify.
5. **Shipping inner-state files in the PR.** `open_capability_pr` rejects writes outside `modules/`/`extensions/`/`services/`. Initialize state files at runtime, not at PR time.
6. **`where` expression using unsupported operators.** Watch grammar is restricted (no `=~`, no method calls). If you write `text =~ /pattern/`, the watch fails to compile and gets logged as an error every cycle.

---

## Quick checklist before calling `open_capability_pr`

- [ ] First line of every `.md` is `---`.
- [ ] Frontmatter has at minimum: `name`, `interval` (or watch-driven), `tools` whitelist, `startActive`.
- [ ] If scheduling: matched the right pattern (interval / watch / cron) for the capability.
- [ ] Tool whitelist is the minimum needed.
- [ ] No state files in the `files:` array — those get created at runtime.
- [ ] All file paths start with `workspace/modules/`, `workspace/extensions/`, or `workspace/services/`.
- [ ] Body docstring at the top of every file explains what the file does and why the gap warranted it.
