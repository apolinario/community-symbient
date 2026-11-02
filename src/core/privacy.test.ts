import { describe, expect, test } from "vitest";
import { isPrivatePath, scopeToolsForPublic } from "./privacy.js";

const textOf = (r: any) => r.content.map((c: any) => c.text).join("");
const fakeTool = (name: string, output: string) => ({
  name, label: name, description: "", parameters: {} as any,
  execute: async () => ({ content: [{ type: "text" as const, text: output }], details: {} }),
});

describe("path privacy", () => {
  test("private paths", () => {
    expect(isPrivatePath("memory/2026-11-02.md")).toBe(true);
    expect(isPrivatePath("stream.jsonl")).toBe(true);
    expect(isPrivatePath("qmd://glitchy/people/ed-cooke.md")).toBe(true);
    expect(isPrivatePath("people")).toBe(true);
    expect(isPrivatePath("glitch/residency.md")).toBe(false);
    expect(isPrivatePath("memoryless.md")).toBe(false);
  });

  test("public modules: private reads refused, listings filtered, conversation tools gone", async () => {
    const tools = scopeToolsForPublic([
      fakeTool("read", "secret"),
      fakeTool("grep", "memory/2026-11-02.md:3: Giulio: leaving early\nglitch/residency.md:68: dinner at 20:00"),
      fakeTool("chat_history", "dm"),
      fakeTool("radio_say", "ok"),
    ] as any, "/ws");
    expect(tools.map((t) => t.name)).toEqual(["read", "grep", "radio_say"]);
    const read = await tools[0].execute("1", { path: "inner/self.md" });
    expect((read as any).isError).toBe(true);
    expect(textOf(await tools[0].execute("2", { path: "/ws/memory/x.md" }))).toContain("private");
    expect(textOf(await tools[0].execute("3", { path: "glitch/residency.md" }))).toBe("secret");
    const hits = textOf(await tools[1].execute("4", { pattern: "x" }));
    expect(hits).not.toContain("Giulio");
    expect(hits).toContain("dinner at 20:00");
  });
});
