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
import type { Orchestrator } from "../../src/core/orchestrator.js";
import {
  registerBuiltInModule,
  loadWatches,
  addWatch,
  createLLMClient,
  type Directory,
  type ChatAdapter,
} from "../../src/core/extensions-api.js";
import type { FeyOpsDB } from "../services/feyops/db.js";
import { createFeyEnricher } from "../services/feyops/enricher.js";
import { configureFeyProviders } from "./providers.js";
import { createConversationModule } from "../services/conversation/index.js";
import { createSaunaModule } from "../services/sauna/index.js";
import { createBookingsModule } from "../services/bookings/index.js";
import { createPeopleSyncModule } from "../services/people-sync/index.js";
import { createOnboardingModule } from "../services/onboarding/index.js";
import { createRadioModule } from "../services/radio/index.js";
import { createQmdIndexModule } from "../services/qmd-index/index.js";
import { attachDailySummarizer } from "./memory-hooks.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface WorkspaceModulesDeps {
  memory: MemoryManager;
  directory?: Directory;
  chatAdapter?: ChatAdapter;
  workspacePath: string;
  llm: ReturnType<typeof createLLMClient>;
  orchestrator: Orchestrator;
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

  // --- Memory append-listener: rebuild daily summaries via LLM ---
  attachDailySummarizer(deps.memory, deps.llm);

  // --- Register deployment-specific modules ---

  registerBuiltInModule("conversation", {
    config: { name: "conversation", intervalMs: 500, startActive: true },
    factory: (d) => createConversationModule(d.chatAdapter!, d.workspacePath),
    requires: ["chatAdapter"],
    role: "chat-handler",
    note: "Feÿ chat handler: group triage, direct-address retry, attachment processing, inter-module nudges",
  });

  registerBuiltInModule("sauna", {
    config: { name: "sauna", intervalMs: 60_000, startActive: true },
    factory: () => createSaunaModule(),
  });

  registerBuiltInModule("bookings", {
    config: { name: "bookings", intervalMs: 30 * 60_000, startActive: true, runImmediately: true, description: "FeyOps arrivals/departures" },
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

  // qmd-index: optional. Requires QMD_CLI + BUN_PATH env vars pointing at
  // the qmd CLI bundle and the bun runtime. No fallbacks — paths are
  // deployment-machine-specific and silently broken defaults (one operator's
  // /home/plantoidz/... layout) leak the prior local-only assumption.
  const bunPath = process.env.BUN_PATH;
  const qmdCli = process.env.QMD_CLI;
  if (bunPath && qmdCli) {
    registerBuiltInModule("qmd-index", {
      config: { name: "qmd-index", intervalMs: 30_000, startActive: true, description: "qmd BM25 every 30s, vectors every 5min" },
      factory: () => createQmdIndexModule({ bunPath, cliPath: qmdCli }),
    });
  } else {
    console.log("[modules] qmd-index skipped: set BUN_PATH and QMD_CLI to enable.");
  }

  ensureCoderWatches(deps.workspacePath).catch((err) => console.error(`coder watch registration failed: ${err}`));

  return [];
}

async function ensureCoderWatches(workspacePath: string): Promise<void> {
  // Convention: workspace lives at `<project-root>/workspace`, so the
  // project's config dir is the workspace's parent + "config". No cwd
  // dependence — works regardless of where the process was launched.
  const projectRoot = dirname(workspacePath);
  const raw = await readFile(join(projectRoot, "config", "feyblet.json"), "utf-8").catch(() => null);
  if (!raw) return;
  let cfg: { coder?: { reviewer?: string } } | null = null;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    console.warn(`[ensureCoderWatches] failed to parse config/feyblet.json: ${(err as Error).message}`);
    return;
  }
  const reviewer = cfg?.coder?.reviewer;
  if (!reviewer) return;

  const existing = await loadWatches();

  if (!existing.some((w) => w.id === "coder-capability-gap-dm")) {
    await addWatch({
      id: "coder-capability-gap-dm",
      on: { type: "capability_gap", trigger: "always" },
      action: {
        kind: "dm",
        to: reviewer,
        intent: "review a new capability gap the symbient just filed — details are in the pending-capability-gaps context; reply naturally to approve or decline",
      },
      created_by: "workspace-setup",
      description: "DM reviewer when request_capability files a new gap",
    });
  }

}
