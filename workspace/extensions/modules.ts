/**
 * Feÿ deployment wiring.
 *
 * The framework calls this default export at startup with the full deps
 * object. Two responsibilities:
 *
 *   1. Side-effect setup for this deployment — attach the memory
 *      enricher that produces <house-status>, <sauna>, <season-today>,
 *      <current-meal>, <recent-broadcasts> during context assembly.
 *
 *   2. Register Feÿ-specific code-driven modules (bookings, people-sync,
 *      onboarding, sauna, radio-calendar) with the built-in module
 *      registry. After registration, they appear in listBuiltInModules()
 *      and run like framework modules — but their code lives here in
 *      the deployment, not in src/.
 *
 * Another community writes their own `modules.ts` with their own wiring.
 */

import type { MemoryManager } from "../../src/memory/manager.js";
import type { Directory } from "../../src/adapters/directory/types.js";
import type { ChatAdapter } from "../../src/adapters/chat/types.js";
import { registerBuiltInModule } from "../../src/core/module-factories.js";
import type { FeyOpsDB } from "../services/feyops/db.js";
import { createFeyEnricher } from "../services/feyops/enricher.js";
import { configureFeyProviders } from "./providers.js";
import { createSaunaModule } from "../services/feyops/sauna.js";
import { createBookingsModule } from "../services/feyops/bookings.js";
import { createPeopleSyncModule } from "../services/feyops/people-sync.js";
import { createOnboardingModule } from "../services/feyops/onboarding.js";
import { createRadioModule } from "../services/feyops/radio-calendar.js";

export interface WorkspaceModulesDeps {
  memory: MemoryManager;
  directory?: Directory;
  chatAdapter?: ChatAdapter;
  workspacePath: string;
  [key: string]: unknown;
}

export default function feySetup(deps: WorkspaceModulesDeps): unknown[] {
  // The feyops directory adapter returns a concrete FeyOpsDB; deployment
  // code is allowed to know that shape and cast.
  const feyopsDb = deps.directory as unknown as FeyOpsDB | undefined;

  // --- Memory enricher (only per-person blocks — booking context + nicknames) ---
  if (feyopsDb) {
    deps.memory.setEnricher(createFeyEnricher({
      feyopsDb,
      workspacePath: deps.workspacePath,
    }));
    // Wire the deployment providers so house-status/sauna/etc. can look up
    // the FeyOps DB when invoked from a module's seed-prompt assembly.
    configureFeyProviders({ feyopsDb });
  }

  // --- Deployment-specific modules ---
  // Register each against the shared built-in registry. `requires` ensures
  // they're skipped if the deployment wasn't configured with the right deps
  // (though in a Feÿ install all deps are present).

  registerBuiltInModule("sauna", {
    config: { name: "sauna", intervalMs: 60_000, startActive: true },
    factory: () => createSaunaModule(),
    note: "Google Sheets temperature sensor (Feÿ)",
  });

  registerBuiltInModule("bookings", {
    config: { name: "bookings", intervalMs: 30 * 60_000, startActive: true, description: "FeyOps arrivals/departures" },
    factory: (d) => createBookingsModule(d.directory as unknown as FeyOpsDB),
    requires: ["directory"],
  });

  registerBuiltInModule("people-sync", {
    config: { name: "people-sync", intervalMs: 30 * 60_000, startActive: true, description: "Create/enrich person files from bookings + messages" },
    factory: (d) => createPeopleSyncModule(d.directory as unknown as FeyOpsDB, d.memory),
    requires: ["directory"],
  });

  registerBuiltInModule("onboarding", {
    config: { name: "onboarding", intervalMs: 24 * 60 * 60_000, startActive: false, description: "Welcome/goodbye DMs" },
    factory: (d) => createOnboardingModule(d.directory as unknown as FeyOpsDB, d.chatAdapter!),
    requires: ["directory", "chatAdapter"],
  });

  registerBuiltInModule("radio-calendar", {
    config: { name: "radio-calendar", intervalMs: 5 * 60_000, startActive: true, description: "Process scheduled radio calendar items" },
    factory: () => createRadioModule(),
    note: "Reads workspace/radio/calendar.json",
  });

  return [];
}
