/**
 * Feÿ-deployment tool set.
 *
 * The framework ships only universal tools. Anything community-specific
 * is wired here. Each tool is registered only if the service it needs
 * is configured — so a deployment that turns off TTS simply doesn't
 * get the radio_broadcast tool.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../../src/memory/manager.js";
import type { Directory } from "../../src/adapters/directory/types.js";
import type { FeyOpsDB } from "../services/feyops/db.js";
import {
  createCheckSaunaTool,
  createRadioBroadcastTool,
  createRadioScheduleTool,
  createRadioCalendarTool,
  createLookupPersonTool,
  createCheckBookingsTool,
  createSeasonLogTool,
  configureFeyopsTools,
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
  const mcpRadio = true;   // radio MCP is added via config.mcp_servers in Feÿ

  configureFeyopsTools({ ttsUrl });

  // Radio tools — only if TTS is available (radio_broadcast needs it) AND
  // the radio MCP server is wired.
  if (ttsUrl && mcpRadio) {
    tools.push(
      createRadioBroadcastTool(),
      createRadioScheduleTool(),
      createRadioCalendarTool(),
    );
  }

  // Sauna + season-log — purely file-based, no external deps.
  tools.push(
    createCheckSaunaTool(deps.memory),
    createSeasonLogTool(deps.workspacePath),
  );

  // FeyOps PMS lookups — only if directory is a FeyOpsDB.
  const feyopsDb = deps.directory as unknown as FeyOpsDB | undefined;
  if (feyopsDb?.getBookings) {
    tools.push(
      createLookupPersonTool(feyopsDb, deps.memory),
      createCheckBookingsTool(feyopsDb),
    );
  }

  return tools;
}
