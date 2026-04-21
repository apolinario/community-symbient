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
import { createModel, getApiKey } from "./core/pi-model.js";
import { createLLMClient } from "./core/llm.js";
import "@mariozechner/pi-ai/openai-completions";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ChatAdapter } from "./adapters/chat/types.js";
import type { Directory } from "./adapters/directory/types.js";

// Tools
import {
  createSearchMemoryTool,
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
  createRegisterWatchTool,
  createListWatchesTool,
  createCancelWatchTool,
} from "./tools/index.js";
import { createSandboxedPiTools } from "./tools/pi-tools.js";
import { initMCP, onMCPReconnect } from "./mcp/bridge.js";

// Module loader + registries
import { loadModuleConfigs } from "./modules/load-modules.js";
import { loadAllExtensions, loadWorkspaceToolsFactory, loadWorkspaceModulesFactory } from "./core/extension-loader.js";
import { setEventLogWorkspace } from "./core/event-log.js";
import { setWatchesWorkspace } from "./core/watches.js";
import { registerBuiltIns } from "./core/register-builtins.js";
import { getBuiltInModule, listBuiltInModules, type ModuleDeps } from "./core/module-factories.js";
import { getChatAdapter, getDirectory } from "./core/adapter-registry.js";

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
  memory.setSummarizer(createLLMClient(config.llm));

  // Register all built-in adapters + module factories, then load workspace
  // extensions (custom adapters, helpers, handlers, providers, actions,
  // sensors, directories). Both must run BEFORE config.adapters.* lookups
  // so the factory registry has everything before we try to resolve names.
  registerBuiltIns();
  const extensions = await loadAllExtensions(config.workspacePath);

  // Directory adapter — config-driven via the registry. Deployments
  // without a member/booking source set config.adapters.directory to null;
  // the framework then skips modules that require it (bookings, onboarding,
  // people-sync, radio-calendar).
  let directory: Directory | undefined;
  const dirSel = config.adapters?.directory;
  if (dirSel === null || dirSel === undefined) {
    console.log("Directory: disabled");
  } else {
    const factory = getDirectory(dirSel.adapter);
    if (!factory) {
      console.error(`Unknown directory adapter "${dirSel.adapter}" — register via workspace/extensions/adapters/directory/`);
    } else {
      directory = await factory.create(dirSel.params ?? {});
      console.log(`Directory: ${dirSel.adapter}`);
    }
  }

  // MQTT bus — created early so tools can reference it
  const bus = new MQTTBus(
    `mqtt://${config.mqtt.brokerUrl}:${config.mqtt.port}`,
    config.name,
  );

  // Chat adapter — config-driven. Default (Feÿ legacy) is the built-in Signal
  // factory with `config.signal`. Non-Signal deployments set config.adapters.chat
  // to a different adapter, or `null` for CLI/headless deployments.
  let chatAdapter: ChatAdapter | undefined;
  const chatSel = config.adapters?.chat;
  if (chatSel === null || chatSel === undefined) {
    console.log("Chat: disabled (no config.adapters.chat)");
  } else {
    const factory = getChatAdapter(chatSel.adapter);
    if (!factory) {
      console.error(`Unknown chat adapter "${chatSel.adapter}" — register via workspace/extensions/adapters/chat/`);
    } else {
      chatAdapter = factory.create(chatSel.params ?? {});
      console.log(`Chat: ${chatSel.adapter}`);
    }
  }

  // Check external services
  const WHISPER_API = process.env.WHISPER_API || "http://localhost:8001";
  try {
    const wr = await fetch(`${WHISPER_API}/v1/audio/transcriptions`, { signal: AbortSignal.timeout(3000) });
    // 405 (Method Not Allowed) means the endpoint exists but needs POST — that's fine
    console.log(`Whisper: ${wr.ok || wr.status === 405 ? "ready" : `error (${wr.status})`}`);
  } catch {
    console.log("Whisper: not available (voice messages won't be transcribed)");
  }

  // MCP servers — declared in config.mcp_servers. Tools auto-discovered at startup.
  let mcpTools = await initMCP(config.mcp_servers ?? []);

  // Pi file tools (sandboxed to workspace, write-restricted)
  const piTools = createSandboxedPiTools(config.workspacePath);
  console.log(`Pi tools: ${piTools.map(t => t.name).join(", ")}`);

  // Framework tools — universal, always available.
  const tools: AgentTool[] = [
    createSearchMemoryTool(),
    createScheduleTool(config.workspacePath),
    createListScheduleTool(config.workspacePath),
    createCancelScheduleTool(config.workspacePath),
    createNudgeModuleTool(bus, config.name),
    createWebSearchTool(),
    createChatHistoryTool(memory),
    createCreateModuleTool(config.workspacePath),
    createDisableModuleTool(config.workspacePath),
    createListModulesTool(config.workspacePath),
    createRegisterWatchTool(config.name),
    createListWatchesTool(),
    createCancelWatchTool(),
    ...piTools,
    ...mcpTools,
  ];
  // Chat tools — only if a chat adapter is wired.
  if (chatAdapter) {
    tools.push(
      createSendDMTool(chatAdapter, memory),
      createSendGroupMessageTool(chatAdapter, memory),
    );
  }
  // Workspace tools — deployment-specific (Feÿ's radio_broadcast, check_sauna, etc.).
  // Loaded from workspace/extensions/tools.{js,mjs,ts} if present.
  const workspaceTools = await loadWorkspaceToolsFactory(config.workspacePath);
  if (workspaceTools) {
    const deployToolDeps = { memory, directory, chatAdapter, workspacePath: config.workspacePath };
    const deployTools = workspaceTools(deployToolDeps) as AgentTool[];
    tools.push(...deployTools);
    console.log(`Workspace tools: ${deployTools.map((t) => t.name).join(", ")}`);
  }
  console.log(`${tools.length} tools (${mcpTools.length} from MCP): ${tools.map(t => t.name).join(", ")}`);
  const orchestrator = new Orchestrator(config, memory, bus);
  orchestrator.setPiContext(model, tools, apiKey);

  // Auto-swap MCP tools on reconnect
  onMCPReconnect((newTools) => {
    orchestrator.replaceMCPTools(mcpTools, newTools);
    mcpTools = newTools;
  });

  // --- Event log + watches (stateful singletons; set before modules start) ---

  setEventLogWorkspace(config.workspacePath);
  setWatchesWorkspace(config.workspacePath);

  // Deps passed to each factory. Factories whose `requires` aren't
  // satisfied (e.g. a module that needs chatAdapter when none is wired)
  // are skipped below with a warning.
  const deps: ModuleDeps = {
    memory,
    workspacePath: config.workspacePath,
    bus,
    orchestrator,
    chatAdapter,
    directory,
  };

  // --- Workspace deployment wiring ---
  // Invoke workspace/extensions/modules.ts if present. It can attach an
  // enricher to memory, register custom modules, etc.
  const workspaceModulesFactory = await loadWorkspaceModulesFactory(config.workspacePath);
  if (workspaceModulesFactory) {
    try {
      workspaceModulesFactory(deps);
      console.log("Workspace setup: applied");
    } catch (err) {
      console.error(`Workspace setup failed: ${err}`);
    }
  }

  // Which built-in modules to run. If config.enabled_modules is set, use
  // that list; else default to every registered built-in (current Feÿ behavior).
  const enabled = config.enabled_modules ?? listBuiltInModules();

  for (const name of enabled) {
    const mod = getBuiltInModule(name);
    if (!mod) {
      console.warn(`Unknown built-in module "${name}" — skipping`);
      continue;
    }
    const missing = (mod.requires ?? []).filter((r) => !deps[r]);
    if (missing.length > 0) {
      console.warn(`Module "${name}" skipped: missing deps [${missing.join(", ")}]`);
      continue;
    }
    orchestrator.register(mod.config, mod.factory(deps));
  }

  // --- Log what workspace extensions registered earlier ---

  if (extensions.helpers.length > 0) {
    console.log(`Workspace helpers: ${extensions.helpers.join(", ")}`);
  }
  if (extensions.handlers.length > 0) {
    console.log(`Workspace handlers: ${extensions.handlers.join(", ")}`);
  }
  if (extensions.providers.length > 0) {
    console.log(`Workspace providers: ${extensions.providers.join(", ")}`);
  }
  if (extensions.actions.length > 0) {
    console.log(`Workspace actions: ${extensions.actions.join(", ")}`);
  }
  if (extensions.chatAdapters.length > 0) {
    console.log(`Workspace chat adapters: ${extensions.chatAdapters.join(", ")}`);
  }
  if (extensions.sensors.length > 0) {
    console.log(`Workspace sensors: ${extensions.sensors.join(", ")}`);
  }
  if (extensions.directories.length > 0) {
    console.log(`Workspace directories: ${extensions.directories.join(", ")}`);
  }

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
  if (chatAdapter) await chatAdapter.start();
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
