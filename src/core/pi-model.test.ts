import { describe, it, expect, afterEach } from "vitest";
import { createModel, getApiKey } from "./pi-model.js";

describe("createModel", () => {
  it("builds an OpenAI-compatible model for baseUrl endpoints", () => {
    const m = createModel({ provider: "openai", model: "Qwen3.6-35B.gguf", baseUrl: "http://localhost:1234" });
    expect(m.api).toBe("openai-completions");
    expect(m.baseUrl).toBe("http://localhost:1234/v1");
    expect(m.id).toBe("Qwen3.6-35B.gguf");
    expect((m as any).compat.supportsDeveloperRole).toBe(false);
  });

  it("resolves hosted providers from the Pi SDK model registry", () => {
    const m = createModel({ provider: "anthropic", model: "claude-3-5-haiku-20241022" });
    expect(m.api).toBe("anthropic-messages");
    expect(m.cost.input).toBeGreaterThan(0);
  });

  it("falls back to compat for unknown provider/model without baseUrl", () => {
    const m = createModel({ provider: "somelab", model: "mystery-model" });
    expect(m.api).toBe("openai-completions");
    expect(m.id).toBe("mystery-model");
  });

  it("honours contextWindow/maxTokens overrides on compat endpoints", () => {
    const m = createModel({ provider: "openai", model: "x", baseUrl: "http://h:1/v1", contextWindow: 8192, maxTokens: 1024 });
    expect(m.contextWindow).toBe(8192);
    expect(m.maxTokens).toBe(1024);
  });
});

describe("getApiKey", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["MY_KEY_ENV", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prefers explicit apiKey", () => {
    process.env.MY_KEY_ENV = "from-env";
    expect(getApiKey({ provider: "openai", apiKey: "explicit", apiKeyEnv: "MY_KEY_ENV" })).toBe("explicit");
  });

  it("reads apiKeyEnv next", () => {
    process.env.MY_KEY_ENV = "from-env";
    expect(getApiKey({ provider: "openai", apiKeyEnv: "MY_KEY_ENV" })).toBe("from-env");
  });

  it("falls back to the provider's conventional env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getApiKey({ provider: "anthropic" })).toBe("sk-ant-test");
  });

  it("returns dummy for keyless local endpoints", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(getApiKey({ provider: "llamacpp" })).toBe("dummy");
  });
});
