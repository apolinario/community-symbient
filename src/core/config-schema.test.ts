import { describe, it, expect } from "vitest";
import { validateConfig } from "./config-schema.js";
import { loadConfig } from "../config.js";

describe("validateConfig", () => {
  it("accepts a starter-template config merged over defaults", async () => {
    process.env.SYMBIENT_CONFIG = "starter-templates/minimal/workspace/config/config.json";
    try {
      const config = await loadConfig();
      expect(validateConfig(config)).toEqual([]);
    } finally {
      delete process.env.SYMBIENT_CONFIG;
    }
  });

  it("rejects a misshaped llm block", () => {
    const problems = validateConfig({
      name: "x", workspacePath: "w",
      mqtt: { brokerUrl: "localhost", port: 1883 },
      llm: { provider: "openai", model: 42 },
    });
    expect(problems.some((p) => p.includes("/llm/model"))).toBe(true);
  });

  it("rejects wrong-typed mqtt port", () => {
    const problems = validateConfig({
      name: "x", workspacePath: "w",
      mqtt: { brokerUrl: "localhost", port: "1883" },
      llm: { provider: "openai", model: "m" },
    });
    expect(problems.some((p) => p.includes("/mqtt/port"))).toBe(true);
  });

  it("ignores unknown deployment-specific keys", () => {
    const problems = validateConfig({
      name: "x", workspacePath: "w",
      mqtt: { brokerUrl: "localhost", port: 1883 },
      llm: { provider: "openai", model: "m" },
      coder: { reviewer: "someone" },
      adapters: { chat: { adapter: "signal" } },
    });
    expect(problems).toEqual([]);
  });
});
