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

export interface ModuleSpec {
  name: string;
  prompt: string;
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

    // Build system prompt: date + SOUL/MEMORY context + module-specific goal
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const systemPrompt = `**It is ${dateStr}, ${timeStr}.** Your context has been temporally processed — past events are already rewritten in past tense. <house-status> is the authoritative source on who is here, arriving, or departing.\n\n${memoryContext}\n\n${spec.prompt}`;

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

    // Build seed prompt based on module type
    const seedTime = `${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} on ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`;
    const seedParts = [];

    if (spec.name === "radio" || spec.name === "radio-dj") {
      seedParts.push(`THE CURRENT TIME IS ${seedTime}. Use this as your reference — any times in previous broadcasts or context are from earlier and may be stale. Calculate all "upcoming" and "past" relative to this time.`);
      // Include recent broadcast messages so the agent knows what it already said
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const radioLog = await fs.readFile(path.join(process.cwd(), "workspace", "radio", "log.md"), "utf-8");
        const broadcasts: string[] = [];
        const requests: string[] = [];
        const sections = radioLog.split("\n## ");
        for (const section of sections.slice(-10)) {
          const timeMatch = section.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
          if (!timeMatch) continue;
          const broadcastMatch = section.match(/\*\*Broadcast:\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/);
          if (broadcastMatch) {
            broadcasts.push(`[${timeMatch[1]}] ${broadcastMatch[1].trim()}`);
          }
          const chatMatch = section.match(/\*\*Via chat \(([^)]+)\):\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/);
          if (chatMatch) {
            requests.push(`[${timeMatch[1]}] ${chatMatch[1]} requested: ${chatMatch[2].trim()}`);
          }
        }
        if (broadcasts.length > 0) {
          seedParts.push(`<recent-broadcasts context="same topics are ok, but increase variety, find different angles, talk about other/more stuff in your context or that you can find with tool calls">\n${broadcasts.slice(-2).join("\n")}\n</recent-broadcasts>`);
        }
        if (requests.length > 0) {
          seedParts.push(`<community-requests>\n${requests.slice(-3).join("\n")}\n</community-requests>`);
        }
      } catch {}
      seedParts.push("Run your radio cycle now. Check the overview, then broadcast using the radio_broadcast tool if you have something to say. Don't just think about it — call the tool.");
    } else {
      seedParts.push(`Time: ${seedTime}`);
      seedParts.push("Go.");
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
  };
}

// --- Standard output handlers ---

export const thinkingHandler = async (ctx: ModuleContext, output: string, _trace: string[]) => {
  await ctx.memory.appendLog(`*[Feyblet thinking]*\n${output}`);
  await ctx.memory.writeFile("inner/current-state.md", output);
  await ctx.messages.send("conversation", "inner_state_updated");
  ctx.log(`Thought: ${output.slice(0, 100)}...`);
};

export const desireHandler = async (ctx: ModuleContext, output: string, _trace: string[]) => {
  if (output.toLowerCase() === "none") {
    ctx.log("No current desires.");
    return;
  }
  await ctx.memory.appendLog(`*[Feyblet desire]* ${output}`);
  await ctx.memory.writeFile("inner/current-desire.md", output);
  await ctx.messages.send("conversation", `desire:${output}`);
  ctx.log(`Desire: ${output.slice(0, 100)}...`);
};

export const magiHandler = async (ctx: ModuleContext, output: string, _trace: string[]) => {
  await ctx.memory.appendLog(`*[Feyblet magi]*\n${output}`);
  await ctx.memory.writeFile("inner/current-magi.md", output.trim());
  ctx.log(`Magi dialogue completed`);
};

export const autobiographicalHandler = async (ctx: ModuleContext, output: string, _trace: string[]) => {
  await ctx.memory.writeFile("MEMORY.md", output);
  await ctx.memory.appendLog("*[Autobiographical memory updated]*");
  ctx.log("MEMORY.md updated.");
};

export const promptModifierHandler = async (ctx: ModuleContext, output: string, _trace: string[]) => {
  if (output.includes("NO_CHANGES") || output.trim() === "NO_CHANGES") {
    ctx.log("No changes to SOUL.md needed.");
    return;
  }
  await ctx.memory.writeFile("SOUL.md", output);
  await ctx.memory.appendFile("inner/prompt-changes.md",
    `\n## ${new Date().toISOString()}\n\nSOUL.md modified by prompt-modifier.\n`);
  await ctx.memory.appendLog("*[SOUL.md modified by prompt-modifier]*");
  ctx.log("SOUL.md updated.");
};
