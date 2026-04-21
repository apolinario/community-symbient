/**
 * Feÿ-deployment tool set.
 *
 * The framework ships only universal tools (search, schedule, watch,
 * nudge, chat send/receive, etc.). Anything community-specific — Feÿ's
 * FM radio broadcast, Google-Sheets sauna, FeyOps PMS lookups, season
 * log — is wired here.
 *
 * A different deployment writes its own tools.ts without any of this.
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
} from "../services/feyops/tools.js";

export interface ToolDeps {
  memory: MemoryManager;
  directory?: Directory;
  workspacePath: string;
}

export default function feyToolset(deps: ToolDeps): AgentTool[] {
  const tools: AgentTool[] = [];

  // Radio (FM broadcast via Radio MCP).
  tools.push(
    createRadioBroadcastTool(),
    createRadioScheduleTool(),
    createRadioCalendarTool(),
  );

  // Google-Sheets sauna readout (parsed from today's daily log).
  tools.push(createCheckSaunaTool(deps.memory));

  // Feÿ season log (workspace/season/*.md).
  tools.push(createSeasonLogTool(deps.workspacePath));

  // FeyOps PMS lookups — directory is a Directory but in practice the
  // feyops adapter returns a FeyOpsDB instance with the rich API. Cast
  // back to that type when present.
  const feyopsDb = deps.directory as unknown as FeyOpsDB | undefined;
  if (feyopsDb?.getBookings) {
    tools.push(
      createLookupPersonTool(feyopsDb, deps.memory),
      createCheckBookingsTool(feyopsDb),
    );
  }

  return tools;
}
