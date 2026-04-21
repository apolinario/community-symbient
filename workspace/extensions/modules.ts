/**
 * Feÿ deployment wiring.
 *
 * The framework calls this default export at startup with the full deps
 * object. Responsibilities:
 *
 *   1. Attach the memory enricher (per-person blocks).
 *   2. Configure context providers (house-status, sauna, etc.) with the
 *      FeyOps DB so they can look up booking data.
 *   3. Register deployment-specific code-driven modules — conversation,
 *      sauna, bookings, people-sync, onboarding, radio-calendar — with
 *      the built-in module registry. After registration they appear in
 *      listBuiltInModules() and run like framework modules.
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
import { createConversationModule } from "../services/conversation/index.js";
import { createSaunaModule } from "../services/sauna/index.js";
import { createBookingsModule } from "../services/bookings/index.js";
import { createPeopleSyncModule } from "../services/people-sync/index.js";
import { createOnboardingModule } from "../services/onboarding/index.js";
import { createRadioModule } from "../services/radio/index.js";

export interface WorkspaceModulesDeps {
  memory: MemoryManager;
  directory?: Directory;
  chatAdapter?: ChatAdapter;
  workspacePath: string;
  [key: string]: unknown;
}

export default function feySetup(deps: WorkspaceModulesDeps): unknown[] {
  const feyopsDb = deps.directory as unknown as FeyOpsDB | undefined;

  // --- Memory enricher + context providers that need FeyOps data ---
  if (feyopsDb) {
    deps.memory.setEnricher(createFeyEnricher({
      feyopsDb,
      workspacePath: deps.workspacePath,
    }));
    configureFeyProviders({ feyopsDb });
  }

  // --- Register deployment-specific modules ---

  registerBuiltInModule("conversation", {
    config: { name: "conversation", intervalMs: 500, startActive: true },
    factory: (d) => createConversationModule(d.chatAdapter!),
    requires: ["chatAdapter"],
    note: "Feÿ chat handler: group triage, direct-address retry, attachment processing, inter-module nudges",
  });

  registerBuiltInModule("sauna", {
    config: { name: "sauna", intervalMs: 60_000, startActive: true },
    factory: () => createSaunaModule(),
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
  });

  return [];
}
