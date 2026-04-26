/**
 * Registers framework-internal built-in modules.
 *
 * Called once at startup. Framework-shipped modules are generic
 * infrastructure only — schedule-checker, watch-evaluator, module-sync.
 * Deployment-specific modules (including the chat handler) register from
 * `workspace/extensions/modules.ts`. Whichever module the deployment
 * registers with `role: "chat-handler"` becomes the recipient of
 * inbound chat messages, watch-driven dm/group actions, and the default
 * target for scheduled actions.
 *
 * Built-in chat adapters self-register via the side-effect import below.
 */

import { registerBuiltInModule } from "./module-factories.js";
import { createScheduleCheckerModule } from "../sense/schedule-checker.js";
import { createWatchEvaluatorModule } from "../sense/watch-evaluator.js";
import { createModuleSyncModule } from "./module-sync.js";
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
}
