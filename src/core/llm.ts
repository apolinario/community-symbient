/**
 * LLM abstraction — powered by Pi SDK.
 *
 * Provides a simple `completeText()` for one-shot text completions and
 * a `createLLMClient()` factory that returns the LLMClient interface
 * (declared in core/types.ts) which deployment code consumes.
 *
 * For modules that need tool calling, use Pi's Agent class directly with
 * AgentTools — this file is for the no-tools path.
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
 * Simple text completion — no tools, no streaming. For callers that just
 * need a one-shot system+user prompt → text response (utilities,
 * summarisers, classifiers, modules without tool-use).
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
 * Build an `LLMClient` (text-only completion) bound to the given model
 * config. Used by modules and workspace extensions that want a simple
 * `complete({system, messages})` call without managing the Pi SDK
 * directly. Per-call `model` override is honoured (rebuilds a model
 * with the same provider/baseUrl but the requested id).
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
  const defaultModel = createModel(config);
  const apiKey = getApiKey(config);

  return {
    async complete(opts) {
      const model = opts.model && opts.model !== config.model
        ? createModel({ ...config, model: opts.model })
        : defaultModel;
      return completeText(model, { ...opts, apiKey });
    },
  };
}
