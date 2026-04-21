/**
 * Watches — persistent event-driven triggers.
 *
 * A watch subscribes to events of a given type/filter, and when a matching
 * event arrives, fires an action (DM a person, post to group, broadcast on
 * radio, or any custom action registered from workspace/extensions/actions.js).
 *
 * Built on top of the event log — no separate subscription plumbing. The
 * watch-evaluator polls the event log every ~10s and checks each watch's
 * filter against the new events. Crossing triggers (crossing_up, crossing_down)
 * fire only on the *transition*, not every matching event — useful for
 * threshold conditions like "sauna hits 82°C" (you want one DM, not one per
 * reading while it stays hot).
 *
 * Watches are persisted in `workspace/state/watches.json`. Per-watch state
 * (used for crossing semantics) lives alongside in `workspace/state/watch-state.json`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("watches");

export type WatchTrigger = "always" | "crossing_up" | "crossing_down";

export interface WatchFilter {
  type: string;
  /** Optional where-expression evaluated against event fields (see condition-eval.ts). */
  where?: string;
  trigger?: WatchTrigger;
}

export interface WatchAction {
  /** Action kind — looked up in the action registry (built-in: dm, group, broadcast). */
  kind: string;
  /** All other fields are action-specific parameters. */
  [key: string]: unknown;
}

export interface Watch {
  id: string;
  on: WatchFilter;
  action: WatchAction;
  once?: boolean;
  created_by?: string;
  created_at?: string;
  /** Human-readable description of what this watch does (for list_watches output). */
  description?: string;
}

let workspacePath: string | null = null;

export function setWatchesWorkspace(path: string): void {
  workspacePath = path;
}

function watchesPath(): string {
  if (!workspacePath) throw new Error("Watches workspace not set");
  return join(workspacePath, "state", "watches.json");
}

function statePath(): string {
  if (!workspacePath) throw new Error("Watches workspace not set");
  return join(workspacePath, "state", "watch-state.json");
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export async function loadWatches(): Promise<Watch[]> {
  if (!workspacePath) return [];
  try {
    const content = await readFile(watchesPath(), "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveWatches(watches: Watch[]): Promise<void> {
  const path = watchesPath();
  await ensureDir(path);
  await writeFile(path, JSON.stringify(watches, null, 2), "utf-8");
}

export async function addWatch(watch: Omit<Watch, "id" | "created_at"> & { id?: string }): Promise<Watch> {
  const watches = await loadWatches();
  const id = watch.id ?? `watch-${Date.now()}`;
  const full: Watch = {
    ...watch,
    id,
    created_at: new Date().toISOString(),
  };
  watches.push(full);
  await saveWatches(watches);
  log.info(`Registered watch ${id}: on=${full.on.type} action=${full.action.kind}`);
  return full;
}

export async function removeWatch(id: string): Promise<boolean> {
  const watches = await loadWatches();
  const idx = watches.findIndex((w) => w.id === id);
  if (idx < 0) return false;
  watches.splice(idx, 1);
  await saveWatches(watches);
  log.info(`Removed watch ${id}`);
  await clearWatchState(id);
  return true;
}

// --- Per-watch state (crossing triggers need "did last match?" memory) ---

interface WatchStateFile {
  [watchId: string]: { lastMatched?: boolean; lastFiredTs?: number };
}

async function loadState(): Promise<WatchStateFile> {
  if (!workspacePath) return {};
  try {
    const content = await readFile(statePath(), "utf-8");
    return JSON.parse(content) as WatchStateFile;
  } catch {
    return {};
  }
}

async function writeState(state: WatchStateFile): Promise<void> {
  const path = statePath();
  await ensureDir(path);
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

export async function getWatchState(id: string): Promise<{ lastMatched?: boolean; lastFiredTs?: number }> {
  const state = await loadState();
  return state[id] ?? {};
}

export async function setWatchState(id: string, patch: { lastMatched?: boolean; lastFiredTs?: number }): Promise<void> {
  const state = await loadState();
  state[id] = { ...(state[id] ?? {}), ...patch };
  await writeState(state);
}

async function clearWatchState(id: string): Promise<void> {
  const state = await loadState();
  delete state[id];
  await writeState(state);
}
