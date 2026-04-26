/**
 * Built-in Module Factories — the registry that `src/index.ts` consults
 * when instantiating modules listed in `config.enabled_modules`.
 *
 * Modules that need dependencies (a Directory, a ChatAdapter, etc.)
 * declare them in `requires`; the framework skips the module with a
 * warning if the dep isn't wired up for this deployment.
 *
 * Adding a custom module:
 *   - Markdown-driven: drop a `.md` in `workspace/modules/`.
 *   - Code-driven: register a factory from `workspace/extensions/modules.ts`
 *     by calling `registerBuiltInModule(name, {config, factory, requires?})`.
 */

import type { ModuleConfig, ModuleFunction, LLMClient } from "./types.js";
import type { MemoryManager } from "../memory/manager.js";
import type { MQTTBus } from "./mqtt-bus.js";
import type { Orchestrator } from "./orchestrator.js";
import type { ChatAdapter } from "../adapters/chat/types.js";
import type { Directory } from "../adapters/directory/types.js";

/**
 * Deps available to every module factory. Framework-wired:
 *   - memory, workspacePath, bus, orchestrator, llm (always present)
 *   - chatAdapter (only if config.adapters.chat is set)
 *   - directory (only if config.adapters.directory is set)
 * Deployment modules can cast `directory` to their concrete adapter type
 * inside `workspace/extensions/modules.ts` if they need adapter-specific
 * methods beyond the Directory interface.
 */
export interface ModuleDeps {
  memory: MemoryManager;
  workspacePath: string;
  bus: MQTTBus;
  orchestrator: Orchestrator;
  /** Simple text-completion client (no tools). For LLM calls outside agent loops — summaries, classifiers. */
  llm: LLMClient;
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
