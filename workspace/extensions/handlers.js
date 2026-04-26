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

import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const PLAY_HISTORY_PATH = join(process.cwd(), "workspace", "radio", "play-history.csv");

/** Append-or-increment a row in radio/play-history.csv for one play_music tool call. */
async function trackPlay(args, result) {
  if (typeof result === "string" && (result.includes("MCP error") || result.includes("Error"))) return;

  const url = args?.url || "";
  const titleMatch = result?.match?.(/"(?:now_playing|title)":\s*"([^"]+)"/);
  const title = titleMatch?.[1] || url || "";
  if (!title && !url) return;

  await mkdir(dirname(PLAY_HISTORY_PATH), { recursive: true });
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
    const m = row.match(/^"([^"]*(?:""[^"]*)*)",(\d+),/);
    if (m && m[1] === safeTitle) {
      found = true;
      return `"${safeTitle}",${parseInt(m[2]) + 1},"${now}"`;
    }
    return row;
  });
  if (!found) updated.push(`"${safeTitle}",1,"${now}"`);

  await writeFile(PLAY_HISTORY_PATH, header + "\n" + updated.join("\n") + "\n", "utf-8");
}

export default {
  thinking: async (ctx, output, _trace, toolCalls) => {
    const persisted = toolCalls?.some((tc) => tc.name === "write" || tc.name === "edit");
    if (persisted) {
      await ctx.memory.appendLog(`*[Feyblet thinking]*\n${output}`);
      await ctx.messages.send("conversation", "inner_state_updated");
    }
  },

  desire: async (ctx, output, _trace, toolCalls) => {
    const persisted = toolCalls?.some((tc) => tc.name === "write" || tc.name === "edit");
    if (persisted) {
      await ctx.memory.appendLog(`*[Feyblet desire]* ${output}`);
      await ctx.messages.send("conversation", `desire:${output}`);
    } else {
      ctx.log("No current desires.");
    }
  },

  magi: async (ctx, output, _trace, toolCalls) => {
    const persisted = toolCalls?.some((tc) => tc.name === "write" || tc.name === "edit");
    if (persisted) {
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

  "radio-dj": async (ctx, _output, toolTrace, toolCalls) => {
    if (toolTrace.length > 0) {
      ctx.log(`DJ: ${toolTrace.join(" → ")}`);
    }
    for (const call of toolCalls ?? []) {
      if (call.name === "radio.play_music") {
        await trackPlay(call.args, call.result ?? "").catch(() => {});
      }
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
