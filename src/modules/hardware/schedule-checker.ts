/**
 * Schedule Checker — cron-aware poller that wakes the executive module.
 *
 * Runs every 60s. Checks workspace/tasks/scheduled.json for due items.
 * Supports two schedule formats:
 *   - `when` (epoch ms): one-shot or legacy timestamp-based scheduling
 *   - `cron` (cron expression): recurring schedule like "30 11 * * 1-5" (11:30 weekdays)
 *
 * When something is due, sends an MQTT message to the executive module
 * with the full action payload so it can execute immediately.
 *
 * For cron items, advances `nextRun` to the next occurrence.
 * For one-shot items, marks them `done: true`.
 */

import type { ModuleContext } from "../../core/types.js";
import { recordEvent } from "../../core/event-log.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";

interface ScheduleItem {
  id: string;
  prompt: string;
  context?: string | null;
  // One-shot or legacy: epoch ms
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

export function createScheduleCheckerModule() {
  return async function scheduleChecker(ctx: ModuleContext): Promise<void> {
    const schedulePath = join(process.cwd(), "workspace", "tasks", "scheduled.json");

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
        // Legacy timestamp-based item
        due.push(item);
        item.done = true;
        modified = true;
      }
    }

    if (modified) {
      await writeFile(schedulePath, JSON.stringify(schedule, null, 2), "utf-8");
    }

    if (due.length === 0) return;

    // Wake the executive with full action details for each due item
    for (const item of due) {
      const payload = JSON.stringify({
        type: "scheduled_action",
        id: item.id,
        prompt: item.prompt,
        context: item.context || null,
      });
      await ctx.messages.send("executive", payload);
      recordEvent({
        type: "scheduled_fired",
        id: item.id,
        prompt: item.prompt,
        cron: item.cron ?? null,
      });
    }
    ctx.log(`${due.length} scheduled item(s) due, waking executive`);
  };
}
