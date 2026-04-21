/**
 * Generic Agent Module — creates a Pi Agent from a markdown config file.
 *
 * Each module in workspace/modules/*.md defines:
 * - name, interval, tool whitelist (in YAML frontmatter)
 * - Goal/prompt (in markdown body)
 *
 * The agent gets SOUL.md + MEMORY.md + the module's own prompt,
 * plus a filtered set of tools based on the whitelist.
 *
 * This replaces separate TypeScript files for thinking, desire, magi, etc.
 * Module behavior is now editable by changing markdown files.
 */

import type { ModuleContext } from "../core/types.js";
import { Agent } from "@mariozechner/pi-agent-core";
import { completeText } from "../core/llm.js";
import { isMCPServer } from "../mcp/bridge.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { render } from "../core/prompt-template.js";
import { standardVars } from "../core/prompt-vars.js";
import { recordEvent } from "../core/event-log.js";
import { renderContextBlocks, type ContextDecl } from "../core/context-providers.js";

const PLAY_HISTORY_PATH = join(process.cwd(), "workspace", "radio", "play-history.csv");

async function trackPlay(args: any, result: string): Promise<void> {
  // Skip if result is an error
  if (result.includes("MCP error") || result.includes("Error")) return;

  const url = args?.url || "";
  // Try to extract title from the result (now_playing or title field)
  const titleMatch = result.match(/"(?:now_playing|title)":\s*"([^"]+)"/);
  const title = titleMatch?.[1] || url || "";

  // Skip if we have no meaningful data
  if (!title && !url) return;

  await mkdir(dirname(PLAY_HISTORY_PATH), { recursive: true });

  // Read existing CSV, find existing row for this title, increment count
  let csv = "";
  try { csv = await readFile(PLAY_HISTORY_PATH, "utf-8"); } catch {}
  if (!csv) csv = "title,count,last_played\n";

  const lines = csv.split("\n");
  const header = lines[0];
  const rows = lines.slice(1).filter(Boolean);

  const safeTitle = title.replace(/"/g, '""');
  const now = new Date().toISOString();
  let found = false;

  const updated = rows.map((row) => {
    const match = row.match(/^"([^"]*(?:""[^"]*)*)",(\d+),/);
    if (match && match[1] === safeTitle) {
      found = true;
      return `"${safeTitle}",${parseInt(match[2]) + 1},"${now}"`;
    }
    return row;
  });

  if (!found) {
    updated.push(`"${safeTitle}",1,"${now}"`);
  }

  await writeFile(PLAY_HISTORY_PATH, header + "\n" + updated.join("\n") + "\n", "utf-8");
}

export interface ModuleSpec {
  name: string;
  /** Raw markdown body (including any `## section` subsections). Used only as a fallback/legacy path. */
  prompt: string;
  /** Markdown body with `## section` subsections stripped. Rendered as Handlebars if it contains `{{...}}`. */
  template: string;
  /** Named sub-prompts extracted from `## section` H2 headings in the md body. Empty object if none. */
  sections: Record<string, string>;
  /** Declarative context blocks from the md's `context:` frontmatter — rendered into the seed user-prompt. */
  contextDecl?: ContextDecl[];
  toolNames: string[];
  outputHandler: (ctx: ModuleContext, output: string, toolTrace: string[], toolCalls?: Array<{ name: string; args: any }>) => Promise<void>;
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
      ctx.log(`Context (${memoryContext.length} chars):\n${memoryContext}`);
    } catch (err) {
      ctx.log(`Context assembly failed: ${err}`);
      return;
    }

    // Filter tools to only what this module is allowed
    // Supports: "radio" → all tools from that MCP server (radio.*)
    //           "radio.get_status" → specific MCP tool
    //           "search_memory" → exact match (local tool)
    const allowedTools = ctx.tools.filter((t: any) => {
      for (const entry of spec.toolNames) {
        if (entry === t.name) return true;
        if (isMCPServer(entry) && t.name.startsWith(`${entry}.`)) return true;
      }
      return false;
    });

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
    const toolCalls: Array<{ name: string; args: any }> = [];
    let lastToolCall = "";
    let repeatCount = 0;
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_start") {
        toolTrace.push(`${event.toolName}(${JSON.stringify(event.args).slice(0, 100)})`);
        toolCalls.push({ name: event.toolName, args: event.args });
        ctx.log(`Tool: ${event.toolName}(${JSON.stringify(event.args)})`);

        // Detect loops: same tool+args called repeatedly
        const callSig = `${event.toolName}:${JSON.stringify(event.args)}`;
        if (callSig === lastToolCall) {
          repeatCount++;
          if (repeatCount >= 2) {
            ctx.log(`Loop detected: ${event.toolName} called ${repeatCount + 1} times with same args, aborting`);
            agent.abort();
          }
        } else {
          lastToolCall = callSig;
          repeatCount = 0;
        }
      }
      if (event.type === "tool_execution_end") {
        const resultText = event.result?.content?.map((c: any) => c.text || "").join("") || JSON.stringify(event.result);
        ctx.log(`Result: ${event.toolName} → ${resultText}`);

        // Record tool_call event for queryability. The matching tool_execution_start
        // pushed the {name, args} onto toolCalls — find it so we have the args handy.
        const matchingCall = toolCalls.find(tc => tc.name === event.toolName);
        recordEvent({
          type: "tool_call",
          module: spec.name,
          tool: event.toolName,
          args: matchingCall?.args,
          ok: !event.isError,
          result: resultText.slice(0, 500),
        });

        // Track played songs — args come from the matching tool_execution_start
        if (event.toolName === "radio.play_music" && !event.isError) {
          trackPlay(matchingCall?.args, resultText).catch(() => {});
        }
      }
      if (event.type === "agent_end") {
        ctx.log(`Agent ended, messages: ${event.messages.length}`);
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
    //      module's declared context providers. This implements the executive's
    //      two-mode behavior generically (any module can opt in just by reading
    //      those nudges).
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
    ctx.log(`Seed prompt (${promptText.length} chars, ${allowedTools.length} tools):\n${promptText}`);
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

