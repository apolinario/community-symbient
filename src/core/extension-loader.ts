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
import type { ChatAdapterFactory } from "../adapters/chat/types.js";
import type { SensorFactory } from "../adapters/sensor/types.js";
import type { DirectoryFactory } from "../adapters/directory/types.js";

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
      console.error(`[extension-loader] Failed to import ${fullPath}: ${err}`);
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
      console.error(`[extension-loader] Failed to import ${fullPath}: ${err}`);
    }
  }
  return results;
}

/**
 * Load `workspace/extensions/helpers.{js,mjs,ts}` if present and register
 * each exported function as a Handlebars helper. No-op if the file is missing.
 */
export async function loadWorkspaceHelpers(workspacePath: string): Promise<string[]> {
  const basePath = join(workspacePath, "extensions", "helpers");
  const exports = await importIfExists(basePath);
  if (!exports) return [];

  const registered: string[] = [];
  for (const [name, fn] of Object.entries(exports)) {
    if (typeof fn !== "function") {
      console.error(`[extension-loader] Skipping '${name}' in helpers — not a function`);
      continue;
    }
    registerHelper(name, fn as HelperFn);
    registered.push(name);
  }
  return registered;
}

/**
 * Load `workspace/extensions/handlers.{js,mjs,ts}` if present and register
 * each exported function as a module output handler, keyed by module name.
 * No-op if the file is missing.
 */
export async function loadWorkspaceHandlers(workspacePath: string): Promise<string[]> {
  const basePath = join(workspacePath, "extensions", "handlers");
  const exports = await importIfExists(basePath);
  if (!exports) return [];

  const registered: string[] = [];
  for (const [name, fn] of Object.entries(exports)) {
    if (typeof fn !== "function") {
      console.error(`[extension-loader] Skipping '${name}' in handlers — not a function`);
      continue;
    }
    registerModuleHandler(name, fn as ModuleHandler);
    registered.push(name);
  }
  return registered;
}

/**
 * Load `workspace/extensions/providers.{js,mjs,ts}` if present and register
 * each exported ContextProvider under the key it was exported as. No-op if
 * the file is missing.
 *
 * Deployments use this to add custom `source: my-thing` context provider
 * blocks to their modules' frontmatter — e.g. a weather-forecast provider,
 * a custom sensor-history provider, etc. The `events` provider always
 * works for any event type a deployment emits via `recordEvent()`, so
 * most custom context just needs a custom event type, not a new provider.
 */
export async function loadWorkspaceProviders(workspacePath: string): Promise<string[]> {
  const basePath = join(workspacePath, "extensions", "providers");
  const exports = await importIfExists(basePath);
  if (!exports) return [];

  const registered: string[] = [];
  for (const [name, provider] of Object.entries(exports)) {
    if (!provider || typeof (provider as ContextProvider).execute !== "function") {
      console.error(`[extension-loader] Skipping '${name}' in providers — missing execute()`);
      continue;
    }
    registerProvider(name, provider as ContextProvider);
    registered.push(name);
  }
  return registered;
}

/**
 * Load `workspace/extensions/actions.{js,mjs,ts}` if present and register
 * each exported function as a watch action kind. No-op if file is missing.
 *
 * Built-in kinds (dm/group/broadcast) nudge conversation/radio modules.
 * Deployments add things like `webhook`, `email`, `sms` without touching
 * core — a watch then references `"kind": "webhook"` in its action JSON.
 */
export async function loadWorkspaceActions(workspacePath: string): Promise<string[]> {
  const basePath = join(workspacePath, "extensions", "actions");
  const exports = await importIfExists(basePath);
  if (!exports) return [];

  const registered: string[] = [];
  for (const [kind, fn] of Object.entries(exports)) {
    if (typeof fn !== "function") {
      console.error(`[extension-loader] Skipping '${kind}' in actions — not a function`);
      continue;
    }
    registerAction(kind, fn as ActionHandler);
    registered.push(kind);
  }
  return registered;
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
      console.error(`[extension-loader] Skipping ${subdir}/${file} — missing expected fields`);
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

export const loadWorkspaceChatAdapters = (ws: string) =>
  loadFactoriesFromDir(ws, "adapters/chat", registerChatAdapter, isChatFactory);
export const loadWorkspaceSensors = (ws: string) =>
  loadFactoriesFromDir(ws, "sensors", registerSensor, isSensorFactory);
export const loadWorkspaceDirectories = (ws: string) =>
  loadFactoriesFromDir(ws, "adapters/directory", registerDirectory, isDirectoryFactory);

/**
 * Load `workspace/extensions/tools.{js,mjs,ts}` if present. The default
 * export must be a function `(deps) => AgentTool[]`. Framework calls it
 * with the deployment's deps object and mixes the returned tools into
 * the global tool list.
 *
 * This is how a deployment plugs in community-specific tools (e.g. Feÿ's
 * radio_broadcast, check_sauna) without the framework knowing about them.
 * Returns the factory function or null if the file is missing.
 */
export async function loadWorkspaceToolsFactory(
  workspacePath: string,
): Promise<((deps: unknown) => unknown[]) | null> {
  const basePath = join(workspacePath, "extensions", "tools");
  const exports = await importIfExists(basePath);
  if (!exports) return null;
  const factory = exports.default ?? exports;
  if (typeof factory !== "function") {
    console.error(`[extension-loader] workspace/extensions/tools — default export must be a function`);
    return null;
  }
  return factory as (deps: unknown) => unknown[];
}

/**
 * Load `workspace/extensions/modules.{js,mjs,ts}` if present. The default
 * export must be a factory `(deps) => BuiltInModule[]` that returns an
 * array of deployment-provided code-driven modules (not markdown-driven).
 *
 * Deployments with Feÿ-specific modules — bookings, people-sync,
 * onboarding, etc. — declare them here alongside their factory functions.
 * Framework has no knowledge of them; the workspace owns them.
 */
export async function loadWorkspaceModulesFactory(
  workspacePath: string,
): Promise<((deps: unknown) => unknown[]) | null> {
  const basePath = join(workspacePath, "extensions", "modules");
  const exports = await importIfExists(basePath);
  if (!exports) return null;
  const factory = exports.default ?? exports;
  if (typeof factory !== "function") {
    console.error(`[extension-loader] workspace/extensions/modules — default export must be a function`);
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

// Re-export the directory scanner for later phases that need it.
export { importAllInDir };
