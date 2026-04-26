/**
 * Pi SDK model configuration.
 *
 * Creates the Model object for whatever LLM backend is configured.
 * Currently: LM Studio (OpenAI-compatible) running locally.
 */

import type { Model } from "@mariozechner/pi-ai";
import "@mariozechner/pi-ai/openai-completions";

export function createModel(config: {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}): Model<"openai-completions"> {
  // Ensure baseUrl ends with /v1 for OpenAI-compatible APIs
  let baseUrl = config.baseUrl || "http://localhost:1234/v1";
  if (!baseUrl.endsWith("/v1")) baseUrl += "/v1";

  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: true,
    compat: { thinkingFormat: "qwen-chat-template" },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 4096,
  };
}

export function getApiKey(config: { apiKey?: string; provider: string }): string {
  return config.apiKey
    || process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || "dummy";
}
