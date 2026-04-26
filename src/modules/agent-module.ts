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
import { Agent } from "@mariozechner/pi-agent-core";
import { filterToolsByWhitelist } from "../mcp/bridge.js";
import { render } from "../core/prompt-template.js";
import { standardVars } from "../core/prompt-vars.js";
import { recordEvent } from "../core/event-log.js";
import { renderContextBlocks, type ContextDecl } from "../core/context-providers.js";

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
  return undefined;
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
  outputHandler: (ctx: ModuleContext, output: string, toolTrace: string[], toolCalls?: Array<{ name: string; args: any; result?: string }>) => Promise<void>;
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
    ctx.log(`Starting ${spec.name} cycle`);

    // Check for pending MQTT nudges from other modules
    const nudges: string[] = [];
    let nudgeMsg = await ctx.messages.receive(50);
    while (nudgeMsg) {
      nudges.push(`[from ${nudgeMsg.from}] ${nudgeMsg.content}`);
      ctx.log(`Nudge received from ${nudgeMsg.from}: ${nudgeMsg.content.slice(0, 100)}`);
      // Log to daily memory so nudges are searchable and visible to all modules
      await ctx.memory.appendLog(`*[Nudge ${nudgeMsg.from} → ${spec.name}]* ${nudgeMsg.content}`);
      recordEvent({ type: "nudge", from: nudgeMsg.from, to: spec.name, content: nudgeMsg.content });
      nudgeMsg = await ctx.messages.receive(50);
    }

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
    const allowedTools = filterToolsByWhitelist(ctx.tools, spec.toolNames);

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
      const actions = scheduledActions.map((a, i) => {
        let desc = `Action ${i + 1}: ${a.prompt}`;
        if (a.context) desc += `\nContext: ${a.context}`;
        return desc;
      }).join("\n\n");
      seedParts.push(`<scheduled-actions>\nYou were woken up to follow through on something your past self scheduled for this moment. Use your tools to carry it out. Stay focused on what was scheduled — no need to run a full cycle or add extra actions.\n\n${actions}\n</scheduled-actions>`);
    } else if (spec.contextDecl && spec.contextDecl.length > 0) {
      const blocks = await renderContextBlocks(spec.contextDecl, ctx);
      seedParts.push(...blocks);
    }

    if (otherNudges.length > 0) {
      seedParts.push(`<module-nudges>\nMessages from other parts of you:\n${otherNudges.join("\n")}\n</module-nudges>`);
    }

    const promptText = seedParts.join("\n\n") || "Begin.";
    ctx.log(`Seed prompt (${promptText.length} chars, ${allowedTools.length} tools)`);
    ctx.logDebug(`Seed prompt body:\n${promptText}`);
    try {
      await agent.prompt(promptText);
      await agent.waitForIdle();
    } catch (err) {
      ctx.log(`Error in ${spec.name}: ${err}`);
      return;
    }

    checkError();
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

