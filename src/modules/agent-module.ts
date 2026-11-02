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

import type { ModuleContext, StreamPrivacy } from "../core/types.js";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { filterToolsByWhitelist } from "../mcp/bridge.js";
import { render } from "../core/prompt-template.js";
import { standardVars } from "../core/prompt-vars.js";
import { prompt } from "../core/prompts.js";
import { recordEvent } from "../core/event-log.js";
import { renderContextBlocks, type ContextDecl } from "../core/context-providers.js";
import { appendStream, inCategories } from "../core/stream.js";
import { scopeToolsForPublic } from "../core/privacy.js";

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
  outputHandler: (ctx: ModuleContext, output: string, toolTrace: string[], toolCalls?: Array<{ name: string; args: any; result?: string }>) => Promise<void>;
}

const stringList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);

/** Spec fields read from a module's frontmatter. */
export function specFields(fields: Record<string, unknown>): Pick<ModuleSpec, "wake" | "requires" | "writes"> {
  return {
    wake: fields.wake === "nudge" ? "nudge" : "interval",
    requires: stringList(fields.requires),
    writes: stringList(fields.writes),
  };
}

/** A module's `privacy` from frontmatter; anything unrecognised is public. */
export function privacyOf(fields: Record<string, unknown>): StreamPrivacy {
  return fields.privacy === "private" || fields.privacy === "distill" ? fields.privacy : "public";
}

/** `note`: the module's way to say something into the stream, limited to its `writes`. */
function createNoteTool(author: string, writes: string[], isPrivate: boolean, onNote: () => void): AgentTool {
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
      await appendStream({ category: p.category, author, text: p.text, private: isPrivate });
      onNote();
      return { content: [{ type: "text", text: "Noted." }], details: {} };
    },
  };
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
    // Public modules get only the soul: the assembled context carries MEMORY.md and retrieval over private files.
    const clearedForMemory = ctx.config.privacy === "private" || ctx.config.privacy === "distill";
    let memoryContext: string;
    try {
      memoryContext = clearedForMemory
        ? await ctx.memory.assembleConversationContext(spec.prompt)
        : `<soul>\n${(await ctx.memory.readSoul()) ?? ""}\n</soul>`;
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
    let noted = false;
    const writesPrivate = ctx.config.privacy === "private";
    const allowedTools = clearedForMemory
      ? filterToolsByWhitelist(ctx.tools, spec.toolNames)
      : scopeToolsForPublic(filterToolsByWhitelist(ctx.tools, spec.toolNames), ctx.memory.workspacePath);
    if (spec.writes?.length) allowedTools.push(createNoteTool(spec.name, spec.writes, writesPrivate, () => { noted = true; }));

    // Build system prompt: render the module's Handlebars template with standard vars.
    // The md file is responsible for whatever preamble, memory context, and instructions
    // the module needs. Core provides the values (currentDateTime, memoryContext, etc.)
    // via the helper registry in src/core/prompt-vars.ts.
    const vars = await standardVars(ctx, { sections: spec.sections, memoryContext });
    const systemPrompt = render(spec.template, vars);

    // Create Pi Agent
    const agent = new Agent({
      initialState: { model: ctx.model, systemPrompt },
      getApiKey: () => ctx.apiKey,
    });
    if (allowedTools.length > 0) {
      agent.setTools(allowedTools);
    }

    // Collect output + tool trace for logging
    let output = "";
    let agentError = "";
    const toolTrace: string[] = [];
    const toolCalls: Array<{ name: string; args: unknown; result?: string }> = [];
    const detectLoop = createLoopDetector(() => agent.abort(), ctx.log);

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
          ctx.log(`Result: ${event.toolName} → ${resultText}`);
          const matchingCall = correlateToolResult(toolCalls, event.toolName, resultText);
          recordEvent({
            type: "tool_call",
            module: spec.name,
            tool: event.toolName,
            args: matchingCall?.args,
            ok: !event.isError,
            result: resultText.slice(0, 500),
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
      if (agent.state.error) {
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
    try {
      await agent.prompt(promptText);
      await agent.waitForIdle();
    } catch (err) {
      ctx.log(`Error in ${spec.name}: ${err}`);
      recordEvent({ type: "module_run", module: spec.name, ms: Date.now() - startedAt, tools: toolCalls.length, error: String(err).slice(0, 300) });
      return;
    }

    checkError();
    if (spec.writes?.length === 1 && !noted && output.trim()) {
      await appendStream({ category: spec.writes[0], author: spec.name, text: output.trim(), private: writesPrivate });
    }
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

