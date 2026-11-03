/**
 * Generic Agent Module — creates a Pi Agent from a markdown config file.
 *
 * Each module in workspace/modules/*.md defines:
 * - frontmatter: name, interval, tool whitelist, optional `context:` providers
 * - body: a Handlebars template rendered as the system prompt
 * - optional `## section` H2 headings: named sub-prompts available to the
 *   handler and to the template's conditionals
 *
 * The agent receives the rendered system prompt plus a filtered set of
 * tools (whitelist match against this module's `tools:` field). Output
 * goes to the registered handler for this module name (default: append
 * to today's daily log).
 */

import type { ModuleContext } from "../core/types.js";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { filterToolsByWhitelist, loggableResult } from "../mcp/bridge.js";
import { render } from "../core/prompt-template.js";
import { standardVars } from "../core/prompt-vars.js";
import { prompt, withToolGuides } from "../core/prompts.js";
import { recordEvent } from "../core/event-log.js";
import { renderContextBlocks, type ContextDecl } from "../core/context-providers.js";
import { appendStream, inCategories, readStream } from "../core/stream.js";
import { decide, probabilityOf } from "../core/decide.js";

// --- Subscription-callback helpers ---

interface ToolCall {
  name: string;
  args: unknown;
  result?: string;
}

/**
 * Detect repeated identical tool calls within one cycle and abort the
 * agent when the same {tool, args} fires three times in a row. The
 * counter resets whenever the call signature changes.
 */
function createLoopDetector(abort: () => void, log: (msg: string) => void) {
  let lastSig = "";
  let repeats = 0;
  return (toolName: string, args: unknown) => {
    const sig = `${toolName}:${JSON.stringify(args)}`;
    if (sig === lastSig) {
      repeats++;
      if (repeats >= 2) {
        log(`Loop detected: ${toolName} called ${repeats + 1} times with same args, aborting`);
        abort();
      }
    } else {
      lastSig = sig;
      repeats = 0;
    }
  };
}

/**
 * Pull text out of a Pi tool-execution-end event.result.content array.
 * Falls back to JSON.stringify when the shape is unfamiliar.
 */
function extractResultText(result: { content?: Array<{ text?: string }> } | undefined): string {
  return result?.content?.map((c) => c.text || "").join("") || JSON.stringify(result);
}

/**
 * Attach a tool result to the most recent in-cycle call of that name that
 * doesn't have one yet. Returns the matched call (or undefined). This lets
 * handlers correlate args↔result even when a tool fires multiple times
 * within the same cycle.
 */
function correlateToolResult(toolCalls: ToolCall[], toolName: string, resultText: string): ToolCall | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i].name === toolName && toolCalls[i].result === undefined) {
      toolCalls[i].result = resultText;
      return toolCalls[i];
    }
  }
  return;
}

export interface ModuleSpec {
  name: string;
  /** Raw markdown body, used as the relevance query to qmd when assembling
   *  per-cycle context (so search picks up memories related to whatever
   *  the module is about). The Handlebars-rendered version is `template`. */
  prompt: string;
  /** Markdown body with `## section` subsections stripped. Rendered as Handlebars if it contains `{{...}}`. */
  template: string;
  /** Named sub-prompts extracted from `## section` H2 headings in the md body. Empty object if none. */
  sections: Record<string, string>;
  /** Declarative context blocks from the md's `context:` frontmatter — rendered into the seed user-prompt. */
  contextDecl?: ContextDecl[];
  toolNames: string[];
  /** `nudge`: a cycle runs only when a nudge is waiting; the interval is just how often the mailbox is checked. */
  wake?: "interval" | "nudge";
  /** Context sources that must be non-empty for a cycle to run. */
  requires?: string[];
  /** Stream categories this module may write (what it hears is a `stream` context provider; docs/stream.md). */
  writes?: string[];
  /** A decision (src/decisions/, workspace/decisions/) asked before each run; below `gateThreshold` (default 0.5) the run is skipped. */
  gate?: string;
  gateThreshold?: number;
  /** Tools that can act once per cycle; a call that comes back as an error doesn't count. */
  once?: string[];
  outputHandler: (ctx: ModuleContext, output: string, toolTrace: string[], toolCalls?: Array<{ name: string; args: any; result?: string }>) => Promise<void>;
}

const stringList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);

/** Spec fields read from a module's frontmatter. */
export function specFields(fields: Record<string, unknown>): Pick<ModuleSpec, "wake" | "requires" | "writes" | "gate" | "gateThreshold" | "once"> {
  return {
    wake: fields.wake === "nudge" ? "nudge" : "interval",
    requires: stringList(fields.requires),
    writes: stringList(fields.writes),
    gate: typeof fields.gate === "string" ? fields.gate : undefined,
    gateThreshold: typeof fields.gateThreshold === "number" ? fields.gateThreshold : undefined,
    once: stringList(fields.once),
  };
}

/** When a module's recent entries go in circles, say so in the stream, where the meta parts of the symbient hear it. */
async function noticeRepetition(author: string, writes: string[], log: (msg: string) => void): Promise<void> {
  const recent = (await readStream({ categories: writes, limit: 60 })).filter((e) => e.author === author).slice(-6);
  if (recent.length < 4) return;
  const p = probabilityOf(await decide("repetition", { module: author, "its last entries": recent.map((e) => e.text.slice(0, 400)) }));
  if (p === null || p < 0.7) return;
  log(`${author} is repeating itself (${p.toFixed(2)})`);
  recordEvent({ type: "module_repeating", module: author, p });
  await appendStream({ category: "meta.report", author: "body", text: `${author} has been repeating itself in its last ${recent.length} entries.` });
}

/** `note`: the module's way to say something into the stream, limited to its `writes`. */
// A module says a little each cycle; past this the run is stopped (a model that can't end keeps noting).
const NOTES_PER_CYCLE = 2;

function createNoteTool(author: string, writes: string[], onLimit: () => void): AgentTool {
  let notes = 0;
  return {
    name: "note",
    label: "Note",
    description: `Write a short entry into your stream, where the rest of you will hear it. Categories you can write: ${writes.join(", ")}.`,
    parameters: Type.Object({
      category: Type.String({ description: `One of: ${writes.join(", ")} (or a sub-category of one)` }),
      text: Type.String({ description: "The entry, in a sentence or a few" }),
    }),
    execute: async (_id, params) => {
      const p = params as { category: string; text: string };
      if (!inCategories(p.category, writes)) {
        return { content: [{ type: "text", text: `You can write ${writes.join(", ")}, not ${p.category}.` }], details: {}, isError: true };
      }
      if (notes >= NOTES_PER_CYCLE) {
        onLimit();
        return { content: [{ type: "text", text: "That's enough for this cycle." }], details: {}, isError: true };
      }
      notes++;
      await appendStream({ category: p.category, author, text: p.text });
      return { content: [{ type: "text", text: notes >= NOTES_PER_CYCLE ? "Noted. That's all for this cycle." : "Noted." }], details: {} };
    },
  };
}

function oncePerCycle(tool: AgentTool): AgentTool {
  let done = false;
  return {
    ...tool,
    execute: async (...args: Parameters<AgentTool["execute"]>) => {
      if (done) return { content: [{ type: "text", text: `${tool.name} has already happened this cycle.` }], details: {}, isError: true };
      const result = await tool.execute(...args);
      if (!(result as { isError?: boolean }).isError) done = true;
      return result;
    },
  } as AgentTool;
}

/**
 * Create a module function from a spec. The returned function:
 * 1. Assembles context (SOUL + MEMORY + summaries + house status)
 * 2. Creates a Pi Agent with filtered tools
 * 3. Runs the agent with the module's prompt
 * 4. Passes the output to the handler
 */
export function createAgentModule(spec: ModuleSpec) {
  return async function agentModule(ctx: ModuleContext): Promise<void> {
    const startedAt = Date.now();

    // Check for pending MQTT nudges from other modules
    const nudges: string[] = [];
    let nudgeMsg = await ctx.messages.receive(50);
    if (spec.wake === "nudge" && !nudgeMsg) return;
    while (nudgeMsg) {
      nudges.push(`[from ${nudgeMsg.from}] ${nudgeMsg.content}`);
      ctx.log(`Nudge received from ${nudgeMsg.from}: ${nudgeMsg.content.slice(0, 100)}`);
      // Log to daily memory so nudges are searchable and visible to all modules
      await ctx.memory.appendLog(`*[Nudge ${nudgeMsg.from} → ${spec.name}]* ${nudgeMsg.content}`);
      recordEvent({ type: "nudge", from: nudgeMsg.from, to: spec.name, content: nudgeMsg.content });
      nudgeMsg = await ctx.messages.receive(50);
    }

    if (spec.requires?.length) {
      const decls = spec.requires.map((source) => spec.contextDecl?.find((d) => d.source === source) ?? { source });
      if ((await renderContextBlocks(decls, ctx)).length < decls.length) {
        ctx.log(`${spec.name}: skipped, nothing in ${spec.requires.join(", ")}`);
        return;
      }
    }
    ctx.log(`Starting ${spec.name} cycle`);

    // Assemble context — use conversation context (which filters inner monologue)
    // so inner modules don't feed on each other's outputs
    let memoryContext: string;
    try {
      memoryContext = await ctx.memory.assembleConversationContext(spec.prompt);
      ctx.log(`Context assembled (${memoryContext.length} chars)`);
      ctx.logDebug(`Context body:\n${memoryContext}`);
    } catch (err) {
      ctx.log(`Context assembly failed: ${err}`);
      return;
    }

    // Filter tools to the module's whitelist. Whitelist entries are
    // either exact tool names ("search") or MCP server names ("radio"
    // matches radio.*). An empty whitelist disables every tool — modules
    // that want all tools simply omit the filter, but here we honour
    // spec.toolNames literally.
    const allowedTools = filterToolsByWhitelist(ctx.tools, spec.toolNames).map((t) => (spec.once?.includes(t.name) ? oncePerCycle(t) : t));
    // Stops we cause ourselves end the run on purpose; they aren't errors.
    let stoppedBy = "";
    const stop = (reason: string) => { stoppedBy = reason; agent.abort(); };
    if (spec.writes?.length) allowedTools.push(createNoteTool(spec.name, spec.writes, () => stop("note limit")));

    // Build system prompt: render the module's Handlebars template with standard vars.
    // The md file is responsible for whatever preamble, memory context, and instructions
    // the module needs. Core provides the values (currentDateTime, memoryContext, etc.)
    // via the helper registry in src/core/prompt-vars.ts.
    const vars = await standardVars(ctx, { sections: spec.sections, memoryContext });
    const systemPrompt = withToolGuides(render(spec.template, vars), allowedTools.map((t) => t.name), vars);

    // Create Pi Agent
    const agent = new Agent({
      initialState: { model: ctx.model, systemPrompt },
      getApiKey: () => ctx.apiKey,
      onPayload: ctx.onPayload,
    });
    if (allowedTools.length > 0) {
      agent.setTools(allowedTools);
    }

    // Collect output + tool trace for logging
    let output = "";
    let agentError = "";
    const toolTrace: string[] = [];
    const toolCalls: Array<{ name: string; args: unknown; result?: string }> = [];
    const detectLoop = createLoopDetector(() => stop("loop detected"), ctx.log);

    agent.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            output += event.assistantMessageEvent.delta;
          }
          return;

        case "tool_execution_start":
          toolTrace.push(`${event.toolName}(${JSON.stringify(event.args).slice(0, 100)})`);
          toolCalls.push({ name: event.toolName, args: event.args });
          ctx.log(`Tool: ${event.toolName}(${JSON.stringify(event.args)})`);
          detectLoop(event.toolName, event.args);
          return;

        case "tool_execution_end": {
          const resultText = extractResultText(event.result);
          const shown = loggableResult(event.toolName, resultText);
          ctx.log(`Result: ${event.toolName} → ${shown}`);
          const matchingCall = correlateToolResult(toolCalls, event.toolName, resultText);
          recordEvent({
            type: "tool_call",
            module: spec.name,
            tool: event.toolName,
            args: matchingCall?.args,
            ok: !event.isError,
            result: shown.slice(0, 500),
          });
          return;
        }

        case "agent_end":
          ctx.log(`Agent ended, messages: ${event.messages.length}`);
          return;
      }
    });

    // Check state for errors after each cycle
    const checkError = () => {
      if (stoppedBy === "note limit") {
        ctx.log(`${spec.name} stopped at the note limit`);
      } else if (stoppedBy) {
        agentError = stoppedBy;
      } else if (agent.state.error) {
        ctx.log(`Agent state error: ${agent.state.error}`);
        agentError = agent.state.error;
      }
    };

    // Build seed prompt.
    //
    // Two preprocessor steps then a generic provider loop:
    //   1. Scheduled-action mode: if any nudge carries `type: "scheduled_action"`,
    //      enter focused mode — inject a scheduled-actions block and skip the
    //      module's declared context providers. Any module that's set as a
    //      schedule target (via the `schedule` tool's `target` param or
    //      `scheduling.defaultTarget` in config) opts in by reading those nudges.
    //   2. Generic context providers: render each entry in `spec.contextDecl`.
    //   3. Remaining nudges (non-scheduled) get injected as a <module-nudges> block.
    const seedParts: string[] = [];

    const scheduledActions: Array<{ prompt: string; context: string | null }> = [];
    const otherNudges: string[] = [];
    for (const nudge of nudges) {
      const m = nudge.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (parsed.type === "scheduled_action") {
            scheduledActions.push({ prompt: parsed.prompt, context: parsed.context ?? null });
            continue;
          }
        } catch {}
      }
      otherNudges.push(nudge);
    }

    if (scheduledActions.length > 0) {
      seedParts.push(prompt("scheduled-actions", { actions: scheduledActions.map((a, i) => ({ ...a, n: i + 1 })) }));
    } else if (spec.contextDecl && spec.contextDecl.length > 0) {
      const blocks = await renderContextBlocks(spec.contextDecl, ctx);
      seedParts.push(...blocks);
    }

    if (otherNudges.length > 0) {
      seedParts.push(prompt("module-nudges", { nudges: otherNudges }));
    }

    const promptText = seedParts.join("\n\n") || prompt("begin");
    ctx.log(`Seed prompt (${promptText.length} chars, ${allowedTools.length} tools)`);
    ctx.logDebug(`Seed prompt body:\n${promptText}`);

    // Sense-making before the run: a gated module asks the decision model, with the context the LLM would get,
    // whether there is anything worth acting on. Ungated modules, or an unanswered gate, run as usual.
    if (spec.gate) {
      const p = probabilityOf(await decide(spec.gate, { module: spec.name, "system prompt": systemPrompt, context: promptText }));
      recordEvent({ type: "module_gate", module: spec.name, gate: spec.gate, p });
      if (p !== null && p < (spec.gateThreshold ?? 0.5)) {
        ctx.log(`${spec.name}: nothing to act on (gate ${spec.gate} ${p.toFixed(2)}), skipping`);
        return;
      }
    }

    try {
      await agent.prompt(promptText);
      await agent.waitForIdle();
    } catch (err) {
      ctx.log(`Error in ${spec.name}: ${err}`);
      recordEvent({ type: "module_run", module: spec.name, ms: Date.now() - startedAt, tools: toolCalls.length, error: String(err).slice(0, 300) });
      return;
    }

    checkError();
    const noted = toolCalls.some((tc) => tc.name === "note");
    if (spec.writes?.length === 1 && !noted && output.trim()) {
      await appendStream({ category: spec.writes[0], author: spec.name, text: output.trim() });
    }
    if (spec.writes?.length) await noticeRepetition(spec.name, spec.writes, ctx.log);
    recordEvent({ type: "module_run", module: spec.name, ms: Date.now() - startedAt, tools: toolCalls.length, error: agentError ? String(agentError).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300) : null });
    ctx.log(`${spec.name} completed (${output.length} chars output, ${allowedTools.length} tools, error: ${agentError || 'none'})`);
    if (output.trim()) {
      ctx.log(`${spec.name} output: ${output.trim()}`);
    }

    await spec.outputHandler(ctx, output.trim(), toolTrace, toolCalls);

    if (output.trim()) {
      recordEvent({ type: "module_output", module: spec.name, text: output.trim() });
    }
  };
}

