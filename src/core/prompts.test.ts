import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPromptsWorkspace, withToolGuides } from "./prompts.js";

describe("withToolGuides", () => {
  const ws = mkdtempSync(join(tmpdir(), "guides-"));
  mkdirSync(join(ws, "guides"));
  writeFileSync(join(ws, "guides", "radio.md"), "---\ntools: [radio_say, radio_play]\n---\n## Radio\n\nOn air as {{name}}.");
  writeFileSync(join(ws, "guides", "files.md"), "---\ntools: [read]\n---\n## My files");
  setPromptsWorkspace(ws);

  test("a run gets the guides for the tools it has", () => {
    const out = withToolGuides("SYSTEM", ["radio_say"], { name: "Glitchy" });
    expect(out.startsWith("SYSTEM\n\n")).toBe(true);
    expect(out).toContain("On air as Glitchy.");
    expect(out).not.toContain("My files");
  });

  test("a workspace guide replaces the framework guide of the same name", () => {
    const out = withToolGuides("SYSTEM", ["read"]);
    expect(out).toContain("## My files");
    expect(out).not.toContain("limit: 100");
  });

  test("without matching tools the prompt is unchanged", () => {
    expect(withToolGuides("SYSTEM", ["note"])).toBe("SYSTEM");
  });
});
