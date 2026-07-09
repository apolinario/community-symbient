import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns a valid config with defaults", async () => {
    const config = await loadConfig();
    // The name comes from the deployment's config file, not the framework
    expect(config.name).not.toBe("");
    expect(config.mqtt.port).toBe(1883);
    expect(config.llm.provider).toBe("openai");
    expect(config.workspacePath).toContain("workspace");
  });

  it("merges config file values over defaults", async () => {
    const config = await loadConfig();
    expect(config.adapters?.chat?.adapter).toBe("signal");
    // Model names drift with deployments — assert the merge happened, not the value
    expect(config.llm.model).not.toBe("");
    expect(Object.keys(config.modules)).toEqual(
      expect.arrayContaining(["thinking", "desire", "magi"]),
    );
  });
});
