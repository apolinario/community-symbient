/**
 * Feÿ-deployment tool set — imports each tool from its service folder.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../../src/memory/manager.js";
import type { Directory } from "../../src/adapters/directory/types.js";
import type { ChatAdapter } from "../../src/adapters/chat/types.js";
import type { FeyOpsDB } from "../services/feyops/db.js";
import { createCheckSaunaTool } from "../services/sauna/tools.js";
import {
  createRadioBroadcastTool,
  createRadioScheduleTool,
  createRadioCalendarTool,
  configureRadioTools,
} from "../services/radio/tools.js";
import { createSendVoiceMessageTool } from "../services/voice/tools.js";
import {
  createLookupPersonTool,
  createCheckBookingsTool,
  createSeasonLogTool,
} from "../services/feyops/tools.js";
import { createRequestCapabilityTool } from "../services/coder/request-capability-tool.js";
import { createApproveCapabilityTool, createSkipCapabilityTool } from "../services/coder/approval-tools.js";
import { createOpenCapabilityPrTool, type CoderConfig } from "../services/coder/open-pr-tool.js";
import { createSendDMTool, createSendGroupMessageTool } from "../services/messaging/tools.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ToolDeps {
  memory: MemoryManager;
  directory?: Directory;
  chatAdapter?: ChatAdapter;
  workspacePath: string;
  services?: Record<string, { url: string } & Record<string, unknown>>;
}

export default function feyToolset(deps: ToolDeps): AgentTool[] {
  const tools: AgentTool[] = [];
  const ttsUrl = deps.services?.tts?.url as string | undefined;

  configureRadioTools({ ttsUrl, workspacePath: deps.workspacePath });

  if (ttsUrl) {
    tools.push(
      createRadioBroadcastTool(),
      createRadioScheduleTool(),
      createRadioCalendarTool(),
    );

    if (deps.chatAdapter) {
      tools.push(createSendVoiceMessageTool({
        workspacePath: deps.workspacePath,
        ttsUrl,
        chatAdapter: deps.chatAdapter,
        memory: deps.memory,
      }));
    }
  }

  tools.push(
    createCheckSaunaTool(deps.memory),
    createSeasonLogTool(deps.workspacePath),
    createRequestCapabilityTool(deps.workspacePath),
    createApproveCapabilityTool(deps.workspacePath),
    createSkipCapabilityTool(deps.workspacePath),
  );

  // Signal-flavoured DM/group tools — phone+UUID resolution and the
  // known-groups path are deployment specifics, not framework concerns.
  if (deps.chatAdapter) {
    tools.push(
      createSendDMTool({ adapter: deps.chatAdapter, memory: deps.memory, workspacePath: deps.workspacePath }),
      createSendGroupMessageTool({ adapter: deps.chatAdapter, memory: deps.memory, workspacePath: deps.workspacePath }),
    );
  }

  // Convention: workspace lives at `<project-root>/workspace`. Anchor the
  // PR tool's repo cwd + config read to that, not to whatever directory
  // the process was launched from.
  const projectRoot = dirname(deps.workspacePath);
  const coderConfig = readCoderConfig(projectRoot);
  if (coderConfig) {
    tools.push(createOpenCapabilityPrTool(deps.workspacePath, projectRoot, coderConfig));
  }

  function readCoderConfig(root: string): CoderConfig | null {
    try {
      const raw = readFileSync(join(root, "config", "feyblet.json"), "utf-8");
      const cfg = JSON.parse(raw);
      if (!cfg?.coder?.reviewer || !cfg?.coder?.repo || !cfg?.coder?.worktreeBase) return null;
      return cfg.coder as CoderConfig;
    } catch {
      return null;
    }
  }

  const feyopsDb = deps.directory as unknown as FeyOpsDB | undefined;
  if (feyopsDb?.getBookings) {
    tools.push(
      createLookupPersonTool(feyopsDb, deps.memory),
      createCheckBookingsTool(feyopsDb),
    );
  }

  return tools;
}
