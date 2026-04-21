/**
 * Community deployment wiring.
 *
 * Called once at startup with the framework's deps. Use for:
 *   - Attaching a memory enricher (per-person blocks, alias resolution).
 *   - Registering deployment-specific code-driven modules (if any beyond
 *     the markdown agent modules in workspace/modules/).
 *
 * This community starter has no custom services by default — the
 * cognitive markdown modules (thinking/desire/etc.) and the framework
 * chat-reactor cover the baseline. Swap in your own conversation
 * service (like Feÿ does) if you need triage/retry/nudge protocols:
 *
 *   import { createConversationModule } from "../services/conversation/index.js";
 *   registerBuiltInModule("conversation", {
 *     config: { name: "conversation", intervalMs: 500, startActive: true },
 *     factory: (d) => createConversationModule(d.chatAdapter!),
 *     requires: ["chatAdapter"],
 *   });
 */

import type { MemoryManager } from "../../../../src/memory/manager.js";
import type { ChatAdapter } from "../../../../src/adapters/chat/types.js";

export interface WorkspaceModulesDeps {
  memory: MemoryManager;
  chatAdapter?: ChatAdapter;
  workspacePath: string;
  [key: string]: unknown;
}

export default function setup(_deps: WorkspaceModulesDeps): unknown[] {
  // Add your deployment wiring here. Examples:
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
  //
  // 3. Configure a deployment-specific service URL (e.g. a weather API
  //    that a custom helper reads):
  //    configureMyService({ apiKey: _deps.services?.myapi?.apiKey });

  return [];
}
