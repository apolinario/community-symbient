import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "./manager.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpWorkspace(): string {
  const dir = path.join(os.tmpdir(), `symbient-ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("MemoryManager", () => {
  let mm: MemoryManager;
  let wsPath: string;

  beforeEach(() => {
    wsPath = tmpWorkspace();
    mm = new MemoryManager(wsPath);
  });

  afterEach(() => {
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  describe("readFile / writeFile", () => {
    it("reads and writes files relative to workspace", async () => {
      await mm.writeFile("test.md", "hello world");
      const content = await mm.readFile("test.md");
      expect(content).toBe("hello world");
    });

    it("returns null for missing files", async () => {
      const content = await mm.readFile("nonexistent.md");
      expect(content).toBeNull();
    });
  });

  describe("appendFile", () => {
    it("appends to existing files", async () => {
      await mm.writeFile("log.md", "line1\n");
      await mm.appendFile("log.md", "line2\n");
      const content = await mm.readFile("log.md");
      expect(content).toBe("line1\nline2\n");
    });

    it("creates file if it does not exist", async () => {
      await mm.appendFile("new.md", "first line");
      const content = await mm.readFile("new.md");
      expect(content).toBe("first line");
    });
  });

  describe("appendLog", () => {
    it("appends timestamped entries to daily log", async () => {
      await mm.appendLog("Test entry");
      const log = await mm.readTodayLog();
      expect(log).toContain("Test entry");
      expect(log).toMatch(/## \d{2}:\d{2}:\d{2}/);
    });
  });

  describe("readSoul / readMemory", () => {
    it("reads SOUL.md when it exists", async () => {
      await mm.writeFile("SOUL.md", "# Willow\nI am a symbient.");
      const soul = await mm.readSoul();
      expect(soul).toContain("symbient");
    });

    it("returns null when SOUL.md does not exist", async () => {
      expect(await mm.readSoul()).toBeNull();
    });

    it("reads MEMORY.md when it exists", async () => {
      await mm.writeFile("MEMORY.md", "# Memories");
      expect(await mm.readMemory()).toContain("Memories");
    });
  });

  describe("discoverPeople", () => {
    it("discovers people from markdown frontmatter", async () => {
      fs.mkdirSync(path.join(wsPath, "people"), { recursive: true });
      fs.writeFileSync(
        path.join(wsPath, "people", "jade-flowers.md"),
        '---\nname: Jade Flowers\nstatus: Returner\n---\n\n# Jade',
      );
      fs.writeFileSync(
        path.join(wsPath, "people", "poli.md"),
        '---\nname: Apolinário Passos\nfield: ML\n---\n\n# Poli',
      );

      const people = await mm.discoverPeople();
      expect(people).toHaveLength(2);
      expect(people.find(p => p.name === "Jade Flowers")).toBeDefined();
      expect(people.find(p => p.name === "Apolinário Passos")?.fields.field).toBe("ML");
    });

    it("returns empty array when no people dir", async () => {
      const people = await mm.discoverPeople();
      expect(people).toHaveLength(0);
    });
  });

  describe("readPerson", () => {
    it("finds person by exact name", async () => {
      fs.mkdirSync(path.join(wsPath, "people"), { recursive: true });
      fs.writeFileSync(
        path.join(wsPath, "people", "jade-flowers.md"),
        '---\nname: Jade Flowers\n---\n\n# Jade',
      );

      const person = await mm.readPerson("Jade Flowers");
      expect(person).toContain("Jade Flowers");
    });

    it("finds person by first name", async () => {
      fs.mkdirSync(path.join(wsPath, "people"), { recursive: true });
      fs.writeFileSync(
        path.join(wsPath, "people", "jade-flowers.md"),
        '---\nname: Jade Flowers\n---\n\n# Jade',
      );

      const person = await mm.readPerson("Jade");
      expect(person).toContain("Jade Flowers");
    });

    it("returns null for unknown person", async () => {
      expect(await mm.readPerson("Nobody")).toBeNull();
    });
  });

  describe("assembleContext", () => {
    it("includes SOUL and MEMORY when they exist", async () => {
      await mm.writeFile("SOUL.md", "I am Willow.");
      await mm.writeFile("MEMORY.md", "I remember things.");

      const ctx = await mm.assembleContext();
      expect(ctx).toContain("<soul>");
      expect(ctx).toContain("I am Willow.");
      expect(ctx).toContain("<memory>");
      expect(ctx).toContain("I remember things.");
    });

    it("includes person profile when name is provided", async () => {
      fs.mkdirSync(path.join(wsPath, "people"), { recursive: true });
      fs.writeFileSync(
        path.join(wsPath, "people", "jade-flowers.md"),
        '---\nname: Jade Flowers\n---\n\n# Jade',
      );
      mm.invalidatePeopleCache();

      const ctx = await mm.assembleContext("Jade Flowers");
      expect(ctx).toContain('<person name="Jade Flowers"');
    });

    it("works with empty workspace", async () => {
      const ctx = await mm.assembleContext();
      // Should not throw, just return whatever is available
      expect(typeof ctx).toBe("string");
    });
  });

});
