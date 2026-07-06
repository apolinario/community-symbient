/**
 * Pi SDK model configuration.
 *
 * Builds the Model for whatever endpoint the deployment points at. A
 * provider the Pi SDK knows (anthropic, openai, ...) with no baseUrl
 * resolves from the SDK model registry — correct API kind, cost, and
 * context window. Everything else is treated as an OpenAI-compatible
 * endpoint (llama.cpp, LM Studio, Ollama, vLLM, or any compat proxy).
 */

import { getEnvApiKey, getModel, type Api, type Model } from "@mariozechner/pi-ai";
import "@mariozechner/pi-ai/openai-completions";
import "@mariozechner/pi-ai/anthropic";
import "@mariozechner/pi-ai/openai-responses";

export interface LlmEndpointConfig {
  provider: string;
  model: string;
  apiKey?: string;
  /** Env var holding the API key, e.g. "ANTHROPIC_API_KEY". */
  apiKeyEnv?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export function createModel(config: LlmEndpointConfig): Model<Api> {
  if (!config.baseUrl) {
    const known = knownModel(config.provider, config.model);
    if (known) return known;
  }

  // Ensure baseUrl ends with /v1 for OpenAI-compatible APIs
  let baseUrl = config.baseUrl || "http://localhost:1234/v1";
  if (!baseUrl.endsWith("/v1")) baseUrl += "/v1";

  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: true,
    compat: { thinkingFormat: "qwen-chat-template" },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 262144,
    maxTokens: config.maxTokens ?? 4096,
  };
  return model as unknown as Model<Api>;
}

function knownModel(provider: string, modelId: string): Model<Api> | null {
  try {
    const lookup = getModel as unknown as (p: string, m: string) => Model<Api> | undefined;
    return lookup(provider, modelId) ?? null;
  } catch {
    return null;
  }
}

export function getApiKey(config: { apiKey?: string; apiKeyEnv?: string; provider: string }): string {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv && process.env[config.apiKeyEnv]) return process.env[config.apiKeyEnv]!;
  // "dummy" keeps local endpoints (which ignore auth) working keyless.
  return getEnvApiKey(config.provider)
    || process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || "dummy";
}
