/**
 * Symbient framework — concurrent modular agent runtime.
 *
 * Built on:
 * - Pi SDK (LLM, Agent, native tool calling)
 * - Concurrent modules (async, loosely coupled, MQTT messaging)
 * - Markdown memory (files, not vectors)
 * - qmd search for memory retrieval
 * - Pluggable chat adapters (Signal built in; Matrix/Discord/etc. via extensions)
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
  createCreateModuleTool,
  createDisableModuleTool,
  createListModulesTool,
  createRegisterWatchTool,
  createListWatchesTool,
  createCancelWatchTool,
  configureToolServices,
} from "./tools/index.js";
import { createSandboxedPiTools } from "./tools/pi-tools.js";
import { initMCP, onMCPReconnect } from "./mcp/bridge.js";

// Module loader + registries
import { loadModuleConfigs } from "./modules/load-modules.js";
import { loadAllExtensions, loadWorkspaceToolsFactory, loadWorkspaceModulesFactory } from "./core/extension-loader.js";
import { setEventLogWorkspace } from "./core/event-log.js";
import { setWatchesWorkspace } from "./core/watches.js";
import { setSearchBackend, createQmdHttpBackend, createLocalBm25Backend } from "./core/search.js";
import { registerBuiltIns } from "./core/register-builtins.js";
import { getBuiltInModule, listBuiltInModules, type ModuleDeps } from "./core/module-factories.js";
import { getChatAdapter, getDirectory } from "./core/adapter-registry.js";

import { startDashboard, pushLogLine } from "./dashboard/server.js";
import { setLogSink } from "./core/logger.js";

async function main() {
  const config = await loadConfig();

  const { setSymbientName } = await import("./core/symbient-name.js");
  setSymbientName(config.name);

  console.log(`Starting "${config.name}"...`);
  console.log(`Workspace: ${config.workspacePath}`);

  // Pi SDK model
  const model = createModel(config.llm);
  const apiKey = getApiKey(config.llm);
  console.log(`Model: ${model.id} via ${model.provider} at ${model.baseUrl}`);

  // Tiny LLM (time parsing, temporal rewrites, image descriptions).
  // Optional — falls back to the main LLM if tinyModel/tinyBaseUrl aren't set.
  const { initTinyLLM } = await import("./core/tiny-llm.js");
  initTinyLLM(
    config.llm.tinyBaseUrl ?? config.llm.baseUrl ?? "",
    config.llm.tinyModel ?? config.llm.model,
  );

  // Core systems
  const memory = new MemoryManager(config.workspacePath);

  // Search backend: explicit `services.search.backend` wins; otherwise
  // pick `qmd-http` when a URL is set, `local-bm25` otherwise.
  const searchCfg = (config.services?.search ?? {}) as { url?: string; backend?: string };
  const declaredBackend = searchCfg.backend;
  const backendChoice = declaredBackend
    ?? (searchCfg.url ? "qmd-http" : "local-bm25");
  if (backendChoice === "local-bm25") {
    setSearchBackend(createLocalBm25Backend(config.workspacePath));
    console.log("Search: local-bm25 (in-process, lex-only)");
  } else if (backendChoice === "qmd-http") {
    if (!searchCfg.url) {
      console.warn("Search: qmd-http selected but services.search.url is unset — search tool will return empty results");
      setSearchBackend(createQmdHttpBackend(""));
    } else {
      setSearchBackend(createQmdHttpBackend(searchCfg.url));
      console.log(`Search: qmd-http at ${searchCfg.url}`);
    }
  } else {
    console.warn(`Unknown search backend "${backendChoice}" — falling back to local-bm25`);
    setSearchBackend(createLocalBm25Backend(config.workspacePath));
  }

  // Wire framework tool service URLs + policy values.
  const searxngUrl = config.services?.searxng?.url as string | undefined;
  configureToolServices({
    searxngUrl,
    moduleManagement: config.moduleManagement,
  });

  // Wire attachment-processing service URLs (voice transcription + fetching
  // attachment binaries from the chat adapter's REST backend, if any).
  // Both optional — missing Whisper means voice messages aren't transcribed;
  // missing attachmentBaseUrl means attachment binaries can't be fetched.
  // The base URL comes from the chat adapter itself (any adapter with a
  // REST attachment endpoint implements `getAttachmentBaseUrl()`).
  const { configureAttachmentServices } = await import("./core/attachments.js");
  // chatAdapter is wired below; we delay attachment configuration until
  // after it's instantiated.

  // Register all built-in adapters + module factories, then load workspace
  // extensions (custom adapters, helpers, handlers, providers, actions,
  // sensors, directories). Both must run BEFORE config.adapters.* lookups
  // so the factory registry has everything before we try to resolve names.
  registerBuiltIns(config);
  const extensions = await loadAllExtensions(config.workspacePath);

  // Directory adapter — config-driven via the registry. Deployments
  // without a member/booking source set config.adapters.directory to null;
  // modules that declare `requires: ["directory"]` are then skipped at
  // launch time with a warning. An unknown adapter name is a config
  // error — fail loudly at startup instead of running with no directory.
  let directory: Directory | undefined;
  const dirSel = config.adapters?.directory;
  if (dirSel === null || dirSel === undefined) {
    console.log("Directory: disabled");
  } else {
    const factory = getDirectory(dirSel.adapter);
    if (!factory) {
      throw new Error(
        `Unknown directory adapter "${dirSel.adapter}" — register via workspace/extensions/adapters/directory/ or set config.adapters.directory to null.`,
      );
    }
    directory = await factory.create(dirSel.params ?? {});
    console.log(`Directory: ${dirSel.adapter}`);
  }

  // MQTT bus — created early so tools can reference it
  const bus = new MQTTBus(
    `mqtt://${config.mqtt.brokerUrl}:${config.mqtt.port}`,
    config.name,
  );

  // Chat adapter — config-driven. Set config.adapters.chat to pick a
  // transport, or `null` for CLI/headless deployments. An unknown
  // adapter name is a config error — fail loudly at startup.
  let chatAdapter: ChatAdapter | undefined;
  const chatSel = config.adapters?.chat;
  if (chatSel === null || chatSel === undefined) {
    console.log("Chat: disabled (no config.adapters.chat)");
  } else {
    const factory = getChatAdapter(chatSel.adapter);
    if (!factory) {
      throw new Error(
        `Unknown chat adapter "${chatSel.adapter}" — register via workspace/extensions/adapters/chat/ or set config.adapters.chat to null.`,
      );
    }
    chatAdapter = factory.create(chatSel.params ?? {});
    console.log(`Chat: ${chatSel.adapter}`);
  }

  configureAttachmentServices({
    whisperUrl: config.services?.whisper?.url as string | undefined,
    attachmentBaseUrl: chatAdapter?.getAttachmentBaseUrl?.() ?? undefined,
    workspacePath: config.workspacePath,
  });

  // MCP servers — declared in config.mcp_servers. Tools auto-discovered at startup.
  let mcpTools = await initMCP(config.mcp_servers ?? []);

  // Pi file tools (sandboxed to workspace, write-restricted).
  // Default writable paths: MEMORY.md + people/. Deployments add their
  // own (e.g. season/, inner/) via config.workspace.writablePaths.
  const writablePrefixes = [
    "MEMORY.md",
    "people/",
    ...(config.workspace?.writablePaths ?? []),
  ];
  const piTools = createSandboxedPiTools(config.workspacePath, writablePrefixes);
  console.log(`Pi tools: ${piTools.map(t => t.name).join(", ")}`);

  // Framework tools — universal, always available.
  const tools: AgentTool[] = [
    createSearchMemoryTool(),
    createScheduleTool(config.workspacePath),
    createListScheduleTool(config.workspacePath),
    createCancelScheduleTool(config.workspacePath),
    createNudgeModuleTool(bus, config.name),
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
  // Web search — only if a SearXNG-compatible endpoint is configured.
  if (searxngUrl) {
    tools.push(createWebSearchTool());
  }
  // Workspace tools — deployment-specific tool set (e.g. broadcast, sensors,
  // PMS lookups). Loaded from workspace/extensions/tools.{js,mjs,ts} if present.
  const workspaceTools = await loadWorkspaceToolsFactory(config.workspacePath);
  if (workspaceTools) {
    const deployToolDeps = {
      memory,
      directory,
      chatAdapter,
      workspacePath: config.workspacePath,
      services: config.services,
    };
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
    llm: createLLMClient(config.llm),
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

  // Which built-in modules to run. Either an explicit list from config or,
  // by default, every registered built-in module.
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
  startDashboard(orchestrator, memory, config.workspacePath);

  await bus.connect();
  if (chatAdapter) await chatAdapter.start();
  console.log(`All systems ready. ${config.name} is alive.\n`);
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
