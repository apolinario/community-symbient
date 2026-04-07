/**
 * Module Orchestrator — the heart of Feyblet's concurrent architecture.
 *
 * Inspired by CMA's Agent class: registers modules, runs them concurrently
 * as async loops, coordinates via MQTT messaging and shared Markdown memory.
 * Unlike CMA's ChromaDB, state is shared through filesystem (daily logs,
 * MEMORY.md, per-person files) following OpenClaw's memory philosophy.
 */

import type {
  ModuleConfig,
  ModuleFunction,
  ModuleContext,
  ModuleHandle,
  FeybletConfig,
} from "./types.js";
import { MemoryManager } from "../memory/manager.js";
import { MQTTBus } from "./mqtt-bus.js";
import { createLLMClient } from "./llm.js";
import { createLogger } from "./logger.js";

export class Orchestrator {
  private modules = new Map<string, RegisteredModule>();
  private running = false;
  private abortController = new AbortController();

  private piModel: any = null;
  private piTools: any[] = [];
  private piApiKey: string = "dummy";

  constructor(
    private config: FeybletConfig,
    private memory: MemoryManager,
    private bus: MQTTBus,
  ) {}

  /** Set Pi SDK model and tools — available to all modules via ctx */
  setPiContext(model: any, tools: any[], apiKey: string): void {
    this.piModel = model;
    this.piTools = tools;
    this.piApiKey = apiKey;
  }

  /** Replace MCP tools in the shared tools array (called on MCP reconnect). */
  replaceMCPTools(oldMcpTools: any[], newMcpTools: any[]): void {
    // Remove old MCP tools
    for (const old of oldMcpTools) {
      const idx = this.piTools.indexOf(old);
      if (idx >= 0) this.piTools.splice(idx, 1);
    }
    // Add new ones
    this.piTools.push(...newMcpTools);
    console.log(`[orchestrator] MCP tools refreshed: ${newMcpTools.map((t: any) => t.name).join(", ")}`);
  }

  register(config: ModuleConfig, fn: ModuleFunction): void {
    if (this.running) throw new Error("Cannot register modules while running");
    this.modules.set(config.name, { config, fn, active: config.startActive });
  }

  getHandle(name: string): ModuleHandle | undefined {
    const mod = this.modules.get(name);
    if (!mod) return undefined;
    return {
      config: mod.config,
      active: mod.active,
      lastRun: mod.lastRun,
      activate: () => {
        mod.active = true;
        createLogger(name).info( "activated");
      },
      deactivate: () => {
        mod.active = false;
        createLogger(name).info( "deactivated");
      },
    };
  }

  listModules(): ModuleHandle[] {
    return Array.from(this.modules.keys()).map(
      (n) => this.getHandle(n)!,
    );
  }

  async start(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const orchLog = createLogger("orchestrator");
    orchLog.info(`Starting ${this.modules.size} modules...`);

    // Launch all modules concurrently
    const tasks = Array.from(this.modules.entries()).map(
      ([name, mod]) => this.runModule(name, mod, signal),
    );

    // Wait for all to complete (they run forever until aborted)
    await Promise.allSettled(tasks);
    this.running = false;
    orchLog.info("All modules stopped.");
  }

  async stop(): Promise<void> {
    createLogger("orchestrator").info("Stopping...");
    this.abortController.abort();
  }

  private async runModule(
    name: string,
    mod: RegisteredModule,
    signal: AbortSignal,
  ): Promise<void> {
    const modLog = createLogger(name);
    const llm = createLLMClient(this.config.llm, mod.config.model);

    const ctx: ModuleContext = {
      config: mod.config,
      memory: this.memory,
      messages: this.bus.clientFor(name),
      llm,
      model: this.piModel,
      tools: this.piTools,
      apiKey: this.piApiKey,
      log: (msg: string) => modLog.info(msg),
      signal,
    };

    modLog.info(`Started (interval: ${mod.config.intervalMs}ms, active: ${mod.active})`);

    // High-frequency modules (<=60s) and bookings run immediately; others wait their interval first
    const runImmediately = mod.config.intervalMs <= 60_000 || name === "bookings" || name === "radio" || name === "radio-dj";
    let firstRun = true;

    while (!signal.aborted) {
      if (!mod.active) {
        await sleep(2000, signal);
        continue;
      }

      // Delay first run for slow modules to avoid startup stampede
      if (firstRun && !runImmediately) {
        firstRun = false;
        modLog.info(`First run in ${Math.round(mod.config.intervalMs / 1000)}s`);
        await sleep(mod.config.intervalMs, signal);
        if (signal.aborted) break;
      }
      firstRun = false;

      try {
        mod.lastRun = new Date();
        await mod.fn(ctx);
      } catch (err) {
        if (signal.aborted) break;
        modLog.error(`Error: ${err}`);
      }

      if (mod.config.intervalMs > 0) {
        // Sleep until next cycle OR an MQTT message wakes us up
        await Promise.race([
          sleep(mod.config.intervalMs, signal),
          this.bus.waitForMessage(name),
        ]);
      }
    }

    modLog.info("Stopped.");
  }

  /** Register and start a module while running (hot-reload) */
  registerLive(config: ModuleConfig, fn: ModuleFunction): void {
    if (this.modules.has(config.name)) {
      // Update existing module's config
      const existing = this.modules.get(config.name)!;
      existing.config = config;
      existing.fn = fn;
      createLogger(config.name).info("config updated (hot-reload)");
      return;
    }

    // New module — register and start immediately
    const mod: RegisteredModule = { config, fn, active: config.startActive };
    this.modules.set(config.name, mod);
    createLogger(config.name).info("registered (hot-reload)");

    if (this.running) {
      this.runModule(config.name, mod, this.abortController.signal);
    }
  }

  /** Unregister a module (it will stop on next cycle check) */
  unregister(name: string): boolean {
    const mod = this.modules.get(name);
    if (!mod) return false;
    mod.active = false;
    this.modules.delete(name);
    createLogger(name).info("unregistered");
    return true;
  }
}

interface RegisteredModule {
  config: ModuleConfig;
  fn: ModuleFunction;
  active: boolean;
  lastRun?: Date;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
