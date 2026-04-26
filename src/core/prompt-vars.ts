/**
 * Prompt Vars — helper registry for Handlebars prompt templates.
 *
 * Framework built-in helpers register here at module load. Deployments can
 * add their own via `workspace/extensions/helpers.{js,mjs,ts}` — see
 * extension-loader.ts. Deployment helpers may shadow built-ins by name.
 *
 * Helpers are plain functions. They receive the calling module's ctx as
 * their first argument (undefined if called outside a module cycle) plus
 * any Handlebars block-call args. Return value is coerced to string by
 * Handlebars at render time.
 *
 * To use the registry: call `standardVars(ctx)` to resolve all registered
 * helpers against the current ctx and get a `{name: value}` object for
 * Handlebars. Or pass specific values directly to `render()`.
 */

import type { ModuleContext } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("prompt-vars");

export type HelperFn = (ctx?: ModuleContext, ...args: unknown[]) => unknown | Promise<unknown>;

const registry = new Map<string, HelperFn>();

export function registerHelper(name: string, fn: HelperFn): void {
  registry.set(name, fn);
}

export function getHelper(name: string): HelperFn | undefined {
  return registry.get(name);
}

export function listHelpers(): string[] {
  return [...registry.keys()];
}

export function clearHelpers(): void {
  registry.clear();
  registerBuiltInHelpers();
}

// --- Built-in helpers ---

function registerBuiltInHelpers(): void {
  // Time
  registerHelper("currentTime", () =>
    new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
  );
  registerHelper("currentDate", () =>
    new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  );
  registerHelper("currentDateTime", () => {
    const date = new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return `${date}, ${time}`;
  });
  registerHelper("dayOfWeek", () =>
    new Date().toLocaleDateString("en-GB", { weekday: "long" }),
  );

  // Memory wrappers — universal, deployment-agnostic.
  registerHelper("memoryContext", async (ctx) => {
    if (!ctx) return "";
    return await ctx.memory.assembleContext();
  });
  registerHelper("soul", async (ctx) => {
    if (!ctx) return "";
    return (await ctx.memory.readSoul()) ?? "";
  });
}

registerBuiltInHelpers();

// --- Convenience: resolve all helpers against ctx into a flat object ---

/**
 * Resolve every registered helper with the given ctx and return a flat
 * object suitable for passing to `render()` as Handlebars variables.
 *
 * Any `extras` override registered helpers of the same name.
 */
export async function standardVars(
  ctx: ModuleContext | undefined,
  extras: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const vars: Record<string, unknown> = {};
  for (const [name, fn] of registry) {
    try {
      vars[name] = await fn(ctx);
    } catch (err) {
      log.warn(`helper '${name}' failed: ${(err as Error)?.message ?? err}`);
      vars[name] = "";
    }
  }
  return { ...vars, ...extras };
}
