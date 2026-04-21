/**
 * Feyblet — A community symbient.
 *
 * Built on:
 * - Pi SDK (LLM, Agent, native tool calling)
 * - CMA-inspired concurrent modules (async, loosely coupled, MQTT messaging)
 * - OpenClaw-style Markdown memory (files, not vectors)
 * - Signal bridge via signal-cli
 * - qmd search for memory retrieval
 *
 * Modules are defined in workspace/modules/*.md — behavior is editable
 * without code changes. Each module gets Pi Agent capabilities with
 * a filtered set of tools based on its role.
 */

import { loadConfig } from "./config.js";
import { Orchestrator } from "./core/orchestrator.js";
import { MQTTBus } from "./core/mqtt-bus.js";
import { MemoryManager } from "./memory/manager.js";
import { SignalBridge } from "./signal/bridge.js";
import { FeyOpsDB } from "./feyops/db.js";
import { createModel, getApiKey } from "./core/pi-model.js";
import { createLLMClient } from "./core/llm.js";
import "@mariozechner/pi-ai/openai-completions";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// Tools
import {
  createLookupPersonTool,
  createSearchMemoryTool,
  createCheckBookingsTool,
  createSeasonLogTool,
  createRadioBroadcastTool,
  createRadioScheduleTool,
  createRadioCalendarTool,
  createCheckSaunaTool,
  createScheduleTool,
  createListScheduleTool,
  createCancelScheduleTool,
  createNudgeModuleTool,
  createWebSearchTool,
  createChatHistoryTool,
  createSendDMTool,
  createSendGroupMessageTool,
  createCreateModuleTool,
  createDisableModuleTool,
  createListModulesTool,
} from "./tools/index.js";
import { createSandboxedPiTools } from "./tools/pi-tools.js";
import { initMCP, onMCPReconnect } from "./mcp/bridge.js";

// Module loader + special modules
import { loadModuleConfigs } from "./modules/load-modules.js";
import { createConversationModule } from "./modules/base/conversation.js";
import { createRadioModule } from "./modules/hardware/radio.js";
import { createSaunaModule } from "./modules/hardware/sauna.js";
import { createBookingsModule } from "./modules/hardware/bookings.js";
import { createOnboardingModule } from "./modules/hardware/onboarding.js";
import { createQmdIndexModule } from "./modules/hardware/qmd-index.js";
import { createPeopleSyncModule } from "./modules/hardware/people-sync.js";
// people-enrich is now a markdown agent module (workspace/modules/people-enrich.md)
import { createScheduleCheckerModule } from "./modules/hardware/schedule-checker.js";
import { createModuleSyncModule } from "./modules/hardware/module-sync.js";
import { createMetaReport } from "./modules/meta/meta-report.js";
import { startDashboard, pushLogLine } from "./dashboard/server.js";
import { setLogSink } from "./core/logger.js";

async function main() {
  const config = await loadConfig();

  console.log(`Starting Feyblet "${config.name}"...`);
  console.log(`Workspace: ${config.workspacePath}`);

  // Pi SDK model
  const model = createModel(config.llm);
  const apiKey = getApiKey(config.llm);
  console.log(`Model: ${model.id} via ${model.provider} at ${model.baseUrl}`);

  // Tiny LLM (time parsing, temporal rewrites, image descriptions)
  const { initTinyLLM } = await import("./core/tiny-llm.js");
  initTinyLLM(config.llm.tinyBaseUrl || "http://localhost:1235", config.llm.tinyModel || "LFM2.5-VL-1.6B-Q8_0");

  // Core systems
  const memory = new MemoryManager(config.workspacePath);
  const feyopsDb = new FeyOpsDB("./data/feyops.db");
  memory.setFeyOpsDB(feyopsDb);
  memory.setSummarizer(createLLMClient(config.llm));
  console.log("FeyOps DB connected");

  // MQTT bus — created early so tools can reference it
  const bus = new MQTTBus(
    `mqtt://${config.mqtt.brokerUrl}:${config.mqtt.port}`,
    config.name,
  );

  // Signal bridge — created early so tools can reference it
  const signal = new SignalBridge(config.signal);

  // Check external services
  const WHISPER_API = process.env.WHISPER_API || "http://localhost:8001";
  try {
    const wr = await fetch(`${WHISPER_API}/v1/audio/transcriptions`, { signal: AbortSignal.timeout(3000) });
    // 405 (Method Not Allowed) means the endpoint exists but needs POST — that's fine
    console.log(`Whisper: ${wr.ok || wr.status === 405 ? "ready" : `error (${wr.status})`}`);
  } catch {
    console.log("Whisper: not available (voice messages won't be transcribed)");
  }

  // MCP servers — tools auto-discovered at startup
  const RADIO_MCP = process.env.RADIO_MCP_URL || "http://192.168.10.97:8001/mcp";
  const PHONEBOOTH_MCP = process.env.PHONEBOOTH_MCP_URL || "http://192.168.10.97:3001/mcp";
  let mcpTools = await initMCP([
    { name: "radio", url: RADIO_MCP },
    { name: "phonebooth", url: PHONEBOOTH_MCP },
  ]);

  // Pi file tools (sandboxed to workspace, write-restricted)
  const piTools = createSandboxedPiTools(config.workspacePath);
  console.log(`Pi tools: ${piTools.map(t => t.name).join(", ")}`);

  // Local tools + Pi tools + MCP tools
  const tools: AgentTool[] = [
    createLookupPersonTool(feyopsDb, memory),
    createSearchMemoryTool(),
    createCheckBookingsTool(feyopsDb),
    createSeasonLogTool(config.workspacePath),
    createRadioBroadcastTool(),
    createRadioScheduleTool(),
    createRadioCalendarTool(),
    createCheckSaunaTool(memory),
    createScheduleTool(config.workspacePath),
    createListScheduleTool(config.workspacePath),
    createCancelScheduleTool(config.workspacePath),
    createNudgeModuleTool(bus, "feyblet"),
    createWebSearchTool(),
    createChatHistoryTool(memory),
    createSendDMTool(signal, memory),
    createSendGroupMessageTool(signal, memory),
    createCreateModuleTool(config.workspacePath),
    createDisableModuleTool(config.workspacePath),
    createListModulesTool(config.workspacePath),
    ...piTools,
    ...mcpTools,
  ];
  console.log(`${tools.length} tools (${mcpTools.length} from MCP): ${tools.map(t => t.name).join(", ")}`);
  const orchestrator = new Orchestrator(config, memory, bus);
  orchestrator.setPiContext(model, tools, apiKey);

  // Auto-swap MCP tools on reconnect
  onMCPReconnect((newTools) => {
    orchestrator.replaceMCPTools(mcpTools, newTools);
    mcpTools = newTools;
  });

  // --- Hardware modules (code-driven, not markdown) ---

  orchestrator.register(
    { name: "sauna", intervalMs: 60_000, startActive: true },
    createSaunaModule(),
  );

  orchestrator.register(
    { name: "bookings", intervalMs: 30 * 60_000, startActive: true, description: "FeyOps arrivals/departures" },
    createBookingsModule(feyopsDb),
  );

  orchestrator.register(
    { name: "onboarding", intervalMs: 24 * 60 * 60_000, startActive: false, description: "Welcome/goodbye DMs (disabled)" },
    createOnboardingModule(feyopsDb, signal),
  );

  orchestrator.register(
    { name: "qmd-index", intervalMs: 30_000, startActive: true, description: "qmd BM25 every 30s, vectors every 5min" },
    createQmdIndexModule(),
  );

  orchestrator.register(
    { name: "people-sync", intervalMs: 30 * 60_000, startActive: true, description: "Create/enrich person files from bookings + messages" },
    createPeopleSyncModule(feyopsDb, memory),
  );


  orchestrator.register(
    { name: "schedule-checker", intervalMs: 60_000, startActive: true, description: "Checks for due scheduled items, wakes executive" },
    createScheduleCheckerModule(),
  );

  orchestrator.register(
    { name: "module-sync", intervalMs: 30_000, startActive: true, description: "Hot-reload markdown modules" },
    createModuleSyncModule(orchestrator, config.workspacePath),
  );

  // meta-report disabled — quiet hours concept doesn't apply at the château
  // orchestrator.register(
  //   { name: "meta-report", intervalMs: 30 * 60_000, startActive: true, description: "System self-monitoring" },
  //   createMetaReport(orchestrator),
  // );

  // --- Special modules (conversation + radio need custom wiring) ---

  orchestrator.register(
    { name: "conversation", intervalMs: 500, startActive: true },
    createConversationModule(signal),
  );

  orchestrator.register(
    { name: "radio-calendar", intervalMs: 5 * 60_000, startActive: true, description: "Process scheduled radio calendar items" },
    createRadioModule(feyopsDb),
  );

  // --- Agent modules (loaded from workspace/modules/*.md) ---

  const agentModules = await loadModuleConfigs(config.workspacePath);
  for (const mod of agentModules) {
    orchestrator.register(mod.config, mod.fn);
    console.log(`Module loaded: ${mod.config.name} (${mod.config.intervalMs}ms)`);
  }

  // --- Dashboard + Start ---

  setLogSink(pushLogLine);
  startDashboard(orchestrator, memory);

  await bus.connect();
  await signal.start();
  console.log("All systems ready. Feyblet is alive.\n");
  await orchestrator.start();
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
