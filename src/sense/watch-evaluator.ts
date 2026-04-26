/**
 * Watch Evaluator — polls the event log, fires watches on matches.
 *
 * Runs every ~10 seconds. For each watch:
 *
 *   - `always` trigger: iterate events of the watch's type that arrived
 *     since the last tick, fire the action for each one that matches.
 *     Used for "log every X that happens."
 *
 *   - `crossing_up` / `crossing_down`: look at the MOST RECENT event of
 *     the watch's type (regardless of window) to determine if the
 *     condition is currently true. Compare to `lastMatched` stored in
 *     per-watch state. Fire only on the transition.
 *     Used for threshold alerts — e.g. "fire once when temp ≥ 30°C",
 *     not once per sensor reading while the condition stays true.
 *
 * The distinction matters: thresholds want *state tracking* (did we cross
 * the boundary?), while firehoses want *event processing* (here's another
 * one). Using "events in the 10s window" for crossing triggers would
 * falsely reset state whenever a tick's window missed a periodic sensor.
 */

import type { ModuleContext } from "../core/types.js";
import { queryEvents, type Event } from "../core/event-log.js";
import { loadWatches, removeWatch, getWatchState, setWatchState, type Watch, type WatchTrigger } from "../core/watches.js";
import { getAction } from "../core/action-registry.js";
import { compileCondition } from "../core/condition-eval.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("watch-evaluator");

export function createWatchEvaluatorModule() {
  const compiledFilters = new Map<string, (event: Record<string, unknown>) => boolean>();
  // Watch ids whose `where` expression failed to compile or run — log
  // once per watch to avoid drowning the log on every event.
  const reportedFailures = new Set<string>();

  // Track last processed event timestamp per watch (for `always` trigger).
  // Persisting this in watch-state would be cleaner across restarts, but keeping
  // it in-memory is fine — at worst we re-fire actions after a restart, which
  // only matters if the action is non-idempotent, and those should be rare.
  const lastAlwaysTs = new Map<string, number>();
  const startTs = Date.now();

  return async function watchEvaluator(ctx: ModuleContext): Promise<void> {
    const watches = await loadWatches();
    if (watches.length === 0) return;

    for (const watch of watches) {
      try {
        const trigger = watch.on.trigger ?? "always";
        if (trigger === "always") {
          await evaluateAlways(watch, ctx);
        } else {
          await evaluateCrossing(watch, trigger, ctx);
        }
      } catch (err) {
        ctx.log(`Watch ${watch.id} evaluation failed: ${err}`);
      }
    }
  };

  function matches(watch: Watch, evt: Event): boolean {
    if (evt.type !== watch.on.type) return false;
    if (!watch.on.where) return true;
    let fn = compiledFilters.get(watch.id);
    if (!fn) {
      try {
        fn = compileCondition(watch.on.where);
        compiledFilters.set(watch.id, fn);
      } catch (err) {
        if (!reportedFailures.has(watch.id)) {
          log.error(`Watch ${watch.id} where-expression failed to compile (${(err as Error).message}): ${watch.on.where}`);
          reportedFailures.add(watch.id);
        }
        return false;
      }
    }
    try {
      return fn(evt as Record<string, unknown>);
    } catch (err) {
      if (!reportedFailures.has(watch.id)) {
        log.error(`Watch ${watch.id} where-expression threw at runtime (${(err as Error).message}): ${watch.on.where}`);
        reportedFailures.add(watch.id);
      }
      return false;
    }
  }

  async function evaluateAlways(watch: Watch, ctx: ModuleContext): Promise<void> {
    const since = lastAlwaysTs.get(watch.id) ?? startTs;
    const windowEvents = await queryEvents({ type: watch.on.type, since, days: 2 });
    const matching = windowEvents.filter((e) => matches(watch, e));
    if (matching.length === 0) {
      // Still advance the cursor so we don't re-scan the same empty window forever.
      if (windowEvents.length > 0) {
        lastAlwaysTs.set(watch.id, Number(windowEvents[windowEvents.length - 1].ts) + 1);
      }
      return;
    }
    for (const evt of matching) {
      await fire(watch, evt, ctx);
      if (watch.once) {
        await removeWatch(watch.id);
        compiledFilters.delete(watch.id);
        return;
      }
    }
    lastAlwaysTs.set(watch.id, Number(matching[matching.length - 1].ts) + 1);
  }

  async function evaluateCrossing(watch: Watch, trigger: WatchTrigger, ctx: ModuleContext): Promise<void> {
    // Get the most recent event of this type — that's "current state".
    const recent = await queryEvents({ type: watch.on.type, count: 1, days: 7 });
    if (recent.length === 0) return;

    const latest = recent[0];
    const currentlyMatches = matches(watch, latest);

    const state = await getWatchState(watch.id);
    const prev = state.lastMatched;

    // Persist the current state so the next tick can detect transitions.
    if (prev !== currentlyMatches) {
      await setWatchState(watch.id, { lastMatched: currentlyMatches });
    }

    let shouldFire = false;
    if (trigger === "crossing_up") {
      // Fire when condition is true and wasn't recently confirmed true. First
      // observation (prev undefined) counts — e.g. a "notify above 30°C" watch
      // registered while already above 30 alerts immediately, then stays
      // silent until the value drops and rises again. `prev !== true` instead
      // of `prev === false` is what makes the initial fire work.
      shouldFire = currentlyMatches && prev !== true;
    } else if (trigger === "crossing_down") {
      shouldFire = !currentlyMatches && prev === true;
    }

    if (!shouldFire) return;

    await fire(watch, latest, ctx);
    await setWatchState(watch.id, { lastFiredTs: Date.now() });
    if (watch.once) {
      await removeWatch(watch.id);
      compiledFilters.delete(watch.id);
    }
  }

  async function fire(watch: Watch, event: Event, ctx: ModuleContext): Promise<void> {
    const action = getAction(watch.action.kind);
    if (!action) {
      ctx.log(`Watch ${watch.id} references unknown action kind: ${watch.action.kind}`);
      return;
    }
    const { kind, ...params } = watch.action;
    await action({
      params: params as Record<string, unknown>,
      messages: ctx.messages,
      event,
      watchId: watch.id,
    });
    ctx.log(`Watch ${watch.id} fired → ${kind}`);
  }
}
