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
import { createModel, getApiKey } from "./pi-model.js";
import { createLogger } from "./logger.js";
import { Cron } from "croner";

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

  /**
   * Expose the Pi context so non-module consumers (workspace services,
   * dashboard endpoints, etc.) can spawn their own Pi Agents with the
   * same tools, model, and credentials the modules use. The tools array
   * is shared by reference — MCP reconnects mutate it in place, so
   * callers see the latest tool list automatically.
   */
  getPiContext(): { model: any; tools: any[]; apiKey: string } {
    return { model: this.piModel, tools: this.piTools, apiKey: this.piApiKey };
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
    // Per-module LLM override: `llm:` (endpoint object) and/or `model:`
    // (shorthand) from the module config merge over config.llm, and apply
    // to BOTH the text-completion client and the tool-calling Agent model.
    const override = mod.config.llm || mod.config.model
      ? { ...this.config.llm, ...(mod.config.llm ?? {}), ...(mod.config.model ? { model: mod.config.model } : {}) }
      : null;
    const llm = createLLMClient(override ?? this.config.llm);

    const ctx: ModuleContext = {
      config: mod.config,
      memory: this.memory,
      messages: this.bus.clientFor(name),
      llm,
      model: override ? createModel(override) : this.piModel,
      tools: this.piTools,
      apiKey: override ? getApiKey(override) : this.piApiKey,
      log: (msg: string) => modLog.info(msg),
      logDebug: (msg: string) => modLog.debug(msg),
      signal,
    };

    modLog.info(`Started (${mod.config.cron ? `cron: "${mod.config.cron}"` : `interval: ${mod.config.intervalMs}ms`}, active: ${mod.active}${mod.config.follows ? `, follows: ${mod.config.follows}` : ""})`);

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
    // their first interval to avoid a startup stampede. Cron-driven modules
    // never run immediately by default — the cron expression IS the schedule,
    // running at startup would defeat the point of "exactly at this time."
    // Any module can opt in/out via `runImmediately` in frontmatter.
    const runImmediately = mod.config.runImmediately ?? (!mod.config.cron && mod.config.intervalMs <= 60_000);
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
        const sleepMs = nextSleepMs(mod.config);
        modLog.info(`First run in ${Math.round(sleepMs / 1000)}s (or on nudge)`);
        await Promise.race([
          sleep(sleepMs, signal),
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

      if (mod.config.intervalMs > 0 || mod.config.cron) {
        // Sleep until next cycle OR an MQTT message wakes us up. With cron
        // set, "next cycle" is the cron's next-fire-time; otherwise it's
        // intervalMs from now.
        await Promise.race([
          sleep(nextSleepMs(mod.config), signal),
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

/**
 * How long to sleep before the next cycle. If `cron` is set, that's the
 * schedule — sleep until the cron's next-fire-time. Otherwise sleep
 * `intervalMs`. A malformed cron string logs once and falls through to
 * intervalMs so the module isn't permanently wedged by a typo.
 */
function nextSleepMs(config: ModuleConfig): number {
  if (!config.cron) return config.intervalMs;
  try {
    const next = new Cron(config.cron).nextRun();
    if (next) return Math.max(0, next.getTime() - Date.now());
  } catch (err) {
    orchLog.warn(`Module ${config.name}: invalid cron "${config.cron}" (${(err as Error).message}); falling back to interval`);
  }
  return config.intervalMs;
}
