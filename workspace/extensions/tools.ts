/**
 * Feÿ-deployment tool set — imports each tool from its service folder.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../../src/memory/manager.js";
import type { Directory } from "../../src/adapters/directory/types.js";
import type { FeyOpsDB } from "../services/feyops/db.js";
import { createCheckSaunaTool } from "../services/sauna/tools.js";
import {
  createRadioBroadcastTool,
  createRadioScheduleTool,
  createRadioCalendarTool,
  configureRadioTools,
} from "../services/radio/tools.js";
import {
  createLookupPersonTool,
  createCheckBookingsTool,
  createSeasonLogTool,
} from "../services/feyops/tools.js";

export interface ToolDeps {
  memory: MemoryManager;
  directory?: Directory;
  workspacePath: string;
  services?: Record<string, { url: string } & Record<string, unknown>>;
}

export default function feyToolset(deps: ToolDeps): AgentTool[] {
  const tools: AgentTool[] = [];
  const ttsUrl = deps.services?.tts?.url as string | undefined;

  configureRadioTools({ ttsUrl });

  if (ttsUrl) {
    tools.push(
      createRadioBroadcastTool(),
      createRadioScheduleTool(),
      createRadioCalendarTool(),
    );
  }

  tools.push(
    createCheckSaunaTool(deps.memory),
    createSeasonLogTool(deps.workspacePath),
  );

  const feyopsDb = deps.directory as unknown as FeyOpsDB | undefined;
  if (feyopsDb?.getBookings) {
    tools.push(
      createLookupPersonTool(feyopsDb, deps.memory),
      createCheckBookingsTool(feyopsDb),
    );
  }

  return tools;
}
