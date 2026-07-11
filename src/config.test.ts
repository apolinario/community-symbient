import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.SYMBIENT_CONFIG;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("returns a valid config with defaults when no file exists", async () => {
    // Point at a definitely-empty location so a local deployment config
    // (untracked, machine-specific) can't leak into the assertion.
    const dir = mkdtempSync(join(tmpdir(), "symbient-config-test-"));
    dirs.push(dir);
    process.env.SYMBIENT_CONFIG = join(dir, "missing.json");
    const config = await loadConfig();
    expect(config.name).toBe("symbient");
    expect(config.mqtt.port).toBe(1883);
    expect(config.llm.provider).toBe("openai");
    expect(config.workspacePath).toContain("workspace");
  });

  it("merges config file values over defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "symbient-config-test-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      name: "testling",
      llm: { model: "some-model" },
      adapters: { chat: { adapter: "signal", params: {} } },
      modules: { thinking: { intervalMs: 1000 } },
    }));
    process.env.SYMBIENT_CONFIG = path;
    const config = await loadConfig();
    expect(config.name).toBe("testling");
    expect(config.adapters?.chat?.adapter).toBe("signal");
    expect(config.llm.model).toBe("some-model");
    expect(config.llm.provider).toBe("openai"); // default survives the merge
    expect(Object.keys(config.modules)).toContain("thinking");
  });
});
