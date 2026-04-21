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

async function getTopPlayed(count: number): Promise<string[]> {
  try {
    const csv = await readFile(PLAY_HISTORY_PATH, "utf-8");
    const lines = csv.split("\n").slice(1).filter(Boolean);

    const entries: Array<[string, number]> = [];
    for (const line of lines) {
      const match = line.match(/^"([^"]*(?:""[^"]*)*)",(\d+),/);
      if (match) {
        entries.push([match[1].replace(/""/g, '"'), parseInt(match[2])]);
      }
    }

    return entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([title, n]) => `${title} (${n}x)`);
  } catch {
    return [];
  }
}

export interface ModuleSpec {
  name: string;
  /** Raw markdown body (including any `## section` subsections). Used only as a fallback/legacy path. */
  prompt: string;
  /** Markdown body with `## section` subsections stripped. Rendered as Handlebars if it contains `{{...}}`. */
  template: string;
  /** Named sub-prompts extracted from `## section` H2 headings in the md body. Empty object if none. */
  sections: Record<string, string>;
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
    const now = new Date();

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

        // Track played songs — args come from the matching tool_execution_start
        if (event.toolName === "radio.play_music" && !event.isError) {
          const matchingCall = toolCalls.find(tc => tc.name === "radio.play_music");
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

    // Build seed prompt based on module type
    const seedTime = `${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} on ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`;
    const seedParts = [];

    if (spec.name === "radio") {
      seedParts.push(`THE CURRENT TIME IS ${seedTime}. Use this as your reference — any times in previous broadcasts or context are from earlier and may be stale. Calculate all "upcoming" and "past" relative to this time.`);
      // Include recent broadcast messages so the announcer knows what it already said
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
    } else if (spec.name === "radio-dj") {
      seedParts.push(`THE CURRENT TIME IS ${seedTime}.`);
      // Include music requests from community
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const radioLog = await fs.readFile(path.join(process.cwd(), "workspace", "radio", "log.md"), "utf-8");
        const requests: string[] = [];
        const sections = radioLog.split("\n## ");
        for (const section of sections.slice(-10)) {
          const timeMatch = section.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
          if (!timeMatch) continue;
          const chatMatch = section.match(/\*\*Via chat \(([^)]+)\):\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/);
          if (chatMatch && (chatMatch[2].includes("play_music") || chatMatch[2].includes("radio.search") || chatMatch[2].includes("play_request"))) {
            requests.push(`[${timeMatch[1]}] ${chatMatch[1]} requested: ${chatMatch[2].trim()}`);
          }
        }
        if (requests.length > 0) {
          seedParts.push(`<music-requests>\n${requests.slice(-3).join("\n")}\n</music-requests>`);
        }
      } catch {}

      // Show most played songs so DJ avoids repetition
      const topPlayed = await getTopPlayed(10);
      if (topPlayed.length > 0) {
        seedParts.push(`<most-played>\nThese songs have been played the most — avoid repeating them:\n${topPlayed.join("\n")}\n</most-played>`);
      }
    } else if (spec.name === "executive") {
      seedParts.push(`THE CURRENT TIME IS ${seedTime}.`);

      // Check if this is a scheduled action wake-up
      const scheduledActions: Array<{ prompt: string; context: string | null }> = [];
      const otherNudges: string[] = [];
      for (const nudge of nudges) {
        try {
          // Extract JSON from nudge (format: "[from schedule-checker] {json}")
          const jsonMatch = nudge.match(/\{.*\}/s);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.type === "scheduled_action") {
              scheduledActions.push({ prompt: parsed.prompt, context: parsed.context });
              continue;
            }
          }
        } catch {}
        otherNudges.push(nudge);
      }

      if (scheduledActions.length > 0) {
        // Scheduled action mode — focused execution, no deliberation
        const actions = scheduledActions.map((a, i) => {
          let desc = `Action ${i + 1}: ${a.prompt}`;
          if (a.context) desc += `\nContext: ${a.context}`;
          return desc;
        }).join("\n\n");
        seedParts.push(`<scheduled-actions>\nYou were woken up to follow through on something your past self scheduled for this moment. Use your tools to carry it out. Stay focused on what was scheduled — no need to run a full cycle or add extra actions.\n\n${actions}\n</scheduled-actions>`);

        // Still include other nudges if any
        if (otherNudges.length > 0) {
          // Replace nudges array so they don't get double-injected below
          nudges.length = 0;
          nudges.push(...otherNudges);
        } else {
          nudges.length = 0; // Clear so they don't get re-injected
        }
      } else {
        // Regular executive cycle — full deliberation

        // Inject upcoming scheduled items for awareness
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const schedulePath = path.join(process.cwd(), "workspace", "tasks", "scheduled.json");
          const schedule = JSON.parse(await fs.readFile(schedulePath, "utf-8"));
          const now = Date.now();

          const upcoming = schedule.filter((s: any) => !s.done && s.when > now && s.when < now + 24 * 3600000);

          if (upcoming.length > 0) {
            const items = upcoming.map((s: any) => {
              const when = new Date(s.when).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
              return `- [${when}] ${s.prompt}`;
            }).join("\n");
            seedParts.push(`<upcoming-scheduled>\nAlready scheduled for later — these will fire automatically, do NOT act on them now:\n${items}\n</upcoming-scheduled>`);
          }
        } catch {}

        // Include active threads for coordination awareness
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const threads = await fs.readFile(path.join(process.cwd(), "workspace", "inner", "active-threads.md"), "utf-8");
          if (threads.trim()) {
            seedParts.push(`<active-threads>\n${threads.trim()}\n</active-threads>`);
          }
        } catch {}

        // Show recent executive actions so it doesn't repeat itself
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const today = new Date().toISOString().slice(0, 10);
          const log = await fs.readFile(path.join(process.cwd(), "workspace", "memory", `${today}.md`), "utf-8");
          const execLines = log.split("\n").filter(l =>
            l.includes("[executive]") || l.includes("(via nudge-feyblet)") || l.includes("Feyblet** (dm to")
          ).slice(-10);
          if (execLines.length > 0) {
            seedParts.push(`<your-recent-actions>\nThings you already did today — do not repeat these:\n${execLines.join("\n")}\n</your-recent-actions>`);
          }
        } catch {}
      }
    } else {
      seedParts.push(`Time: ${seedTime}`);
      seedParts.push("Go.");
    }

    // Inject any MQTT nudges from other modules
    if (nudges.length > 0) {
      seedParts.push(`<module-nudges>\nMessages from other parts of you:\n${nudges.join("\n")}\n</module-nudges>`);
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

