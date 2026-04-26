/**
 * Schedule Checker — cron-aware poller that fires due scheduled actions.
 *
 * Runs every 60s. Checks workspace/tasks/scheduled.json for due items.
 * Two schedule formats are supported:
 *   - `when` (epoch ms): one-shot scheduling
 *   - `cron` (cron expression): recurring schedule like "30 11 * * 1-5" (11:30 weekdays)
 *
 * When something is due, sends an MQTT nudge to the item's `target` module
 * (or to the deployment-configured default — typically `"conversation"`)
 * with a `scheduled_action` payload. Cron items advance `nextRun` to the
 * next occurrence; one-shot items are marked `done: true`.
 */

import type { ModuleContext } from "../core/types.js";
import { recordEvent } from "../core/event-log.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";

interface ScheduleItem {
  id: string;
  prompt: string;
  context?: string | null;
  /** Module to nudge when this fires. Falls back to defaultTarget if unset. */
  target?: string;
  // One-shot: epoch ms
  when?: number;
  // Cron-based: cron expression string
  cron?: string;
  // Next run time for cron items (epoch ms, computed by checker)
  nextRun?: number;
  recurrence?: string;
  done?: boolean;
  created?: string;
  expires?: string | null;
}

export function createScheduleCheckerModule(opts: { defaultTarget?: string; workspacePath?: string } = {}) {
  const defaultTarget = opts.defaultTarget ?? "conversation";
  return async function scheduleChecker(ctx: ModuleContext): Promise<void> {
    // Prefer the workspace passed in at registration time. Fall back to
    // process.cwd()-derived only if the deployment forgot to wire it.
    const root = opts.workspacePath ?? join(process.cwd(), "workspace");
    const schedulePath = join(root, "tasks", "scheduled.json");

    let schedule: ScheduleItem[];
    try {
      const parsed = JSON.parse(await readFile(schedulePath, "utf-8"));
      // Accept both bare array and {scheduled: [...]} / {tasks: [...]} wrappers
      if (Array.isArray(parsed)) {
        schedule = parsed;
      } else if (parsed && Array.isArray(parsed.scheduled)) {
        schedule = parsed.scheduled;
      } else if (parsed && Array.isArray(parsed.tasks)) {
        schedule = parsed.tasks;
      } else {
        ctx.log(`scheduled.json is not in a recognized format, skipping`);
        return;
      }
    } catch {
      return;
    }

    const now = Date.now();
    const due: ScheduleItem[] = [];
    let modified = false;

    for (const item of schedule) {
      if (item.done) continue;

      // Check expiry
      if (item.expires) {
        const expiresMs = new Date(item.expires).getTime();
        if (!isNaN(expiresMs) && expiresMs < now) {
          item.done = true;
          modified = true;
          continue;
        }
      }

      if (item.cron) {
        // Cron-based item: compute nextRun if not set
        if (!item.nextRun) {
          try {
            const job = new Cron(item.cron);
            const next = job.nextRun();
            item.nextRun = next ? next.getTime() : undefined;
            modified = true;
          } catch (err) {
            ctx.log(`Invalid cron "${item.cron}" for ${item.id}: ${err}`);
            continue;
          }
        }

        if (item.nextRun && item.nextRun <= now) {
          due.push(item);
          // Advance to next occurrence
          try {
            const job = new Cron(item.cron);
            const next = job.nextRun();
            item.nextRun = next ? next.getTime() : undefined;
          } catch {
            item.done = true; // invalid cron, disable
          }
          modified = true;
        }
      } else if (item.when && item.when <= now) {
        // One-shot timestamp item
        due.push(item);
        item.done = true;
        modified = true;
      }
    }

    if (modified) {
      await writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");
    }

    if (due.length === 0) return;

    // Fire each due item to its target module (per-item override, else default).
    const counts = new Map<string, number>();
    for (const item of due) {
      const target = item.target || defaultTarget;
      const payload = JSON.stringify({
        type: "scheduled_action",
        id: item.id,
        prompt: item.prompt,
        context: item.context || null,
      });
      await ctx.messages.send(target, payload);
      counts.set(target, (counts.get(target) ?? 0) + 1);
      recordEvent({
        type: "scheduled_fired",
        id: item.id,
        prompt: item.prompt,
        target,
        cron: item.cron ?? null,
      });
    }
    const summary = [...counts.entries()].map(([t, n]) => `${n}→${t}`).join(", ");
    ctx.log(`${due.length} scheduled item(s) due (${summary})`);
  };
}
