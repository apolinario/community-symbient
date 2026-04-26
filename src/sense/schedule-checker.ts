/**
 * Schedule Checker — cron-aware poller that fires due scheduled actions.
 *
 * Runs every 60s. Checks workspace/tasks/scheduled.json for due items.
 * Two schedule formats are supported:
 *   - `when` (epoch ms): one-shot scheduling
 *   - `cron` (cron expression): recurring schedule like "30 11 * * 1-5" (11:30 weekdays)
 *
 * When something is due, sends an MQTT nudge to the item's `target` module
 * (or to the deployment-configured default; if neither is set, falls back
 * to whichever module has `role: "scheduled-action-default"` or, failing
 * that, `role: "chat-handler"`). Cron items advance `nextRun` to the next
 * occurrence; one-shot items are marked `done: true`.
 */

import type { ModuleContext } from "../core/types.js";
import { recordEvent } from "../core/event-log.js";
import { getBuiltInModuleNameByRole } from "../core/module-factories.js";
import { createLogger } from "../core/logger.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";

const log = createLogger("schedule");

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
  /**
   * Resolution order for the per-fire fallback target:
   *   1. The item's own `target`.
   *   2. The deployment's configured `scheduling.defaultTarget`.
   *   3. A module registered with `role: "scheduled-action-default"`.
   *   4. A module registered with `role: "chat-handler"`.
   *   5. Drop the fire and warn — config is incomplete.
   */
  function resolveDefaultTarget(): string | null {
    if (opts.defaultTarget) return opts.defaultTarget;
    return (
      getBuiltInModuleNameByRole("scheduled-action-default") ??
      getBuiltInModuleNameByRole("chat-handler") ??
      null
    );
  }

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
    let dropped = 0;
    for (const item of due) {
      const target = item.target || resolveDefaultTarget();
      if (!target) {
        log.warn(
          `Scheduled item ${item.id} dropped: no per-item target, no scheduling.defaultTarget, ` +
          `and no module registered with role "scheduled-action-default" or "chat-handler".`,
        );
        dropped++;
        continue;
      }
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
    const dropNote = dropped > 0 ? `, ${dropped} dropped (no target)` : "";
    ctx.log(`${due.length} scheduled item(s) due (${summary}${dropNote})`);
  };
}
