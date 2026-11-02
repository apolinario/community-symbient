import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendStream, inCategories, readStream, renderStream, setStreamWorkspace } from "./stream.js";
import { renderContextBlocks } from "./context-providers.js";

describe("stream", () => {
  beforeEach(() => setStreamWorkspace(mkdtempSync(join(tmpdir(), "stream-"))));

  test("a filter matches its category and everything below it", () => {
    expect(inCategories("perception.chat.dm", ["perception.chat"])).toBe(true);
    expect(inCategories("perception.chat", ["perception.chat"])).toBe(true);
    expect(inCategories("perception.chatter", ["perception.chat"])).toBe(false);
    expect(inCategories("inner.want", ["perception", "inner.thought"])).toBe(false);
  });

  test("modules hear only the categories they read", async () => {
    await appendStream({ category: "perception.chat.dm", author: "chat", text: "Ana: hi" });
    await appendStream({ category: "perception.sauna", author: "sauna", text: "41°C" });
    await appendStream({ category: "inner.want", author: "desire", text: "a radio show" });
    const heard = await readStream({ categories: ["perception.sauna", "inner"] });
    expect(heard.map((e) => e.text)).toEqual(["41°C", "a radio show"]);
  });

  test("limit keeps the most recent entries, empty text is dropped", async () => {
    for (const n of [1, 2, 3]) await appendStream({ category: "inner.thought", author: "thinking", text: `t${n}` });
    await appendStream({ category: "inner.thought", author: "thinking", text: "  " });
    const heard = await readStream({ categories: ["inner"], limit: 2 });
    expect(heard.map((e) => e.text)).toEqual(["t2", "t3"]);
    expect(renderStream(heard)).toMatch(/inner\.thought · thinking: t3$/);
  });

  test("the stream provider renders a module's slice as a tagged block", async () => {
    await appendStream({ category: "perception.chat.dm", author: "chat", text: "Ana: a secret" });
    await appendStream({ category: "perception.radio", author: "station", text: "Now playing: Zombie" });
    const [block] = await renderContextBlocks([{ source: "stream", categories: ["perception.radio"], tag: "on-air" }], { log: () => {} } as any);
    expect(block).toContain("<on-air>");
    expect(block).toContain("Now playing: Zombie");
    expect(block).not.toContain("secret");
  });
});
