import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns a valid config with defaults", async () => {
    const config = await loadConfig();
    expect(config.name).toBe("feyblet");
    expect(config.mqtt.port).toBe(1883);
    expect(config.llm.provider).toBe("openai");
    expect(config.workspacePath).toContain("workspace");
  });

  it("merges config file values over defaults", async () => {
    const config = await loadConfig();
    expect(config.adapters?.chat?.adapter).toBe("signal");
    expect(config.llm.model).toBe("qwen/qwen3.6-27b");
    expect(Object.keys(config.modules)).toEqual(
      expect.arrayContaining(["thinking", "desire", "magi"]),
    );
  });
});
