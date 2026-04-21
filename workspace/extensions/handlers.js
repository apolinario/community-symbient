/**
 * Feÿ Deployment — module output handlers.
 *
 * Each function is called after its matching agent module completes a cycle.
 * Keyed by module name (must match `workspace/modules/<name>.md`).
 *
 * These are deployment-specific cognitive patterns — not framework code.
 * Another symbient might not have thinking/desire/magi at all, or have
 * completely different output logic.
 *
 * Framework guarantees: each handler receives
 *   - ctx: full ModuleContext (memory, messages, log, llm, tools, ...)
 *   - output: the final text the agent produced
 *   - toolTrace: array of "toolName(args)" strings
 *   - toolCalls: array of { name, args } for the full tool calls
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  thinking: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[Feyblet thinking]*\n${output}`);
      await ctx.messages.send("conversation", "inner_state_updated");
    }
  },

  desire: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[Feyblet desire]* ${output}`);
      await ctx.messages.send("conversation", `desire:${output}`);
    } else {
      ctx.log("No current desires.");
    }
  },

  magi: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[Feyblet magi]*\n${output}`);
    }
  },

  autobiographical: async (ctx, output, _trace, toolCalls) => {
    const wroteMemory = toolCalls?.some((tc) => tc.name === "write" || tc.name === "edit");
    if (wroteMemory) {
      await ctx.memory.appendLog("*[Autobiographical memory updated]*");
      ctx.log("MEMORY.md updated via agent tools.");
    } else if (output?.trim()) {
      await ctx.memory.appendLog("*[Autobiographical reflection]*");
      ctx.log(`Autobiographical: no file write`);
    }
  },

  "prompt-modifier": async (ctx, output, _trace) => {
    if (output.includes("NO_CHANGES") || output.trim() === "NO_CHANGES") {
      ctx.log("No changes to SOUL.md needed.");
      return;
    }
    await ctx.memory.writeFile("SOUL.md", output);
    await ctx.memory.appendFile(
      "inner/prompt-changes.md",
      `\n## ${new Date().toISOString()}\n\nSOUL.md modified by prompt-modifier.\n`,
    );
    await ctx.memory.appendLog("*[SOUL.md modified by prompt-modifier]*");
    ctx.log("SOUL.md updated.");
  },

  "radio-dj": async (ctx, _output, toolTrace) => {
    if (toolTrace.length > 0) {
      ctx.log(`DJ: ${toolTrace.join(" → ")}`);
    }
  },

  radio: async (_ctx, output, _trace, toolCalls) => {
    const logPath = join(process.cwd(), "workspace", "radio", "log.md");
    const timestamp = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const dateStr = new Date().toISOString().slice(0, 10);

    const broadcastMessages = [];
    if (toolCalls) {
      for (const call of toolCalls) {
        if (call.name === "radio_broadcast" && call.args?.message) {
          broadcastMessages.push(call.args.message);
        }
      }
    }

    const lines = [`## ${dateStr} ${timestamp}`];
    if (broadcastMessages.length > 0) {
      for (const msg of broadcastMessages) {
        lines.push(``, `**Broadcast:** ${msg}`);
      }
    }
    if (output?.trim()) {
      lines.push(``, `**Notes:** ${output.trim()}`);
    }

    await appendFile(logPath, `\n${lines.join("\n")}\n`, "utf-8");
  },
};
