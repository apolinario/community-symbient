/**
 * Registers all built-in modules and adapter factories.
 *
 * Called once at startup. After this, `config.modules` and
 * `config.adapters.*` can reference any registered factory by name.
 *
 * Framework-shipped modules are generic infrastructure only:
 * qmd-index, schedule-checker, watch-evaluator, module-sync, and
 * `conversation` (reactive chat handler that talks to whichever
 * ChatAdapter is configured). Deployment-specific code-driven modules
 * register from `workspace/extensions/modules.ts`.
 *
 * Built-in chat adapters self-register via the side-effect import below.
 */

import { registerBuiltInModule } from "./module-factories.js";
import { createScheduleCheckerModule } from "../sense/schedule-checker.js";
import { createWatchEvaluatorModule } from "../sense/watch-evaluator.js";
import { createModuleSyncModule } from "./module-sync.js";
import { createChatReactor } from "../modules/chat-reactor.js";
import type { SymbientConfig } from "./types.js";

// Built-in chat adapter factories self-register on import. A deployment
// that doesn't use Signal still pays the import cost but the factory
// stays inert unless config.adapters.chat picks "signal".
import "../adapters/chat/signal.js";

export function registerBuiltIns(config: SymbientConfig): void {
  const scheduledTarget = config.scheduling?.defaultTarget;

  registerBuiltInModule("schedule-checker", {
    config: { name: "schedule-checker", intervalMs: 60_000, startActive: true, description: "Fires due scheduled items via MQTT nudge" },
    factory: (deps) => createScheduleCheckerModule({
      defaultTarget: scheduledTarget,
      workspacePath: deps.workspacePath,
    }),
  });

  registerBuiltInModule("watch-evaluator", {
    config: { name: "watch-evaluator", intervalMs: 10_000, startActive: true, description: "Evaluates registered watches against new events, fires actions" },
    factory: () => createWatchEvaluatorModule(),
  });

  registerBuiltInModule("module-sync", {
    config: { name: "module-sync", intervalMs: 30_000, startActive: true, description: "Hot-reload markdown modules" },
    factory: (deps) => createModuleSyncModule(deps.orchestrator, deps.workspacePath),
  });

  // Generic reactive chat module. Deployments that want custom behaviour
  // (triage, retry, special protocols) re-register "conversation" in
  // their workspace/extensions/modules.ts with their own factory; last
  // registration wins.
  registerBuiltInModule("conversation", {
    config: { name: "conversation", intervalMs: 500, startActive: true },
    factory: (deps) => createChatReactor(deps.chatAdapter!, deps.workspacePath),
    requires: ["chatAdapter"],
    note: "Reactive chat reactor (framework default)",
  });
}
