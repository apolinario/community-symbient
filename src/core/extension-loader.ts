/**
 * Extension Loader — dynamically imports deployment-specific JS from
 * `workspace/extensions/*` and registers them with the relevant framework
 * registries.
 *
 * This is the seam that keeps `src/` (framework) and `workspace/` (deployment)
 * separate. A deployment adds custom helpers, providers, actions, adapters,
 * or sensors by dropping a file in `workspace/extensions/`, without touching
 * any framework code. Framework upgrades merge cleanly because they never
 * touch the workspace.
 *
 * File shape convention: every extension file `export default` an object
 * keyed by name. Each value is the extension payload (a function for helpers,
 * an adapter object for adapters, etc.). The caller picks how to register.
 *
 *   // workspace/extensions/helpers.js
 *   export default {
 *     weather: async () => { ... },
 *     serverStatus: () => { ... },
 *   };
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHelper, type HelperFn } from "./prompt-vars.js";
import { registerModuleHandler, type ModuleHandler } from "./handler-registry.js";
import { registerProvider, type ContextProvider } from "./context-providers.js";
import { registerAction, type ActionHandler } from "./action-registry.js";
import { registerChatAdapter, registerSensor, registerDirectory } from "./adapter-registry.js";
import { createLogger } from "./logger.js";
import type { ChatAdapterFactory } from "../adapters/chat/types.js";
import type { SensorFactory } from "../adapters/sensor/types.js";
import type { DirectoryFactory } from "../adapters/directory/types.js";

const log = createLogger("extension-loader");

const CANDIDATE_EXTENSIONS = [".js", ".mjs", ".ts"];

async function importIfExists(basePath: string): Promise<Record<string, unknown> | null> {
  for (const ext of CANDIDATE_EXTENSIONS) {
    const fullPath = basePath + ext;
    if (!existsSync(fullPath)) continue;
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      const exports = (mod.default ?? mod) as Record<string, unknown>;
      return exports;
    } catch (err) {
      log.error(`Failed to import ${fullPath}: ${err}`);
      return null;
    }
  }
  return null;
}

async function importAllInDir(dirPath: string): Promise<Array<{ file: string; exports: Record<string, unknown> }>> {
  if (!existsSync(dirPath)) return [];
  const files = await readdir(dirPath);
  const results: Array<{ file: string; exports: Record<string, unknown> }> = [];
  for (const file of files) {
    if (!CANDIDATE_EXTENSIONS.some((e) => file.endsWith(e))) continue;
    const fullPath = join(dirPath, file);
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      const exports = (mod.default ?? mod) as Record<string, unknown>;
      results.push({ file, exports });
    } catch (err) {
      log.error(`Failed to import ${fullPath}: ${err}`);
    }
  }
  return results;
}

/**
 * Generalised single-file loader: scans `workspace/extensions/<subdir>.{js,mjs,ts}`,
 * iterates the named exports, validates each entry, and registers it via the
 * supplied `register` callback. Returns the names that registered successfully.
 * No-op when the file is missing.
 */
async function loadSingleFile<T>(
  workspacePath: string,
  subdir: string,
  validate: (entry: unknown, name: string) => entry is T,
  register: (name: string, value: T) => void,
): Promise<string[]> {
  const basePath = join(workspacePath, "extensions", subdir);
  const exports = await importIfExists(basePath);
  if (!exports) return [];

  const registered: string[] = [];
  for (const [name, value] of Object.entries(exports)) {
    if (!validate(value, name)) continue;
    register(name, value);
    registered.push(name);
  }
  return registered;
}

const isFunctionEntry = (subdir: string) =>
  (entry: unknown, name: string): entry is (...args: unknown[]) => unknown => {
    if (typeof entry === "function") return true;
    log.error(`Skipping '${name}' in ${subdir} — not a function`);
    return false;
  };

const isProviderEntry = (entry: unknown, name: string): entry is ContextProvider => {
  if (entry && typeof (entry as ContextProvider).execute === "function") return true;
  log.error(`Skipping '${name}' in providers — missing execute()`);
  return false;
};

/**
 * Load `workspace/extensions/helpers.{js,mjs,ts}` if present and register
 * each exported function as a Handlebars helper. No-op if file is missing.
 */
export async function loadWorkspaceHelpers(workspacePath: string): Promise<string[]> {
  return loadSingleFile<HelperFn>(
    workspacePath,
    "helpers",
    isFunctionEntry("helpers") as (e: unknown, n: string) => e is HelperFn,
    registerHelper,
  );
}

/**
 * Load `workspace/extensions/handlers.{js,mjs,ts}` if present and register
 * each exported function as a module output handler keyed by module name.
 * No-op if file is missing.
 */
export async function loadWorkspaceHandlers(workspacePath: string): Promise<string[]> {
  return loadSingleFile<ModuleHandler>(
    workspacePath,
    "handlers",
    isFunctionEntry("handlers") as (e: unknown, n: string) => e is ModuleHandler,
    registerModuleHandler,
  );
}

/**
 * Load `workspace/extensions/providers.{js,mjs,ts}` if present and register
 * each exported ContextProvider under its export name. No-op if file is missing.
 *
 * Deployments use this for custom `source: my-thing` context providers in
 * module frontmatter — weather forecasts, sensor histories, etc. The built-in
 * `events` provider already handles arbitrary event types emitted via
 * `recordEvent()`, so most custom context only needs a new event type, not a
 * new provider.
 */
export async function loadWorkspaceProviders(workspacePath: string): Promise<string[]> {
  return loadSingleFile<ContextProvider>(workspacePath, "providers", isProviderEntry, registerProvider);
}

/**
 * Load `workspace/extensions/actions.{js,mjs,ts}` if present and register
 * each exported function as a watch action kind. No-op if file is missing.
 *
 * Built-in kinds (dm/group/nudge) cover the common cases. Deployments add
 * `webhook`, `email`, `sms`, etc. — a watch then references
 * `"kind": "webhook"` in its action JSON.
 */
export async function loadWorkspaceActions(workspacePath: string): Promise<string[]> {
  return loadSingleFile<ActionHandler>(
    workspacePath,
    "actions",
    isFunctionEntry("actions") as (e: unknown, n: string) => e is ActionHandler,
    registerAction,
  );
}

/**
 * Load all *.js files from a workspace/extensions subdirectory and pass
 * their default exports to a registrar. Each factory object must carry
 * a `name` and an adapter-kind-specific shape (factory.create, etc.).
 */
async function loadFactoriesFromDir<F extends { name: string }>(
  workspacePath: string,
  subdir: string,
  register: (factory: F) => void,
  validate: (entry: unknown) => entry is F,
): Promise<string[]> {
  const dirPath = join(workspacePath, "extensions", subdir);
  const entries = await importAllInDir(dirPath);
  const registered: string[] = [];
  for (const { file, exports } of entries) {
    const factory = exports.default ?? exports;
    if (!validate(factory)) {
      log.error(`Skipping ${subdir}/${file} — missing expected fields`);
      continue;
    }
    register(factory);
    registered.push(factory.name);
  }
  return registered;
}

const isChatFactory = (x: unknown): x is ChatAdapterFactory =>
  !!x && typeof (x as any).name === "string" && typeof (x as any).create === "function";
const isSensorFactory = (x: unknown): x is SensorFactory =>
  !!x && typeof (x as any).name === "string" && typeof (x as any).create === "function";
const isDirectoryFactory = (x: unknown): x is DirectoryFactory =>
  !!x && typeof (x as any).name === "string" && typeof (x as any).create === "function";

export async function loadWorkspaceChatAdapters(workspacePath: string): Promise<string[]> {
  return loadFactoriesFromDir(workspacePath, "adapters/chat", registerChatAdapter, isChatFactory);
}

export async function loadWorkspaceSensors(workspacePath: string): Promise<string[]> {
  return loadFactoriesFromDir(workspacePath, "sensors", registerSensor, isSensorFactory);
}

export async function loadWorkspaceDirectories(workspacePath: string): Promise<string[]> {
  return loadFactoriesFromDir(workspacePath, "adapters/directory", registerDirectory, isDirectoryFactory);
}

/**
 * Load `workspace/extensions/tools.{js,mjs,ts}` if present. The default
 * export must be a function `(deps) => AgentTool[]`. Framework calls it
 * with the deployment's deps and mixes the returned tools into the
 * global tool list — the seam for community-specific capabilities
 * (broadcast, sensor reads, PMS lookups, etc.). Returns the factory
 * function or null if the file is missing.
 */
export async function loadWorkspaceToolsFactory(
  workspacePath: string,
): Promise<((deps: unknown) => unknown[]) | null> {
  const basePath = join(workspacePath, "extensions", "tools");
  const exports = await importIfExists(basePath);
  if (!exports) return null;
  const factory = exports.default ?? exports;
  if (typeof factory !== "function") {
    log.error(`workspace/extensions/tools — default export must be a function`);
    return null;
  }
  return factory as (deps: unknown) => unknown[];
}

/**
 * Load `workspace/extensions/modules.{js,mjs,ts}` if present. The default
 * export must be a factory `(deps) => BuiltInModule[]` that returns an
 * array of deployment-provided code-driven modules (not markdown-driven).
 *
 * This is where deployments declare their bespoke code-driven modules
 * (anything that needs more than what a markdown module can express)
 * alongside their factory functions. Framework has no knowledge of them;
 * the workspace owns them.
 */
export async function loadWorkspaceModulesFactory(
  workspacePath: string,
): Promise<((deps: unknown) => unknown[]) | null> {
  const basePath = join(workspacePath, "extensions", "modules");
  const exports = await importIfExists(basePath);
  if (!exports) return null;
  const factory = exports.default ?? exports;
  if (typeof factory !== "function") {
    log.error(`workspace/extensions/modules — default export must be a function`);
    return null;
  }
  return factory as (deps: unknown) => unknown[];
}

/**
 * Load all deployment-provided extensions. Called once at startup from
 * `src/index.ts`. Returns a summary for logging.
 */
export async function loadAllExtensions(workspacePath: string): Promise<{
  helpers: string[];
  handlers: string[];
  providers: string[];
  actions: string[];
  chatAdapters: string[];
  sensors: string[];
  directories: string[];
}> {
  const [helpers, handlers, providers, actions, chatAdapters, sensors, directories] = await Promise.all([
    loadWorkspaceHelpers(workspacePath),
    loadWorkspaceHandlers(workspacePath),
    loadWorkspaceProviders(workspacePath),
    loadWorkspaceActions(workspacePath),
    loadWorkspaceChatAdapters(workspacePath),
    loadWorkspaceSensors(workspacePath),
    loadWorkspaceDirectories(workspacePath),
  ]);
  return { helpers, handlers, providers, actions, chatAdapters, sensors, directories };
}

// Exposed for callers that want to scan a workspace subdir with the same
// import + default-export conventions used by the loaders above.
export { importAllInDir };
