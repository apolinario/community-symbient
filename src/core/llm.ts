/**
 * LLM abstraction — powered by Pi SDK.
 *
 * Provides a simple `completeText()` function for modules that just need
 * text completions (thinking, desire, magi, daily summaries).
 *
 * For modules that need tool calling (conversation, radio), use Pi's
 * Agent class directly with AgentTools.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Context } from "@mariozechner/pi-ai";
import { createModel, getApiKey } from "./pi-model.js";

interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Simple text completion — no tools, no streaming.
 * Used by inner modules (thinking, desire, magi) and utilities (daily summaries).
 */
export async function completeText(
  model: Model<any>,
  opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
    apiKey?: string;
  },
): Promise<string> {
  const context: Context = {
    systemPrompt: opts.system,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: [{ type: "text" as const, text: m.content }],
      timestamp: Date.now(),
    })),
  };

  const response = await completeSimple(model, context, {
    apiKey: opts.apiKey || "dummy",
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  });

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Create a legacy-compatible LLMClient from Pi model.
 * Bridges the old interface for modules that haven't migrated yet.
 */
export function createLLMClient(config: LLMConfig): {
  complete(opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
} {
  const model = createModel(config);
  const apiKey = getApiKey(config);

  return {
    async complete(opts) {
      return completeText(model, { ...opts, apiKey });
    },
  };
}
