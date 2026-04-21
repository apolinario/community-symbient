/**
 * Module output handlers — called after each agent module completes a cycle.
 *
 * Each export keyed by module name. The framework calls the matching handler
 * with (ctx, output, toolTrace, toolCalls) after the agent finishes. If a
 * module has no handler here, it falls back to the default (log to today's
 * daily memory).
 *
 * Add handlers per module you want special post-processing for. Delete the
 * examples if you don't need them.
 */

export default {
  // Example — log the thinking module's reflection into the daily log
  // whenever the agent used a write tool.
  //
  // thinking: async (ctx, output, _trace, toolCalls) => {
  //   const wrote = toolCalls?.some((tc) => tc.name === "write");
  //   if (wrote) {
  //     await ctx.memory.appendLog(`*[thinking]*\n${output}`);
  //   }
  // },
};
