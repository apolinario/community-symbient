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
 *         return await fetchForecast(hours);
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

// Module context type (for handler/provider signatures)
export type { ModuleContext } from "./types.js";

// Adapter interfaces — deployments implement these to plug in custom chat
// transports, sensors, and directories (via workspace/extensions/adapters/
// and workspace/extensions/sensors/).
//
// Outputs (broadcast, email, webhook, etc.) are intentionally NOT a framework
// interface: they're just modules using tools. To add a broadcast capability,
// add a module .md + relevant tool (built-in or via MCP), and if you want a
// watch action that targets it, register a custom action in
// workspace/extensions/actions.js that nudges that module.
export type { ChatAdapter, ChatAdapterFactory, ChatMessageHandler } from "../adapters/chat/types.js";
export type { Sensor, SensorFactory } from "../adapters/sensor/types.js";
export type { Directory, DirectoryFactory, Member, Booking } from "../adapters/directory/types.js";
