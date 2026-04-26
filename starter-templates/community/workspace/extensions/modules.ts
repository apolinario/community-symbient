/**
 * Community deployment wiring.
 *
 * Called once at startup with the framework's deps. Use for:
 *   - Attaching a memory enricher (per-person blocks, alias resolution).
 *   - Registering deployment-specific code-driven modules — anything that
 *     needs more than what a markdown agent module can express.
 *
 * This community starter ships one such module: `qmd-index`, which keeps
 * the qmd search index up to date by shelling out to the qmd CLI. Other
 * deployment-specific modules (custom conversation handler, sensors,
 * external integrations) follow the same pattern.
 */

import type { MemoryManager } from "../../../../src/memory/manager.js";
import type { ChatAdapter } from "../../../../src/adapters/chat/types.js";
import { registerBuiltInModule } from "../../../../src/core/module-factories.js";
import { createQmdIndexModule } from "../services/qmd-index/index.js";

export interface WorkspaceModulesDeps {
  memory: MemoryManager;
  chatAdapter?: ChatAdapter;
  workspacePath: string;
  [key: string]: unknown;
}

export default function setup(_deps: WorkspaceModulesDeps): unknown[] {
  // qmd-index — keeps the qmd search index in sync. Reads BUN_PATH and
  // QMD_CLI from env. Disabled (with a single warning log) if either is
  // unset — the framework's HTTP-side qmd usage still works as long as
  // the qmd daemon itself is running and pointed at by services.search.url.
  registerBuiltInModule("qmd-index", {
    config: {
      name: "qmd-index",
      intervalMs: 30_000,
      startActive: true,
      description: "qmd BM25 every 30s, vectors every 5min",
    },
    factory: () => createQmdIndexModule(),
  });

  // Add your own deployment wiring here. Examples:
  //
  // 1. Attach a memory enricher for fuzzy person-name resolution:
  //    _deps.memory.setEnricher({
  //      resolveNickname: async (name) => {
  //        // look up aliases in your own data store
  //      },
  //    });
  //
  // 2. Register a custom conversation service:
  //    import { createConversationModule } from "../services/conversation/index.js";
  //    registerBuiltInModule("conversation", { ... });

  return [];
}
