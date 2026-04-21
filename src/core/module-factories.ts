/**
 * Built-in Module Factories — the framework's shipped modules, each
 * wrapped as a name → factory entry so `src/index.ts` can instantiate
 * only what `config.modules` declares.
 *
 * A deployment picks which built-in modules to enable by listing them
 * in `config.modules`. Modules that need dependencies (a Directory, a
 * ChatAdapter) declare them in `requires`; the framework skips the
 * module with a warning if the dep isn't wired up for this deployment.
 *
 * Adding a custom module: drop a `.md` in `workspace/modules/` (the
 * loader picks it up automatically) or, for code-driven modules,
 * create a factory in `workspace/extensions/modules/<name>.js` that
 * exports `{ config, factory, requires? }` and register via the
 * extension loader (future work — for now code-driven modules go in
 * `src/` or as MCP tools).
 */

import type { ModuleConfig, ModuleFunction } from "./types.js";
import type { MemoryManager } from "../memory/manager.js";
import type { MQTTBus } from "./mqtt-bus.js";
import type { Orchestrator } from "./orchestrator.js";
import type { ChatAdapter } from "../adapters/chat/types.js";
import type { Directory } from "../adapters/directory/types.js";

/**
 * Deps available to every module factory. Framework-wired:
 *   - memory, workspacePath, bus, orchestrator (always present)
 *   - chatAdapter (only if config.adapters.chat is set)
 *   - directory (only if config.adapters.directory is set)
 * Deployment modules cast `directory` to their specific impl type
 * (e.g. FeyOpsDB) inside `workspace/extensions/modules.ts`.
 */
export interface ModuleDeps {
  memory: MemoryManager;
  workspacePath: string;
  bus: MQTTBus;
  orchestrator: Orchestrator;
  chatAdapter?: ChatAdapter;
  directory?: Directory;
}

export interface BuiltInModule {
  config: ModuleConfig;
  factory: (deps: ModuleDeps, params?: Record<string, unknown>) => ModuleFunction;
  /** Which deps are mandatory. Missing deps → module is skipped with a warning. */
  requires?: Array<keyof ModuleDeps>;
  /** Short description shown at registration time. */
  note?: string;
}

const registry = new Map<string, BuiltInModule>();

export function registerBuiltInModule(name: string, mod: BuiltInModule): void {
  registry.set(name, mod);
}

export function getBuiltInModule(name: string): BuiltInModule | undefined {
  return registry.get(name);
}

export function listBuiltInModules(): string[] {
  return [...registry.keys()];
}
