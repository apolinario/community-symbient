/**
 * Module Orchestrator — registers modules, runs them concurrently as async
 * loops, and coordinates between them via the MQTT bus + shared markdown
 * memory. Each module gets its own MessageClient and its own first-cycle
 * timing (timer-based by default, MQTT-triggered for `follows:`-modules).
 */

import type {
  ModuleConfig,
  ModuleFunction,
  ModuleContext,
  ModuleHandle,
  SymbientConfig,
  MemoryAccess,
} from "./types.js";
import { MQTTBus } from "./mqtt-bus.js";
import { createLLMClient } from "./llm.js";
import { createLogger } from "./logger.js";

const orchLog = createLogger("orchestrator");

export class Orchestrator {
  private modules = new Map<string, RegisteredModule>();
  private running = false;
  private abortController = new AbortController();

  private piModel: any = null;
  private piTools: any[] = [];
  private piApiKey: string = "dummy";

  constructor(
    private config: SymbientConfig,
    private memory: MemoryAccess,
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
    orchLog.info(`MCP tools refreshed: ${newMcpTools.map((t: { name: string }) => t.name).join(", ")}`);
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
    orchLog.info("Stopping...");
    this.abortController.abort();
  }

  private async runModule(
    name: string,
    mod: RegisteredModule,
    signal: AbortSignal,
  ): Promise<void> {
    const modLog = createLogger(name);
    // Bind a per-module LLM client. mod.config.model overrides config.llm.model
    // when set; createLLMClient then honours per-call overrides on top of that.
    const llmConfig = mod.config.model
      ? { ...this.config.llm, model: mod.config.model }
      : this.config.llm;
    const llm = createLLMClient(llmConfig);

    const ctx: ModuleContext = {
      config: mod.config,
      memory: this.memory,
      messages: this.bus.clientFor(name),
      llm,
      model: this.piModel,
      tools: this.piTools,
      apiKey: this.piApiKey,
      log: (msg: string) => modLog.info(msg),
      logDebug: (msg: string) => modLog.debug(msg),
      signal,
    };

    modLog.info(`Started (interval: ${mod.config.intervalMs}ms, active: ${mod.active}${mod.config.follows ? `, follows: ${mod.config.follows}` : ""})`);

    // Follow-up modules: wait for MQTT trigger instead of timer
    if (mod.config.follows) {
      while (!signal.aborted) {
        await this.bus.waitForMessage(name);
        if (signal.aborted) break;
        if (!mod.active) continue;
        try {
          mod.lastRun = new Date();
          await mod.fn(ctx);
        } catch (err) {
          modLog.error(`Error: ${err}`);
        }
      }
      return;
    }

    // First-cycle behaviour: high-frequency modules (≤60s) run immediately
    // because they'd wake up almost at once anyway; slower modules wait
    // their first interval to avoid a startup stampede. A module can opt
    // into immediate first-run by setting `runImmediately: true` in its
    // .md frontmatter.
    const runImmediately = mod.config.runImmediately ?? mod.config.intervalMs <= 60_000;
    let firstRun = true;

    while (!signal.aborted) {
      if (!mod.active) {
        await sleep(2000, signal);
        continue;
      }

      // Delay first run for slow modules to avoid startup stampede, but
      // still wake immediately if another module nudges us.
      if (firstRun && !runImmediately) {
        firstRun = false;
        modLog.info(`First run in ${Math.round(mod.config.intervalMs / 1000)}s (or on nudge)`);
        await Promise.race([
          sleep(mod.config.intervalMs, signal),
          this.bus.waitForMessage(name),
        ]);
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

      // Notify follow-up modules via MQTT
      for (const [followName, followMod] of this.modules) {
        if (followMod.config.follows === name && followMod.active) {
          modLog.info(`Triggering follow-up: ${followName}`);
          this.bus.clientFor(name).send(followName, `triggered_by:${name}`).catch(() => {});
        }
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
