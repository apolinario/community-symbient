/**
 * Schedule Checker — lightweight poller that wakes the executive module.
 *
 * Runs every 60s. Checks workspace/tasks/scheduled.json for due items.
 * When something is due, sends an MQTT message to the executive module,
 * which wakes it up instantly via interruptible sleep.
 *
 * Does NOT execute anything itself — pure date comparison, no LLM calls.
 */

import type { ModuleContext } from "../../core/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function createScheduleCheckerModule() {
  return async function scheduleChecker(ctx: ModuleContext): Promise<void> {
    const schedulePath = join(process.cwd(), "workspace", "tasks", "scheduled.json");

    let schedule: any[];
    try {
      schedule = JSON.parse(await readFile(schedulePath, "utf-8"));
    } catch {
      return; // no schedule file yet
    }

    const now = Date.now();
    const due = schedule.filter((s: any) => !s.done && s.when <= now);

    if (due.length === 0) return;

    // Wake the executive with info about due items
    const summary = due.map((s: any) => `[${s.id}] ${s.prompt.slice(0, 100)}`).join("\n");
    await ctx.messages.send("executive", `scheduled_due:${due.length} item(s) due:\n${summary}`);
    ctx.log(`${due.length} scheduled item(s) due, waking executive`);
  };
}
