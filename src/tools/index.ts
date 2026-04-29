/**
 * Framework Tools — Pi Agent SDK native tools.
 *
 * All tools use Pi's AgentTool interface with TypeBox schemas
 * for typed, validated parameters. The Pi Agent handles the
 * tool execution loop automatically — no text parsing needed.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../memory/manager.js";
import type { MQTTBus } from "../core/mqtt-bus.js";
import { queryEvents } from "../core/event-log.js";
import { symbientName, symbientDisplayName } from "../core/symbient-name.js";
import { getSearchBackend } from "../core/search.js";

/**
 * Runtime service URLs and policy values — set once at startup from
 * `config.services` and `config.moduleManagement`. Tools close over these.
 * A tool whose service isn't configured silently degrades (web_search
 * returns "service not configured", etc.). The search tool delegates
 * to whichever `SearchBackend` was registered via `setSearchBackend`.
 */
let searxngUrl: string | undefined;
let moduleLimits = {
  maxModules: 20,
  creationsPerWeek: 1,
  minIntervalMs: 5 * 60 * 1000,
};

export function configureToolServices(options: {
  searxngUrl?: string;
  moduleManagement?: {
    maxModules?: number;
    creationsPerWeek?: number;
    minIntervalMs?: number;
  };
}): void {
  searxngUrl = options.searxngUrl;
  if (options.moduleManagement) {
    moduleLimits = {
      maxModules: options.moduleManagement.maxModules ?? moduleLimits.maxModules,
      creationsPerWeek: options.moduleManagement.creationsPerWeek ?? moduleLimits.creationsPerWeek,
      minIntervalMs: options.moduleManagement.minIntervalMs ?? moduleLimits.minIntervalMs,
    };
  }
}


// --- Memory Search ---

export function createSearchMemoryTool(): AgentTool {
  return {
    name: "search",
    description: "Search everything — memory, people profiles, past conversations, community knowledge, and more",
    label: "Search",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
    }),
    execute: async (_id, params) => {
      try {
        const results = await getSearchBackend().query({
          searches: [
            { type: "vec", query: params.query },
            { type: "lex", query: params.query },
          ],
          collection: symbientName(),
          limit: 10,
          maxPerFile: 5,
          rerank: true,
        });
        if (results.length === 0) return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: {} };

        const text = results
          .map((r) => `**${r.title}** (${r.file}, ${Math.round(r.score * 100)}%)\n${r.chunk || r.snippet}`)
          .join("\n\n");
        return { content: [{ type: "text", text }], details: {} };
      } catch {
        return { content: [{ type: "text", text: "Memory search unavailable." }], details: {} };
      }
    },
  };
}

// --- Chat History (queries the structured event log) ---

/** Pull the counterparty name from a chat_message event — `to` for outbound, `from` for inbound. */
function counterpartyOf(evt: Record<string, unknown>): string | null {
  const field = evt.direction === "out" ? evt.to : evt.from;
  return typeof field === "string" ? field : null;
}

/**
 * Tally counterparties from a list of DM chat_message events and return
 * a "Recent DM contacts" tool response. Lifted out of chat_history so
 * the per-person branch isn't crowded by the contacts-listing branch.
 */
function listDmContacts(
  events: Array<Record<string, unknown>>,
  self: string,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  const contacts = new Map<string, number>();
  for (const evt of events) {
    const counterparty = counterpartyOf(evt);
    if (!counterparty || counterparty === self) continue;
    contacts.set(counterparty, (contacts.get(counterparty) || 0) + 1);
  }
  if (contacts.size === 0) {
    return { content: [{ type: "text", text: "No DM contacts in the recent window." }], details: {} };
  }
  const sorted = [...contacts.entries()].sort((a, b) => b[1] - a[1]);
  const list = sorted.map(([name, n]) => `${name} (${n} messages)`).join("\n");
  return {
    content: [{
      type: "text",
      text: `Recent DM contacts:\n${list}\n\nCall chat_history with a person name to see their conversation.`,
    }],
    details: {},
  };
}

/**
 * Format a chat_message event as a single line. Direction-aware:
 *   [HH:mm] in  Alice: hi
 *   [HH:mm] out → Alice: hi back
 */
function formatChatLine(evt: Record<string, unknown>, _self: string): string {
  const ts = typeof evt.ts === "number" ? new Date(evt.ts) : new Date();
  const time = ts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const direction = evt.direction === "out" ? "out →" : "in  ←";
  const counterparty = counterpartyOf(evt) ?? "?";
  const text = typeof evt.text === "string" ? evt.text : "(no text)";
  return `[${time}] ${direction} ${counterparty}: ${text}`;
}

export function createChatHistoryTool(memory: MemoryManager): AgentTool {
  return {
    name: "chat_history",
    description: "Load DM conversation history from the event log. Without a name: lists who you've DMed recently. With a name: loads the DM thread with that person. Use this to check what you've already said before sending another message.",
    label: "Chat History",
    parameters: Type.Object({
      person: Type.Optional(Type.String({ description: "Person name to load DM history with. Omit to see a list of recent DM contacts." })),
      count: Type.Optional(Type.Number({ description: "How many messages to load (default 20)" })),
      days: Type.Optional(Type.Number({ description: "How many days back to scan (default 2)" })),
    }),
    execute: async (_id, params) => {
      try {
        const count = params.count || 20;
        const days = params.days || 2;
        const self = symbientDisplayName();

        // All DM chat_message events in the window. The chat-reactor
        // writes inbound/outbound DMs as `chat_message` events with
        // chat="dm" and direction="in"|"out".
        const events = await queryEvents({
          type: "chat_message",
          where: { chat: "dm" },
          days,
        });

        if (events.length === 0) {
          return { content: [{ type: "text", text: "No DM events found in the event log." }], details: {} };
        }

        if (!params.person) return listDmContacts(events, self);

        // Resolve the requested name through the memory manager so nicknames
        // / aliases match. Then build a set of name candidates to compare
        // against the event log's `from`/`to` fields.
        const person = await memory.findPerson(params.person);
        const matchName = (() => {
          if (!person) return null;
          const match = person.content.match(/^name:\s*(.+)/m);
          return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
        })();
        const searchNames = new Set<string>([params.person.toLowerCase()]);
        if (matchName) searchNames.add(matchName.toLowerCase());

        const matching = events.filter((evt) => {
          const counterparty = evt.direction === "out"
            ? (typeof evt.to === "string" ? evt.to : null)
            : (typeof evt.from === "string" ? evt.from : null);
          return counterparty !== null && searchNames.has(counterparty.toLowerCase());
        });

        if (matching.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No DM history with "${params.person}"${matchName && matchName.toLowerCase() !== params.person.toLowerCase() ? ` (matched: ${matchName})` : ""}.`,
            }],
            details: {},
          };
        }

        const header = matchName && matchName.toLowerCase() !== params.person.toLowerCase()
          ? `DM history with ${matchName} (matched from "${params.person}"):\n`
          : `DM history with ${params.person}:\n`;
        const lines = matching.slice(-count).map((evt) => formatChatLine(evt, self));
        return { content: [{ type: "text", text: header + lines.join("\n") }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `chat_history error: ${err}` }], details: {} };
      }
    },
  };
}

// --- Web Search (SearXNG-compatible) ---

export function createWebSearchTool(): AgentTool {
  return {
    name: "web_search",
    description: "Search the web for information. Use when you need to look up something beyond your memory — facts, events, people, music, news.",
    label: "Web Search",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
    }),
    execute: async (_id, params) => {
      if (!searxngUrl) {
        return { content: [{ type: "text", text: "Web search not configured (set config.services.searxng.url)." }], details: {} };
      }
      try {
        const url = `${searxngUrl}/search?q=${encodeURIComponent(params.query)}&format=json&categories=general&language=en`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return { content: [{ type: "text", text: `Search failed: ${res.status}` }], details: {} };

        const data = await res.json() as any;
        const rawResults = Array.isArray(data.results) ? data.results : [];
        const results = rawResults.slice(0, 5);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found." }], details: {} };
        }

        const formatted = results.map((r: any) =>
          `${r.title}\n${r.url}\n${r.content || ""}`.trim()
        ).join("\n\n");

        return { content: [{ type: "text", text: formatted }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Search error: ${err}` }], details: {} };
      }
    },
  };
}

// --- Nudge Module (inter-module MQTT messaging) ---

export function createNudgeModuleTool(bus: MQTTBus, senderName: string): AgentTool {
  const client = bus.clientFor(`nudge-${senderName}`);
  return {
    name: "nudge_module",
    description: "Send a message to another running module. The target wakes up on its next cycle and acts on the message with its own judgment. Use `list_modules` to see what's currently registered.",
    label: "Nudge Module",
    parameters: Type.Object({
      module: Type.String({ description: "Target module name (must match a currently-registered module — see list_modules)." }),
      message: Type.String({ description: "What you want the module to do — it will wake up and act on this with its own judgment" }),
    }),
    execute: async (_id, params) => {
      await client.send(params.module, params.message);
      return { content: [{ type: "text", text: `Nudged ${params.module}: "${params.message.slice(0, 100)}"` }], details: {} };
    },
  };
}

// --- Schedule (messages to future self) ---

interface ScheduleEntry {
  id: string;
  prompt: string;
  context?: string | null;
  when?: number;
  cron?: string;
  nextRun?: number;
  expires?: string | null;
  target?: string;
  created?: string;
  done?: boolean;
}

/**
 * Tiny JSON-backed store for `workspace/tasks/scheduled.json`. Centralises
 * the load-mutate-save scaffolding so every schedule operation goes through
 * the same code path.
 */
/**
 * Parse a free-form expires string ("2026-05-01", "in 3w", etc.) into an
 * ISO timestamp, or return null if the input is empty or unparseable.
 * Extracted from createScheduleTool so the cron branch stays flat.
 */
async function resolveExpiresIso(expires: unknown): Promise<string | null> {
  if (!expires || typeof expires !== "string") return null;
  const { parseTime } = await import("../core/time-parser.js");
  const t = await parseTime(expires);
  return t ? new Date(t).toISOString() : null;
}

function scheduleStore(workspacePath: string) {
  return {
    async load(): Promise<{ path: string; items: ScheduleEntry[] }> {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const filePath = path.join(workspacePath, "tasks", "scheduled.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let items: ScheduleEntry[] = [];
      try {
        items = JSON.parse(await fs.readFile(filePath, "utf-8"));
      } catch {
        // Missing or empty file is normal; treat as empty schedule.
      }
      return { path: filePath, items };
    },
    async save(filePath: string, items: ScheduleEntry[]): Promise<void> {
      const fs = await import("node:fs/promises");
      await fs.writeFile(filePath, JSON.stringify(items, null, 2), "utf-8");
    },
  };
}

export function createScheduleTool(workspacePath: string): AgentTool {
  const store = scheduleStore(workspacePath);
  return {
    name: "schedule",
    description: "Schedule an action for your future self. When the time comes, the action is delivered to a module that wakes up and executes it. Use `cron` for recurring patterns (preferred) or `when` for one-shot times.",
    label: "Schedule",
    parameters: Type.Object({
      when: Type.Optional(Type.String({ description: "One-shot time: ISO datetime, 'tomorrow 10:00', 'in 3h', 'at 18:30'. Use this OR cron, not both." })),
      cron: Type.Optional(Type.String({ description: "Cron expression for recurring schedules. Examples: '30 11 * * 1-5' (11:30 weekdays), '0 17 * * *' (17:00 daily), '0 9 * * 1' (9:00 Mondays). Format: min hour day month weekday." })),
      prompt: Type.String({ description: "The action to execute — be specific: 'Send a group message reminding everyone the meeting starts in 30 minutes at 12:00'" }),
      context: Type.Optional(Type.String({ description: "Background context for when the action fires" })),
      expires: Type.Optional(Type.String({ description: "When to stop recurring (ISO datetime). Only for cron schedules." })),
      target: Type.Optional(Type.String({ description: "Module to wake up when this fires. Omit to use the deployment's default chat-handler module — see your `list_modules` output." })),
    }),
    execute: async (_id, params) => {
      if (!params.when && !params.cron) {
        return { content: [{ type: "text", text: "Provide either `when` (one-shot) or `cron` (recurring)." }], details: {} };
      }

      const { path: schedulePath, items: schedule } = await store.load();

      if (params.cron) {
        try {
          const { Cron } = await import("croner");
          const job = new Cron(params.cron);
          const next = job.nextRun();
          if (!next) {
            return { content: [{ type: "text", text: `Cron "${params.cron}" has no upcoming runs.` }], details: {} };
          }

          const expiresTime = await resolveExpiresIso(params.expires);

          const entry: ScheduleEntry = {
            id: `sched-${Date.now()}`,
            cron: params.cron,
            nextRun: next.getTime(),
            prompt: params.prompt,
            context: params.context || null,
            expires: expiresTime,
            created: new Date().toISOString(),
            done: false,
          };
          if (params.target) entry.target = params.target;

          schedule.push(entry);
          await store.save(schedulePath, schedule);

          const nextStr = next.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
          return { content: [{ type: "text", text: `Cron scheduled (${params.cron}), next run: ${nextStr}. Action: "${params.prompt.slice(0, 100)}"` }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid cron expression "${params.cron}": ${err}` }], details: {} };
        }
      }

      // One-shot with `when`
      const { parseTime } = await import("../core/time-parser.js");
      const atTime = await parseTime(params.when!);
      if (!atTime) {
        return { content: [{ type: "text", text: `Could not parse time: "${params.when}". Try ISO datetime, "tomorrow 10:00", etc.` }], details: {} };
      }

      const entry: ScheduleEntry = {
        id: `sched-${Date.now()}`,
        when: atTime,
        prompt: params.prompt,
        context: params.context || null,
        created: new Date().toISOString(),
        done: false,
      };
      if (params.target) entry.target = params.target;

      schedule.push(entry);
      await store.save(schedulePath, schedule);

      const whenStr = new Date(atTime).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
      return { content: [{ type: "text", text: `Scheduled for ${whenStr}: "${params.prompt.slice(0, 100)}"` }], details: {} };
    },
  };
}

export function createListScheduleTool(workspacePath: string): AgentTool {
  const store = scheduleStore(workspacePath);
  return {
    name: "list_schedule",
    description: "View your scheduled future messages",
    label: "List Schedule",
    parameters: Type.Object({}),
    execute: async () => {
      const { items: schedule } = await store.load();
      const pending = schedule.filter((s) => !s.done);
      if (pending.length === 0) {
        return { content: [{ type: "text", text: "No scheduled items." }], details: {} };
      }

      const lines = pending.map((s) => {
        if (s.cron) {
          const nextStr = s.nextRun ? new Date(s.nextRun).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "computing...";
          return `[${s.id}] cron: ${s.cron} (next: ${nextStr}): ${s.prompt.slice(0, 100)}`;
        }
        const when = s.when ? new Date(s.when).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "(no time)";
        return `[${s.id}] ${when}: ${s.prompt.slice(0, 100)}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };
}

export function createCancelScheduleTool(workspacePath: string): AgentTool {
  const store = scheduleStore(workspacePath);
  return {
    name: "cancel_scheduled",
    description: "Cancel a scheduled item by ID",
    label: "Cancel Scheduled",
    parameters: Type.Object({
      id: Type.String({ description: "The schedule entry ID to cancel" }),
    }),
    execute: async (_id, params) => {
      const { path: schedulePath, items: schedule } = await store.load();
      const entry = schedule.find((s) => s.id === params.id);
      if (!entry) return { content: [{ type: "text", text: `Not found: ${params.id}` }], details: {} };

      entry.done = true;
      await store.save(schedulePath, schedule);
      return { content: [{ type: "text", text: `Cancelled: ${entry.prompt.slice(0, 80)}` }], details: {} };
    },
  };
}

// --- Watches (event-driven triggers) ---

export function createRegisterWatchTool(senderName: string): AgentTool {
  return {
    name: "register_watch",
    description: [
      "Register a watch that fires an action when a matching event occurs. Use instead of a polling cron when the trigger is a structured condition.",
      "",
      "WHERE EXPRESSION GRAMMAR — restrictive, read carefully:",
      "  Operators: == != === !== < <= > >= && ||",
      "  Field access: bare identifiers (e.g. `from`) and dotted (`from.name`).",
      "  Literals: numbers, strings (double or single quoted), true/false/null.",
      "",
      "NOT SUPPORTED (these will fail to compile and your watch will be rejected):",
      "  - Regex literals (/.../) and =~ operator. There is NO substring or pattern match.",
      "  - Method calls (.includes, .startsWith, .toLowerCase, etc.).",
      "  - Arithmetic, function calls, ternary, array/object literals.",
      "",
      "If you want \"someone mentioned X\" — that's NOT possible as a watch. Don't try. Either subscribe via your conversation prompt + react in the moment, or skip it.",
      "",
      "FIELDS BY EVENT TYPE — only these are reliable; check via `events_recent` first if unsure:",
      "  chat_message: type, direction (\"in\"|\"out\"), chat (\"dm\"|\"group\"), from (display name), fromId, to, text, groupId, ts",
      "  broadcast:    type, message, voice, ts",
      "  capability_gap: type, id, what, why, ts",
      "  scheduled_fired: type, id, prompt, target, cron, ts",
      "  Sensor types (sauna, etc.): type plus the sensor's own fields (e.g. temp, trend, source).",
      "",
      "EXAMPLES that actually work:",
      "  temp >= 30                                     // sensor threshold",
      "  from == \"Aaron\" && chat == \"dm\"               // exact-match person + channel",
      "  direction == \"in\" && chat == \"group\"          // group inbound",
      "  type == \"capability_gap\"                       // (redundant — `on.type` already filters)",
    ].join("\n"),
    label: "Register Watch",
    parameters: Type.Object({
      on: Type.Object({
        type: Type.String({ description: "Event type to listen for (e.g. chat_message, sauna, capability_gap, broadcast)." }),
        where: Type.Optional(Type.String({ description: "Filter expression — see tool description for grammar + supported fields. Validated at registration; bad expressions are rejected." })),
        trigger: Type.Optional(Type.Union([
          Type.Literal("always"),
          Type.Literal("crossing_up"),
          Type.Literal("crossing_down"),
        ], { description: "When to fire. 'crossing_up' = only on the transition into matching (default for thresholds). 'always' = every matching event." })),
      }),
      action: Type.Object({
        kind: Type.String({ description: "Action kind: 'dm', 'group', 'broadcast', or any custom action registered via workspace/extensions/actions.js" }),
      }, { additionalProperties: true, description: "Action params. For 'dm': {to, intent}. For 'group'/'broadcast': {intent}." }),
      once: Type.Optional(Type.Boolean({ description: "If true, watch self-deletes after firing once" })),
      description: Type.Optional(Type.String({ description: "Human-readable description for list_watches" })),
    }),
    execute: async (_id, params) => {
      // Validate the where-expression at registration time so the LLM
      // gets immediate feedback instead of registering a watch that
      // silently fails every cycle in the evaluator.
      if (params.on?.where) {
        try {
          const { compileCondition } = await import("../core/condition-eval.js");
          compileCondition(params.on.where);
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `Watch NOT registered — \`where\` expression failed to compile: ${(err as Error).message}\n\nGrammar reminder: == != < <= > >= && || only. No regex, no =~, no method calls. See the tool description for available fields per event type.`,
            }],
            details: { error: String(err) },
          };
        }
      }
      const { addWatch } = await import("../core/watches.js");
      const full = await addWatch({
        on: params.on,
        action: params.action,
        once: params.once ?? false,
        description: params.description,
        created_by: senderName,
      });
      return { content: [{ type: "text", text: `Registered watch ${full.id}` }], details: {} };
    },
  };
}

export function createListWatchesTool(): AgentTool {
  return {
    name: "list_watches",
    description: "List all registered watches with their filters and actions",
    label: "List Watches",
    parameters: Type.Object({}),
    execute: async () => {
      const { loadWatches } = await import("../core/watches.js");
      const watches = await loadWatches();
      if (watches.length === 0) {
        return { content: [{ type: "text", text: "No watches registered." }], details: {} };
      }
      const lines = watches.map((w) => {
        const triggerTxt = w.on.trigger ?? "always";
        const whereTxt = w.on.where ? ` where ${w.on.where}` : "";
        const onceTxt = w.once ? " (once)" : "";
        const desc = w.description ? `\n    ${w.description}` : "";
        return `• ${w.id}: on ${w.on.type}${whereTxt} [${triggerTxt}]${onceTxt} → ${w.action.kind}${desc}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };
}

export function createCancelWatchTool(): AgentTool {
  return {
    name: "cancel_watch",
    description: "Remove a registered watch by ID",
    label: "Cancel Watch",
    parameters: Type.Object({
      id: Type.String({ description: "Watch ID to remove" }),
    }),
    execute: async (_id, params) => {
      const { removeWatch } = await import("../core/watches.js");
      const removed = await removeWatch(params.id);
      return {
        content: [{ type: "text", text: removed ? `Removed watch ${params.id}` : `No watch with id ${params.id}` }],
        details: {},
      };
    },
  };
}

// --- Module Management (self-modification) ---

const MODULE_CREATION_LOG = "tasks/module-creation-log.json";

export function createCreateModuleTool(workspacePath: string): AgentTool {
  return {
    name: "create_module",
    description: "Create a new markdown-driven module that will start running automatically. Use for temporary watchers, recurring tasks, or new capabilities.",
    label: "Create Module",
    parameters: Type.Object({
      name: Type.String({ description: "Module name (becomes filename, no spaces)" }),
      interval: Type.String({ description: "How often to run: '5m', '30m', '1h', '6h', '12h'" }),
      tools: Type.Array(Type.String(), { description: "Tool whitelist for this module" }),
      prompt: Type.String({ description: "The module's instructions — what it should do each cycle" }),
      expires: Type.Optional(Type.String({ description: "When to auto-disable: ISO datetime or 'in 7d', 'next monday'" })),
      description: Type.Optional(Type.String({ description: "One-line description" })),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { parseTime } = await import("../core/time-parser.js");
      const { slugify } = await import("../core/slugify.js");

      const safeName = slugify(params.name);
      const modulePath = path.join(workspacePath, "modules", `${safeName}.md`);

      // Guard: check if module already exists
      try { await fs.access(modulePath); return { content: [{ type: "text", text: `Module "${safeName}" already exists. Use a different name.` }], details: {} }; } catch {}

      // Guard: total module count
      const files = await fs.readdir(path.join(workspacePath, "modules"));
      const mdFiles = files.filter((f: string) => f.endsWith(".md"));
      if (mdFiles.length >= moduleLimits.maxModules) {
        return { content: [{ type: "text", text: `Module limit reached (${moduleLimits.maxModules}). Disable or remove an existing module first.` }], details: {} };
      }

      // Guard: weekly creation rate limit
      const logPath = path.join(workspacePath, MODULE_CREATION_LOG);
      let creationLog: any[] = [];
      try { creationLog = JSON.parse(await fs.readFile(logPath, "utf-8")); } catch {}
      const oneWeekAgo = Date.now() - 7 * 86400000;
      const recentCreations = creationLog.filter((e: any) => e.time > oneWeekAgo);
      if (recentCreations.length >= moduleLimits.creationsPerWeek) {
        return { content: [{ type: "text", text: `Module creation rate limit: ${moduleLimits.creationsPerWeek} per week. Last created: ${new Date(recentCreations[0].time).toLocaleDateString()}` }], details: {} };
      }

      // Guard: minimum cycle interval
      const intervalMs = (() => {
        const m = params.interval.match(/^(\d+)\s*(m|h)$/);
        if (!m) return null;
        return m[2] === "h" ? parseInt(m[1]) * 3600_000 : parseInt(m[1]) * 60_000;
      })();
      if (intervalMs !== null && intervalMs < moduleLimits.minIntervalMs) {
        const minMin = Math.round(moduleLimits.minIntervalMs / 60_000);
        return { content: [{ type: "text", text: `Minimum interval is ${minMin}m for self-created modules.` }], details: {} };
      }

      // Build frontmatter
      let frontmatter = `---\nname: ${safeName}\ninterval: ${params.interval}\ntools: [${params.tools.join(", ")}]`;
      if (params.expires) {
        const expiresTime = await parseTime(params.expires);
        if (expiresTime) {
          frontmatter += `\nexpires: ${new Date(expiresTime).toISOString()}`;
        }
      }
      frontmatter += `\n---\n\n`;

      const content = frontmatter + (params.description ? `# ${params.name}\n\n${params.description}\n\n` : `# ${params.name}\n\n`) + params.prompt + "\n";
      await fs.writeFile(modulePath, content, "utf-8");

      // Log creation
      creationLog.push({ name: safeName, time: Date.now() });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, JSON.stringify(creationLog, null, 2), "utf-8");

      return { content: [{ type: "text", text: `Module "${safeName}" created. It will start running within 30 seconds.${params.expires ? ` Expires: ${params.expires}` : ""}` }], details: {} };
    },
  };
}

export function createDisableModuleTool(workspacePath: string): AgentTool {
  return {
    name: "disable_module",
    description: "Disable a module by moving it to the disabled directory. It stops running but is preserved.",
    label: "Disable Module",
    parameters: Type.Object({
      name: Type.String({ description: "Module name to disable" }),
    }),
    execute: async (_id, params) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { slugify } = await import("../core/slugify.js");

      const safeName = slugify(params.name);
      const srcPath = path.join(workspacePath, "modules", `${safeName}.md`);
      const dstPath = path.join(workspacePath, "modules", "disabled", `${safeName}.md`);

      try {
        await fs.access(srcPath);
      } catch {
        return { content: [{ type: "text", text: `Module "${safeName}" not found.` }], details: {} };
      }

      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await fs.rename(srcPath, dstPath);
      return { content: [{ type: "text", text: `Module "${safeName}" disabled.` }], details: {} };
    },
  };
}

export function createListModulesTool(workspacePath: string): AgentTool {
  return {
    name: "list_modules",
    description: "List all active and disabled modules",
    label: "List Modules",
    parameters: Type.Object({}),
    execute: async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      const active: string[] = [];
      const disabled: string[] = [];

      try {
        const files = await fs.readdir(path.join(workspacePath, "modules"));
        for (const f of files) {
          if (f.endsWith(".md")) active.push(f.replace(".md", ""));
        }
      } catch {}

      try {
        const files = await fs.readdir(path.join(workspacePath, "modules", "disabled"));
        for (const f of files) {
          if (f.endsWith(".md")) disabled.push(f.replace(".md", ""));
        }
      } catch {}

      const lines = [`Active (${active.length}): ${active.join(", ")}`, `Disabled (${disabled.length}): ${disabled.join(", ")}`];
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };
}
