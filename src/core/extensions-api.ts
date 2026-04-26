/**
 * Extensions API — stable surface for `workspace/extensions/*` files.
 *
 * This module is the single public import point for deployment extensions.
 * Everything a deployment needs to hook into the framework — registering
 * helpers, providers, handlers, emitting events, querying events — is
 * re-exported here. Internal refactors in core can move files around
 * freely as long as this surface remains stable.
 *
 * Example usage in workspace/extensions/providers.js:
 *
 *   import { recordEvent, queryEvents } from "../../src/core/extensions-api.js";
 *   // or, once the framework is packaged:
 *   // import { recordEvent } from "symbient-framework";
 *
 *   export default {
 *     "weather-forecast": {
 *       async execute(decl, ctx) {
 *         const hours = decl.hours ?? 24;
 *         // Use recordEvent to log, or fetch live. Return a string block.
 *         return fetchForecast(hours);
 *       },
 *     },
 *   };
 *
 * Note: workspace/extensions/handlers.js and helpers.js don't usually
 * need to import from here — they just export functions that core picks
 * up by name. This module is for extensions that want to *call* framework
 * APIs (most commonly recordEvent from a custom sensor or tool).
 */

// Template rendering (for extensions that build their own prompts)
export { render, parseSections } from "./prompt-template.js";

// Helper registry (helpers.js auto-registers, but extensions can query too)
export { registerHelper, getHelper, listHelpers, standardVars } from "./prompt-vars.js";
export type { HelperFn } from "./prompt-vars.js";

// Module handler registry
export { registerModuleHandler, getModuleHandler, listModuleHandlers, defaultModuleHandler } from "./handler-registry.js";
export type { ModuleHandler } from "./handler-registry.js";

// Context provider registry
export { registerProvider, getProvider, listProviders, renderContextBlocks } from "./context-providers.js";
export type { ContextProvider, ContextDecl } from "./context-providers.js";

// Event log — the key surface for "log new stuff without changing core"
export { recordEvent, queryEvents } from "./event-log.js";
export type { Event, QueryFilter } from "./event-log.js";

// Time annotation utilities — for context providers that want to render
// timestamps with relative-age labels or tag stale lines for past-tense
// rewrite via the tiny LLM.
export { rewriteStaleEntries, computeAge, isStale } from "./temporal-rewrite.js";
export { annotateContextLines } from "../memory/time-annotate.js";

// Module context + access types for handler/provider signatures.
export type { ModuleContext, MemoryAccess } from "./types.js";

// Adapter interfaces + registries — deployments implement these to plug
// in custom chat transports, sensors, and directories (via
// workspace/extensions/adapters/ and workspace/extensions/sensors/).
//
// Outputs (broadcast, email, webhook, etc.) are intentionally NOT a framework
// interface: they're just modules using tools. To add a broadcast capability,
// add a module .md + relevant tool (built-in or via MCP), and if you want a
// watch action that targets it, register a custom action in
// workspace/extensions/actions.js that nudges that module.
export type { ChatAdapter, ChatAdapterFactory, ChatMessageHandler } from "../adapters/chat/types.js";
export type { Sensor, SensorFactory } from "../adapters/sensor/types.js";
export type { Directory, DirectoryFactory, Member, Booking } from "../adapters/directory/types.js";
export {
  registerChatAdapter,
  registerSensor,
  registerDirectory,
  getChatAdapter,
  getSensor,
  getDirectory,
} from "./adapter-registry.js";

// Action registry — register custom watch action kinds (webhook, email,
// SMS, etc.) keyed by `kind`.
export { registerAction, getAction, listActions } from "./action-registry.js";
export type { ActionHandler, ActionContext } from "./action-registry.js";

// Built-in module registry — for deployment extensions that want to
// register code-driven modules alongside the framework's built-ins.
export { registerBuiltInModule, getBuiltInModule, listBuiltInModules, getBuiltInModuleNameByRole } from "./module-factories.js";
export type { ModuleRole } from "./module-factories.js";
export type { ModuleDeps, BuiltInModule } from "./module-factories.js";

// Watch storage — register, list, remove, and query persistent watches.
export { addWatch, removeWatch, loadWatches, getWatchState } from "./watches.js";
export type { Watch, WatchFilter, WatchAction, WatchTrigger } from "./watches.js";

// LLM client factory — extensions that need a text-only completion
// client (summarisers, classifiers, hooks) build one via createLLMClient
// rather than wiring the Pi SDK directly.
export { createLLMClient } from "./llm.js";
export type { LLMClient } from "./types.js";

// Symbient identity — for log prefixes, search collection names, and
// any other place an extension needs to refer to "this symbient".
export { symbientName, symbientDisplayName } from "./symbient-name.js";

// Frontmatter parsing — for extensions that want to read .md files with
// the same YAML conventions the framework uses for module/people files.
export { parseFrontmatter, parseInterval } from "./frontmatter.js";

// Module handler signature, plus base config types in case extensions
// want to type their own handler factories.
export type { ModuleConfig, ModuleFunction, ModuleHandle } from "./types.js";
export type { InboundMessage, OutboundMessage, MessageSender, Attachment, Mention } from "./types.js";
