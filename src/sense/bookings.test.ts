import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBookingsModule } from "./bookings.js";
import { FeyOpsDB } from "../feyops/db.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ModuleContext } from "../core/types.js";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `feyops-bookings-test-${Date.now()}.db`);
}

function mockContext(): ModuleContext {
  const logs: string[] = [];
  return {
    config: { name: "bookings", intervalMs: 1000, startActive: true },
    memory: {
      readFile: async () => null,
      readTodayLog: async () => null,
      readYesterdayLog: async () => null,
      readSoul: async () => null,
      readMemory: async () => null,
      readPerson: async () => null,
      assembleContext: async () => "",
      appendLog: async (entry: string) => { logs.push(entry); },
      writeFile: async () => {},
      appendFile: async () => {},
    },
    messages: {
      send: async () => {},
      receive: async () => null,
      pending: () => 0,
    },
    llm: {
      complete: async () => "",
    },
    log: (msg: string) => { logs.push(msg); },
    signal: new AbortController().signal,
    _logs: logs,
  } as ModuleContext & { _logs: string[] };
}

describe("bookings module", () => {
  let db: FeyOpsDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new FeyOpsDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  });

  it("returns early when no DB provided", async () => {
    const mod = createBookingsModule();
    const ctx = mockContext();
    await mod(ctx);
    expect((ctx as any)._logs).toHaveLength(0);
  });

  it("reports arrivals and departures", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.upsertAmenitiz({
      amenitiz_id: 1,
      guest: "Test Guest",
      room: "Bardane",
      checkin: today,
      checkout: "2099-12-31",
      status: "confirmed",
    });

    const mod = createBookingsModule(db);
    const ctx = mockContext();
    await mod(ctx);
    const logs = (ctx as any)._logs as string[];
    expect(logs.some((l: string) => l.includes("Test Guest"))).toBe(true);
  });

  it("does not re-report on second run same day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.upsertAmenitiz({
      amenitiz_id: 1,
      guest: "Test",
      room: "Bardane",
      checkin: today,
      checkout: "2099-12-31",
      status: "confirmed",
    });

    const mod = createBookingsModule(db);
    const ctx1 = mockContext();
    await mod(ctx1);
    expect((ctx1 as any)._logs.length).toBeGreaterThan(0);

    const ctx2 = mockContext();
    await mod(ctx2);
    // Second call should not report (same day, same arrivals)
    expect((ctx2 as any)._logs.length).toBe(0);
  });
});
