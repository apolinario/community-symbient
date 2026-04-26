/**
 * Handler Registry — module output handlers.
 *
 * Each agent module can have a custom output handler that runs after the
 * agent cycle completes. It receives the final text output, the tool trace,
 * and the raw tool calls, and decides what to do with them (log, persist,
 * send downstream, etc.).
 *
 * Registry entries come from two places:
 *   1. Framework defaults (log-to-memory) register at startup for names
 *      that have no workspace override.
 *   2. Workspace extensions register via `workspace/extensions/handlers.js`,
 *      keyed by module name. These override any framework-provided handler
 *      of the same name.
 *
 * A symbient deployment chooses which cognitive patterns it runs by picking
 * a set of .md files AND matching handlers — the core runtime itself knows
 * nothing about "thinking" or "desire" or "radio"; it just runs modules and
 * calls the registered handler (or the default) for each one.
 */

import type { ModuleContext } from "./types.js";

export type ModuleHandler = (
  ctx: ModuleContext,
  output: string,
  toolTrace: string[],
  toolCalls?: Array<{ name: string; args: any; result?: string }>,
) => Promise<void>;

const registry = new Map<string, ModuleHandler>();

export function registerModuleHandler(name: string, fn: ModuleHandler): void {
  registry.set(name, fn);
}

export function getModuleHandler(name: string): ModuleHandler | undefined {
  return registry.get(name);
}

export function listModuleHandlers(): string[] {
  return [...registry.keys()];
}

/**
 * Default handler — appends the module's text output to today's daily log.
 * Used when no specific handler is registered for a module name.
 */
export const defaultModuleHandler: ModuleHandler = async (ctx, output) => {
  if (output.trim()) {
    await ctx.memory.appendLog(`*[${ctx.config.name}]* ${output}`);
  }
};
