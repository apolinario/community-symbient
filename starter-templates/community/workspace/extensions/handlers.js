/**
 * Module output handlers — called after each agent module completes a cycle.
 *
 * Keyed by module name. Handlers decide what to do with the agent's
 * final text output + tool call trace. The cognitive modules
 * (thinking, desire, magi, autobiographical) use the agent's
 * `write` / `edit` tools to persist reflections to files; the handler's
 * job here is to log cycle completion to the daily log and notify
 * downstream modules via `ctx.messages.send`.
 *
 * The log-prefix convention `*[Symbient <module>]*` lines up with each
 * module's `dashboardLogTag` frontmatter — keeps the dashboard's
 * per-module log filter accurate. Edit one and edit the other.
 */

export default {
  thinking: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[Symbient thinking]*\n${output}`);
      await ctx.messages.send("conversation", "inner_state_updated");
    }
  },

  desire: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[Symbient desire]* ${output}`);
      await ctx.messages.send("conversation", `desire:${output}`);
    } else {
      ctx.log("No current desires.");
    }
  },

  magi: async (ctx, output, _trace, toolCalls) => {
    const wrote = toolCalls?.some((tc) => tc.name === "write");
    if (wrote) {
      await ctx.memory.appendLog(`*[Symbient magi]*\n${output}`);
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
};
