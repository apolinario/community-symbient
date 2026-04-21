/**
 * Registers all built-in modules and adapter factories.
 *
 * Called once at startup (src/index.ts). After this, `config.modules`
 * and `config.adapters.*` can reference any of these by name.
 *
 * Framework-shipped modules registered here are generic infrastructure
 * only: qmd-index, schedule-checker, watch-evaluator, module-sync,
 * and `conversation` (reactive chat handler that talks to whatever
 * ChatAdapter is configured).
 *
 * Deployment-specific modules (bookings, people-sync, onboarding,
 * sauna, radio-calendar, etc.) belong in `workspace/services/` and
 * register themselves via `workspace/extensions/modules.ts`.
 *
 * Built-in chat adapters self-register via the side-effect import below.
 */

import { registerBuiltInModule } from "./module-factories.js";
import { createQmdIndexModule } from "../sense/qmd-index.js";
import { createScheduleCheckerModule } from "../sense/schedule-checker.js";
import { createWatchEvaluatorModule } from "../sense/watch-evaluator.js";
import { createModuleSyncModule } from "./module-sync.js";

// Built-in chat adapter factories self-register on import. A deployment
// that doesn't use Signal still pays the import cost but the factory
// stays inert unless config.adapters.chat picks "signal".
import "../signal/bridge.js";

export function registerBuiltIns(): void {
  registerBuiltInModule("qmd-index", {
    config: { name: "qmd-index", intervalMs: 30_000, startActive: true, description: "qmd BM25 every 30s, vectors every 5min" },
    factory: () => createQmdIndexModule(),
  });

  registerBuiltInModule("schedule-checker", {
    config: { name: "schedule-checker", intervalMs: 60_000, startActive: true, description: "Checks for due scheduled items, wakes executive" },
    factory: () => createScheduleCheckerModule(),
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
