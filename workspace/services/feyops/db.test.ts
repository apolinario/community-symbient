import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FeyOpsDB, canonicalRoom, detectVenue } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `feyops-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("canonicalRoom", () => {
  it("normalizes venue suffixes", () => {
    expect(canonicalRoom("Angélique (Le Château)")).toBe("Angélique");
    expect(canonicalRoom("Armoise (Le Cottage)")).toBe("Armoise");
    expect(canonicalRoom("Calendula (La Ferme)")).toBe("Calendula");
  });

  it("normalizes spelling variants", () => {
    expect(canonicalRoom("Bardanne")).toBe("Bardane");
    expect(canonicalRoom("Chambre rose")).toBe("Chambre Rose");
    expect(canonicalRoom("Valeriane")).toBe("Valériane");
    expect(canonicalRoom("Primevere")).toBe("Primevère");
    expect(canonicalRoom("Le Gite")).toBe("Le Gîte");
  });

  it("normalizes dorm format", () => {
    expect(canonicalRoom("TIlleul (Dorm) 1")).toBe("Tilleul (Dorm #1)");
    expect(canonicalRoom("Tilleul (Dorm) 2")).toBe("Tilleul (Dorm #2)");
  });

  it("normalizes glamping variants", () => {
    expect(canonicalRoom("Glamping Type 1 : 4 single beds")).toBe("Glamping 1");
    expect(canonicalRoom("Glamping Type 3 : 1 double bed + 2 single beds")).toBe("Glamping 3");
  });

  it("returns input unchanged for unknown rooms", () => {
    expect(canonicalRoom("Some Unknown Room")).toBe("Some Unknown Room");
  });
});

describe("detectVenue", () => {
  it("detects chateau rooms", () => {
    expect(detectVenue("Bardane")).toBe("chateau");
    expect(detectVenue("Angélique")).toBe("chateau");
    expect(detectVenue("Chambre Rose")).toBe("chateau");
    expect(detectVenue("Plantoid Room")).toBe("chateau");
  });

  it("detects cottage rooms", () => {
    expect(detectVenue("Armoise")).toBe("cottage");
    expect(detectVenue("Gentiane")).toBe("cottage");
    expect(detectVenue("Thym")).toBe("cottage");
  });

  it("detects ferme rooms", () => {
    expect(detectVenue("Pensée Sauvage")).toBe("ferme");
    expect(detectVenue("Marjolaine")).toBe("ferme");
    expect(detectVenue("Glycine")).toBe("ferme");
  });

  it("detects gite", () => {
    expect(detectVenue("Le Gîte")).toBe("gite");
  });

  it("detects dorm", () => {
    expect(detectVenue("Tilleul")).toBe("dorm");
  });

  it("detects van", () => {
    expect(detectVenue("VAN")).toBe("van");
  });

  it("falls back to pattern matching", () => {
    expect(detectVenue("Glamping 1")).toBe("glamping");
    expect(detectVenue("Off site 2")).toBe("offsite");
  });

  it("strips venue suffix for matching", () => {
    expect(detectVenue("Armoise (Le Cottage)")).toBe("cottage");
    expect(detectVenue("Bardane (Le Château)")).toBe("chateau");
  });

  it("defaults to chateau for unknown", () => {
    expect(detectVenue("Unknown Room")).toBe("chateau");
  });
});

describe("FeyOpsDB", () => {
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

  describe("upsertAmenitiz", () => {
    it("inserts a new booking", () => {
      db.upsertAmenitiz({
        amenitiz_id: 1001,
        guest: "Jade Flowers",
        room: "Bardane",
        checkin: "2026-01-15",
        checkout: "2026-02-15",
        status: "confirmed",
      });
      const bookings = db.getBookings();
      expect(bookings).toHaveLength(1);
      expect(bookings[0].guest).toBe("Jade Flowers");
      expect(bookings[0].room).toBe("Bardane");
      expect(bookings[0].venue).toBe("chateau");
      expect(bookings[0].source).toBe("amenitiz");
    });

    it("normalizes room names on insert", () => {
      db.upsertAmenitiz({
        amenitiz_id: 1002,
        guest: "Test",
        room: "Bardanne",
        checkin: "2026-01-01",
        checkout: "2026-01-10",
        status: "confirmed",
      });
      expect(db.getBookings()[0].room).toBe("Bardane");
    });

    it("upserts on conflict by amenitiz_id", () => {
      db.upsertAmenitiz({
        amenitiz_id: 1001,
        guest: "Old Name",
        room: "Bardane",
        checkin: "2026-01-01",
        checkout: "2026-01-10",
        status: "confirmed",
      });
      db.upsertAmenitiz({
        amenitiz_id: 1001,
        guest: "New Name",
        room: "Armoise",
        checkin: "2026-01-05",
        checkout: "2026-01-15",
        status: "confirmed",
      });
      const bookings = db.getBookings();
      expect(bookings).toHaveLength(1);
      expect(bookings[0].guest).toBe("New Name");
      expect(bookings[0].room).toBe("Armoise");
    });
  });

  describe("upsertOOI", () => {
    it("inserts OOI entries with synthetic IDs", () => {
      db.upsertOOI({
        room_id: 123,
        room: "Armoise (Le Cottage)",
        checkin: "2026-01-15",
        checkout: "2026-02-15",
        status: "ooi",
        reason: "Poli",
      });
      const bookings = db.getBookings();
      expect(bookings).toHaveLength(1);
      expect(bookings[0].guest).toBe("Poli");
      expect(bookings[0].room).toBe("Armoise");
      expect(bookings[0].source).toBe("ooi");
      expect(bookings[0].amenitiz_id).toBeLessThan(0);
    });

    it("uses status as guest when reason is empty", () => {
      db.upsertOOI({
        room_id: 123,
        room: "Armoise",
        checkin: "2026-01-15",
        checkout: "2026-02-15",
        status: "ooo",
        reason: "",
      });
      expect(db.getBookings()[0].guest).toBe("OOO");
    });
  });

  describe("insertAdmin", () => {
    it("inserts admin bookings", () => {
      const id = db.insertAdmin({
        guest: "Test Guest",
        room: "Thym",
        checkin: "2026-02-01",
        checkout: "2026-02-10",
        notes: "Test notes",
      });
      expect(id).toBeGreaterThan(0);
      const booking = db.getBooking(id);
      expect(booking?.guest).toBe("Test Guest");
      expect(booking?.source).toBe("admin");
      expect(booking?.venue).toBe("cottage");
    });
  });

  describe("getBookings", () => {
    it("excludes cancelled bookings", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "A", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "B", room: "Armoise", checkin: "2026-01-01", checkout: "2026-01-10", status: "cancelled" });
      expect(db.getBookings()).toHaveLength(1);
      expect(db.getBookings()[0].guest).toBe("A");
    });

    it("filters by date range", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Jan", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-15", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "Feb", room: "Armoise", checkin: "2026-02-01", checkout: "2026-02-15", status: "confirmed" });
      const jan = db.getBookings("2026-01-01", "2026-01-31");
      expect(jan).toHaveLength(1);
      expect(jan[0].guest).toBe("Jan");
    });
  });

  describe("person matching", () => {
    it("matches a booking to a person slug", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Jade Flowers", room: "Bardane", checkin: "2026-01-01", checkout: "2026-02-01", status: "confirmed" });
      const booking = db.getBookings()[0];
      expect(booking.person_slug).toBeNull();

      db.matchPerson(booking.id, "jade-flowers");
      expect(db.getBooking(booking.id)?.person_slug).toBe("jade-flowers");
    });

    it("batch matches by guest name", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Jade Flowers", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-15", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "Jade Flowers", room: "Armoise", checkin: "2026-02-01", checkout: "2026-02-15", status: "confirmed" });
      const count = db.matchPersonByGuest("Jade Flowers", "jade-flowers");
      expect(count).toBe(2);

      const bookings = db.getBookings();
      expect(bookings.every(b => b.person_slug === "jade-flowers")).toBe(true);
    });

    it("returns unmatched guests", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Jade", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "Poli", room: "Armoise", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.matchPerson(db.getBookings()[0].id, "jade-flowers");

      const unmatched = db.getUnmatchedGuests();
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0].guest).toBe("Poli");
    });

    it("unmatches a booking", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Jade", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      const id = db.getBookings()[0].id;
      db.matchPerson(id, "jade-flowers");
      expect(db.getBooking(id)?.person_slug).toBe("jade-flowers");

      db.matchPerson(id, null);
      expect(db.getBooking(id)?.person_slug).toBeNull();
    });
  });

  describe("nicknames", () => {
    it("adds and retrieves nicknames", () => {
      db.addNickname("apolinario-passos", "Poli");
      db.addNickname("apolinario-passos", "Apolinário");
      const nicks = db.getNicknames("apolinario-passos");
      expect(nicks).toContain("Poli");
      expect(nicks).toContain("Apolinário");
    });

    it("ignores duplicate nicknames", () => {
      db.addNickname("test", "Nick");
      db.addNickname("test", "Nick");
      expect(db.getNicknames("test")).toHaveLength(1);
    });

    it("removes nicknames", () => {
      db.addNickname("test", "Nick");
      expect(db.removeNickname("test", "Nick")).toBe(true);
      expect(db.getNicknames("test")).toHaveLength(0);
    });

    it("getAllNicknames returns all", () => {
      db.addNickname("a", "A1");
      db.addNickname("b", "B1");
      const all = db.getAllNicknames();
      expect(all).toHaveLength(2);
    });
  });

  describe("clearOOI", () => {
    it("removes all OOI entries", () => {
      db.upsertOOI({ room_id: 1, room: "Armoise", checkin: "2026-01-01", checkout: "2026-01-10", status: "ooi", reason: "Test" });
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Keep", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.clearOOI();
      const bookings = db.getBookings();
      expect(bookings).toHaveLength(1);
      expect(bookings[0].source).toBe("amenitiz");
    });
  });

  describe("getCountsBySource", () => {
    it("counts by source", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "A", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "B", room: "Lin", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.upsertOOI({ room_id: 1, room: "Armoise", checkin: "2026-01-01", checkout: "2026-01-10", status: "ooi", reason: "X" });
      db.insertAdmin({ guest: "C", room: "Thym", checkin: "2026-01-01", checkout: "2026-01-10" });

      const counts = db.getCountsBySource();
      expect(counts.amenitiz).toBe(2);
      expect(counts.ooi).toBe(1);
      expect(counts.admin).toBe(1);
    });
  });

  describe("markStaleAmenitiz", () => {
    it("marks bookings not in active list as cancelled", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Stay", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "Gone", room: "Armoise", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });

      const stale = db.markStaleAmenitiz([1]);
      expect(stale).toBe(1);
      expect(db.getBookings()).toHaveLength(1);
      expect(db.getBookings()[0].guest).toBe("Stay");
    });
  });

  describe("update", () => {
    it("updates booking fields", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Old", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      const id = db.getBookings()[0].id;
      db.update(id, { guest: "New", notes: "Updated" });
      const booking = db.getBooking(id);
      expect(booking?.guest).toBe("New");
      expect(booking?.notes).toBe("Updated");
    });

    it("updates venue when room changes", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Test", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      const id = db.getBookings()[0].id;
      db.update(id, { room: "Armoise" });
      expect(db.getBooking(id)?.venue).toBe("cottage");
    });
  });

  describe("deleteAdmin", () => {
    it("deletes admin bookings", () => {
      const id = db.insertAdmin({ guest: "Del", room: "Thym", checkin: "2026-01-01", checkout: "2026-01-10" });
      expect(db.deleteAdmin(id)).toBe(true);
      expect(db.getBooking(id)).toBeUndefined();
    });

    it("refuses to delete amenitiz bookings", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "Keep", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      const id = db.getBookings()[0].id;
      expect(db.deleteAdmin(id)).toBe(false);
    });
  });

  describe("getPersonStats", () => {
    it("returns bookings per person", () => {
      db.upsertAmenitiz({ amenitiz_id: 1, guest: "A", room: "Bardane", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 2, guest: "A", room: "Lin", checkin: "2026-02-01", checkout: "2026-02-10", status: "confirmed" });
      db.upsertAmenitiz({ amenitiz_id: 3, guest: "B", room: "Armoise", checkin: "2026-01-01", checkout: "2026-01-10", status: "confirmed" });
      db.matchPersonByGuest("A", "person-a");
      db.matchPersonByGuest("B", "person-b");

      const stats = db.getPersonStats();
      expect(stats.find(s => s.slug === "person-a")?.bookings).toBe(2);
      expect(stats.find(s => s.slug === "person-b")?.bookings).toBe(1);
    });
  });
});
