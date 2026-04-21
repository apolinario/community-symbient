/**
 * Meta System Report — symbient's self-monitoring.
 *
 * Reads the state of all modules, recent memory, and system health,
 * then generates a report that other meta modules (autobiographical
 * memory, prompt modifier) use to make decisions.
 *
 * Also determines whether modules should activate/deactivate based
 * on current conditions — following CMA's activation pattern.
 */

import type { ModuleContext, ModuleHandle } from "../../core/types.js";
import type { Orchestrator } from "../../core/orchestrator.js";

export function createMetaReport(orchestrator: Orchestrator) {
  return async function metaReport(ctx: ModuleContext): Promise<void> {
    const modules = orchestrator.listModules();
    const todayLog = await ctx.memory.readTodayLog();

    const moduleStatus = modules.map(formatModuleStatus).join("\n");
    const logLength = todayLog?.split("\n").length || 0;
    const now = new Date();

    const report = [
      `# Meta System Report`,
      `*Generated: ${now.toISOString()}*`,
      ``,
      `## Module Status`,
      moduleStatus,
      ``,
      `## Activity`,
      `- Today's log: ${logLength} lines`,
      `- Time: ${now.toLocaleTimeString()}, ${now.toLocaleDateString("en-US", { weekday: "long" })}`,
    ].join("\n");

    await ctx.memory.writeFile("inner/meta-report.md", report);
    ctx.log("Meta report generated.");

    // Module activation decisions
    await decideActivations(ctx, modules, now, logLength);
  };
}

function formatModuleStatus(mod: ModuleHandle): string {
  const status = mod.active ? "ACTIVE" : "inactive";
  const lastRun = mod.lastRun
    ? mod.lastRun.toISOString().slice(11, 19)
    : "never";
  return `- **${mod.config.name}**: ${status} (last: ${lastRun}, interval: ${mod.config.intervalMs}ms)`;
}

async function decideActivations(
  ctx: ModuleContext,
  modules: ModuleHandle[],
  now: Date,
  logLength: number,
): Promise<void> {
  const hour = now.getHours();
  const isQuietHours = hour >= 1 && hour < 7;

  const ALWAYS_ON = new Set(["conversation", "meta-report", "radio", "radio-calendar"]);
  const MANUAL_ONLY = new Set(["onboarding"]);

  for (const mod of modules) {
    if (ALWAYS_ON.has(mod.config.name)) continue;
    if (MANUAL_ONLY.has(mod.config.name)) continue;

    if (isQuietHours) {
      if (mod.active) {
        mod.deactivate();
        ctx.log(`Deactivated ${mod.config.name} (quiet hours)`);
      }
    } else if (!mod.active && logLength > 5) {
      mod.activate();
      ctx.log(`Activated ${mod.config.name} (activity detected)`);
    }
  }
}
