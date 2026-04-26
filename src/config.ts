/**
 * Configuration loader.
 *
 * Reads `config/symbient.json` by default; override the path with the
 * `SYMBIENT_CONFIG` env var. Env vars override specific fields after the
 * file is loaded.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SymbientConfig } from "./core/types.js";

const DEFAULT_CONFIG: SymbientConfig = {
  name: "symbient",
  workspacePath: resolve("workspace"),
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER || "localhost",
    port: Number(process.env.MQTT_PORT) || 1883,
  },
  llm: {
    provider: (process.env.LLM_PROVIDER as "anthropic" | "openai" | "ollama") || "openai",
    model: process.env.LLM_MODEL || "qwen/qwen3.5-35b-a3b",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: process.env.LLM_BASE_URL,
    tinyModel: process.env.LLM_TINY_MODEL,
    tinyBaseUrl: process.env.LLM_TINY_BASE_URL,
  },
  services: {
    search: { url: process.env.SEARCH_URL || process.env.QMD_URL || "http://localhost:8181" },
  },
  modules: {},
};

async function readJsonIfExists(path: string): Promise<Partial<SymbientConfig> | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadConfig(): Promise<SymbientConfig> {
  // SYMBIENT_CONFIG is the canonical env var. FEYBLET_CONFIG is honoured
  // as a fallback so existing deployments keep working through the rename.
  const explicitPath = process.env.SYMBIENT_CONFIG || process.env.FEYBLET_CONFIG;
  const candidates = explicitPath
    ? [explicitPath]
    : [join("config", "symbient.json"), join("config", "feyblet.json")];

  let fileConfig: Partial<SymbientConfig> | null = null;
  let usedPath: string | null = null;
  for (const path of candidates) {
    const cfg = await readJsonIfExists(path);
    if (cfg) {
      fileConfig = cfg;
      usedPath = path;
      break;
    }
  }
  if (!fileConfig) {
    console.log(`No config file at [${candidates.join(", ")}], using defaults + env vars.`);
    fileConfig = {};
  } else if (usedPath) {
    console.log(`Loaded config from ${usedPath}`);
  }

  const merged = deepMerge(DEFAULT_CONFIG, fileConfig) as SymbientConfig;

  // Backward-compat: `config.qmd.url` was the old name for the search
  // backend URL. If only the legacy field is set, copy it over and warn.
  const services = merged.services ?? {};
  const hasSearchUrl = typeof services.search?.url === "string" && services.search.url.length > 0;
  const legacyQmdUrl = (merged.qmd as { url?: string } | undefined)?.url;
  if (!hasSearchUrl && legacyQmdUrl) {
    console.warn(`[config] 'qmd.url' is deprecated — set 'services.search.url' instead. Falling back for now.`);
    merged.services = { ...services, search: { url: legacyQmdUrl } };
  }
  // Also keep config.qmd.url populated from services.search.url so any
  // call sites still reading the legacy field continue to work for now.
  if (merged.services?.search?.url && !merged.qmd?.url) {
    merged.qmd = { url: merged.services.search.url };
  }

  return merged;
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}
