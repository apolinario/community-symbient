/**
 * Configuration loader for Feyblet.
 * Reads from config/feyblet.json or environment variables.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FeybletConfig } from "./core/types.js";

const DEFAULT_CONFIG: FeybletConfig = {
  name: "feyblet",
  workspacePath: resolve("workspace"),
  signal: {
    account: process.env.SIGNAL_ACCOUNT || "+15674026181",
    httpHost: "127.0.0.1",
    httpPort: 8080,
    dmPolicy: "open",
    groupPolicy: "open",
    allowFrom: [],
    groupAllowFrom: [],
  },
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER || "localhost",
    port: Number(process.env.MQTT_PORT) || 1883,
  },
  llm: {
    provider: (process.env.LLM_PROVIDER as "anthropic" | "openai" | "ollama") || "openai",
    model: process.env.LLM_MODEL || "qwen/qwen3.5-35b-a3b",
    tinyModel: process.env.LLM_TINY_MODEL || "qwen3.5-2b",
    tinyBaseUrl: process.env.LLM_TINY_BASE_URL || "http://localhost:1235",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: process.env.LLM_BASE_URL || "http://localhost:1234",
  },
  modules: {},
};

export async function loadConfig(): Promise<FeybletConfig> {
  const configPath = process.env.FEYBLET_CONFIG || join("config", "feyblet.json");

  let fileConfig: Partial<FeybletConfig> = {};
  try {
    const raw = await readFile(configPath, "utf-8");
    fileConfig = JSON.parse(raw);
  } catch {
    console.log(`No config file at ${configPath}, using defaults + env vars.`);
  }

  return deepMerge(DEFAULT_CONFIG, fileConfig) as FeybletConfig;
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
