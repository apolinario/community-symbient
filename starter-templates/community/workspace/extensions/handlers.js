/**
 * Module output handlers — called after each agent module completes a cycle.
 *
 * Keyed by module name. Handlers decide what to do with the agent's
 * final text output + tool call trace. The cognitive modules
 * (thinking, desire, magi, autobiographical, prompt-modifier) use the
 * agent's `write`/`edit` tools to persist reflections to files; the
 * handler's job here is to log the cycle completion and notify
 * downstream modules via `ctx.messages.send`.
 */

export default {
  thinking: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[${ctx.config.name} thinking]*\n${output}`);
      await ctx.messages.send("conversation", "inner_state_updated");
    }
  },

  desire: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[${ctx.config.name} desire]* ${output}`);
      await ctx.messages.send("conversation", `desire:${output}`);
    } else {
      ctx.log("No current desires.");
    }
  },

  magi: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[${ctx.config.name} magi]*\n${output}`);
    }
  },

  autobiographical: async (ctx, output, _trace, toolCalls) => {
    const wroteMemory = toolCalls?.some((tc) => tc.name === "write" || tc.name === "edit");
    if (wroteMemory) {
      await ctx.memory.appendLog("*[Autobiographical memory updated]*");
      ctx.log("MEMORY.md updated via agent tools.");
    } else if (output?.trim()) {
      await ctx.memory.appendLog("*[Autobiographical reflection]*");
    }
  },

  "prompt-modifier": async (ctx, output) => {
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
};
