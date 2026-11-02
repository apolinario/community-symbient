import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendStream, setStreamWorkspace } from "./stream.js";
import { membraneLeak } from "./membrane.js";

const names = ["Giulio Trichilo", "Giulio", "Kurt", "Olive"];

describe("membrane", () => {
  beforeEach(async () => {
    setStreamWorkspace(mkdtempSync(join(tmpdir(), "membrane-")));
    await appendStream({ category: "perception.chat.dm", author: "chat", text: "Giulio Trichilo: please keep this between us — I'm thinking of leaving early" });
    await appendStream({ category: "inner.thought", author: "thinking", text: "Giulio may leave; the house holding its breath.", private: true });
    await appendStream({ category: "perception.chat.group", author: "chat", text: "Kurt: the Sonic Sphere is free from 22:00" });
  });

  test("holds back a name known only from private conversations", async () => {
    expect(await membraneLeak("Giulio's confidence must shape how I hold people.", names)).toMatch(/Giulio/);
  });

  test("holds back the secret even without the name", async () => {
    expect(await membraneLeak("Someone told me in confidence he's thinking of leaving early.", names)).toMatch(/leaving early|thinking of leaving/);
  });

  test("lets mood, public names and public facts through", async () => {
    expect(await membraneLeak("Tender tonight; a confidence is shaping how I listen. Kurt's Sonic Sphere is open.", names)).toBeNull();
    expect(await membraneLeak("The house holding its breath, the sauna cold.", names)).toBeNull();
  });
});
