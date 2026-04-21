/**
 * FeyOps SQLite Database Layer
 *
 * Single bookings table with source tracking (amenitiz vs admin).
 * Supports +1 guests and admin-blocked rooms.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface BookingRow {
  id: number;
  amenitiz_id: number | null;
  guest: string;
  room: string;
  venue: string;
  checkin: string;
  checkout: string;
  source: "amenitiz" | "ooi" | "admin";
  plus_one_of: number | null;
  person_slug: string | null;
  notes: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PersonNickname {
  slug: string;
  nickname: string;
}

type BookingInsert = Omit<BookingRow, "id" | "created_at" | "updated_at">;

// Hard-coded room → venue mapping based on Château du Feÿ layout
const ROOM_VENUE_MAP: Record<string, string> = {
  // Chateau
  "Ninon de L'Enclos": "chateau",
  "Bardane": "chateau",
  "Bardanne": "chateau",
  "Angélique": "chateau",
  "Angelique": "chateau",
  "Eglantier": "chateau",
  "Eglantiers": "chateau",
  "Lin": "chateau",
  "Primevère": "chateau",
  "Primevere": "chateau",
  "Sureau": "chateau",
  "Valériane": "chateau",
  "Valeriane": "chateau",
  "Camomille": "chateau",
  "Millepertuis": "chateau",
  "Reine des Prés": "chateau",
  "Reine Des Prés": "chateau",
  "AC Eglantier": "chateau",
  "AC Bardane": "chateau",
  "AC Bardanne": "chateau",
  "A.C. Sureau": "chateau",
  "Mélisse": "chateau",
  "Melisse": "chateau",
  "Boudoir": "chateau",
  "Chambre Rose": "chateau",
  "Chambre rose": "chateau",
  "Chambrette": "chateau",
  "Plantoid Room": "chateau",
  // Cottage
  "Armoise": "cottage",
  "Gentiane": "cottage",
  "Thym": "cottage",
  "Passiflore": "cottage",
  // Farmhouse (La Ferme)
  "Pensée Sauvage": "ferme",
  "Pensee Sauvage": "ferme",
  "Marjolaine": "ferme",
  "Glycine": "ferme",
  "Chardon Marie": "ferme",
  "Calendula": "ferme",
  // Gite
  "Le Gîte": "gite",
  "Le Gite": "gite",
  // Dorm
  "Tilleul": "dorm",
  // Vans
  "VAN": "van",
};

// Canonical room name normalization — fuses duplicates
const ROOM_CANONICAL: Record<string, string> = {
  // Chateau - accents and suffixes
  "Angélique (Le Château)": "Angélique",
  "Bardane (Le Château)": "Bardane",
  "Bardanne": "Bardane",
  "AC Bardane (Le Château)": "AC Bardane",
  "AC Bardanne": "AC Bardane",
  "A.C. Sureau": "AC Sureau",
  "Boudoir (Le Château)": "Boudoir",
  "Camomille (Le Château)": "Camomille",
  "Chambre Rose (Le Château)": "Chambre Rose",
  "Chambre rose": "Chambre Rose",
  "Chambrette (Le Château)": "Chambrette",
  "Eglantiers (Le Château)": "Eglantier",
  "Eglantiers": "Eglantier",
  "AC Eglantier (Le Chateau)": "AC Eglantier",
  "Lin (Le Château)": "Lin",
  "Millepertuis (Le Château)": "Millepertuis",
  "Mélisse (Le Château)": "Mélisse",
  "Ninon de L'Enclos (Le Château)": "Ninon de L'Enclos",
  "Primevere": "Primevère",
  "Primevère (Le Château)": "Primevère",
  "Reine Des Prés (Le Château)": "Reine des Prés",
  "Reine Des Prés": "Reine des Prés",
  "Sureau (Le Château)": "Sureau",
  "Valeriane": "Valériane",
  "Valériane (Le Château)": "Valériane",
  // Cottage
  "Armoise (Le Cottage)": "Armoise",
  "Gentiane (Le Cottage)": "Gentiane",
  "Passiflore (Le Cottage)": "Passiflore",
  "Thym (Le Cottage)": "Thym",
  // Ferme
  "Calendula (La Ferme)": "Calendula",
  "Chardon Marie (La Ferme)": "Chardon Marie",
  "Glycine (La Ferme)": "Glycine",
  "Marjolaine (La Ferme)": "Marjolaine",
  "Pensée Sauvage (La Ferme)": "Pensée Sauvage",
  "Pensee Sauvage": "Pensée Sauvage",
  "Pensee Sauvage (La Ferme)": "Pensée Sauvage",
  // Gite
  "Le Gite": "Le Gîte",
  // Dorm - normalize format
  "TIlleul (Dorm) 1": "Tilleul (Dorm #1)",
  "Tilleul (Dorm) 2": "Tilleul (Dorm #2)",
  "Tilleul (Dorm) 3": "Tilleul (Dorm #3)",
  "Tilleul (Dorm) 4": "Tilleul (Dorm #4)",
  // Glamping
  "Glamping Type 1 : 4 single beds": "Glamping 1",
  "Glamping Type 3 : 1 double bed + 2 single beds": "Glamping 3",
};

export function canonicalRoom(room: string): string {
  return ROOM_CANONICAL[room] || room;
}

export function detectVenue(room: string): string {
  // Direct match
  if (ROOM_VENUE_MAP[room]) return ROOM_VENUE_MAP[room];

  // Try stripping venue suffix like "(Le Château)", "(Le Cottage)", etc.
  const stripped = room.replace(/\s*\(.*\)\s*$/, "").trim();
  if (ROOM_VENUE_MAP[stripped]) return ROOM_VENUE_MAP[stripped];

  // Partial match: check if room name starts with a known key
  for (const [key, venue] of Object.entries(ROOM_VENUE_MAP)) {
    if (room.toLowerCase().startsWith(key.toLowerCase())) return venue;
  }

  // Pattern fallback
  if (/Glamping/i.test(room)) return "glamping";
  if (/Tilleul|Dorm/i.test(room)) return "dorm";
  if (/Off\s*site/i.test(room)) return "offsite";
  if (/VAN/i.test(room)) return "van";
  if (/Château|Chateau/i.test(room)) return "chateau";
  if (/Cottage/i.test(room)) return "cottage";
  if (/Ferme/i.test(room)) return "ferme";
  if (/Gîte|Gite/i.test(room)) return "gite";

  return "chateau";
}

export class FeyOpsDB {
  private db: Database.Database;

  constructor(dbPath: string = "./data/feyops.db") {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amenitiz_id INTEGER UNIQUE,
        guest TEXT NOT NULL,
        room TEXT NOT NULL,
        venue TEXT NOT NULL DEFAULT 'chateau',
        checkin TEXT NOT NULL,
        checkout TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'amenitiz',
        plus_one_of INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        notes TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_bookings_checkin ON bookings(checkin);
      CREATE INDEX IF NOT EXISTS idx_bookings_checkout ON bookings(checkout);
      CREATE INDEX IF NOT EXISTS idx_bookings_amenitiz_id ON bookings(amenitiz_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_source ON bookings(source);
    `);

    // Add person_slug column if missing
    const cols = this.db.prepare("PRAGMA table_info(bookings)").all() as { name: string }[];
    if (!cols.some(c => c.name === "person_slug")) {
      this.db.exec("ALTER TABLE bookings ADD COLUMN person_slug TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_person_slug ON bookings(person_slug)");
    }

    // Person nicknames table (maps slug → alternative names for matching)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_nicknames (
        slug TEXT NOT NULL,
        nickname TEXT NOT NULL,
        PRIMARY KEY (slug, nickname)
      );
    `);
  }

  /** Upsert a booking from Amenitiz (by amenitiz_id) */
  upsertAmenitiz(b: {
    amenitiz_id: number;
    guest: string;
    room: string;
    checkin: string;
    checkout: string;
    status: string;
  }): void {
    const room = canonicalRoom(b.room);
    const venue = detectVenue(room);
    this.db.prepare(`
      INSERT INTO bookings (amenitiz_id, guest, room, venue, checkin, checkout, source, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'amenitiz', ?, datetime('now'))
      ON CONFLICT(amenitiz_id) DO UPDATE SET
        guest = excluded.guest,
        room = excluded.room,
        venue = excluded.venue,
        checkin = excluded.checkin,
        checkout = excluded.checkout,
        status = excluded.status,
        updated_at = datetime('now')
    `).run(b.amenitiz_id, b.guest, room, venue, b.checkin, b.checkout, b.status);
  }

  /** Upsert an OOI/OOO entry (blocked room from calendar API) */
  upsertOOI(b: {
    room_id: number;
    room: string;
    checkin: string;
    checkout: string;
    status: string; // ooi, ooo, pre_booked
    reason: string;
  }): void {
    // Synthetic amenitiz_id: negative hash of room_id + start_date to avoid collision with real booking IDs
    const syntheticId = -(b.room_id * 100000 + parseInt(b.checkin.replace(/-/g, "").slice(4)));
    const guest = b.reason.trim() || b.status.toUpperCase();
    const room = canonicalRoom(b.room);
    const venue = detectVenue(room);
    this.db.prepare(`
      INSERT INTO bookings (amenitiz_id, guest, room, venue, checkin, checkout, source, notes, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ooi', ?, ?, datetime('now'))
      ON CONFLICT(amenitiz_id) DO UPDATE SET
        guest = excluded.guest,
        room = excluded.room,
        venue = excluded.venue,
        checkin = excluded.checkin,
        checkout = excluded.checkout,
        notes = excluded.notes,
        status = excluded.status,
        updated_at = datetime('now')
    `).run(syntheticId, guest, room, venue, b.checkin, b.checkout, b.status, b.status);
  }

  /** Remove all OOI entries (before re-syncing) */
  clearOOI(): void {
    this.db.prepare("DELETE FROM bookings WHERE source = 'ooi'").run();
  }

  /** Insert an admin booking (+1, blocked room, etc.) */
  insertAdmin(b: {
    guest: string;
    room: string;
    checkin: string;
    checkout: string;
    plus_one_of?: number;
    notes?: string;
    status?: string;
  }): number {
    const room = canonicalRoom(b.room);
    const venue = detectVenue(room);
    const result = this.db.prepare(`
      INSERT INTO bookings (guest, room, venue, checkin, checkout, source, plus_one_of, notes, status)
      VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?)
    `).run(
      b.guest, room, venue, b.checkin, b.checkout,
      b.plus_one_of ?? null, b.notes ?? "", b.status ?? "confirmed"
    );
    return Number(result.lastInsertRowid);
  }

  /** Update any booking */
  update(id: number, fields: Partial<Pick<BookingRow, "guest" | "room" | "checkin" | "checkout" | "notes" | "status" | "plus_one_of">>): boolean {
    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        if (key === "room") {
          sets.push("room = ?", "venue = ?");
          vals.push(val, detectVenue(val as string));
        } else {
          sets.push(`${key} = ?`);
          vals.push(val);
        }
      }
    }

    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    vals.push(id);

    const result = this.db.prepare(
      `UPDATE bookings SET ${sets.join(", ")} WHERE id = ?`
    ).run(...vals);
    return result.changes > 0;
  }

  /** Delete an admin booking (won't delete amenitiz-sourced ones) */
  deleteAdmin(id: number): boolean {
    const result = this.db.prepare(
      "DELETE FROM bookings WHERE id = ? AND source = 'admin'"
    ).run(id);
    return result.changes > 0;
  }

  /** Get all bookings in a date range (includes confirmed + OOI/OOO/pre_booked, excludes cancelled) */
  getBookings(from?: string, to?: string): BookingRow[] {
    if (from && to) {
      return this.db.prepare(
        "SELECT * FROM bookings WHERE checkout > ? AND checkin <= ? AND status != 'cancelled' ORDER BY checkin"
      ).all(from, to) as BookingRow[];
    }
    return this.db.prepare(
      "SELECT * FROM bookings WHERE status != 'cancelled' ORDER BY checkin"
    ).all() as BookingRow[];
  }

  /** Get a single booking */
  getBooking(id: number): BookingRow | undefined {
    return this.db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow | undefined;
  }

  /** Get all unique rooms */
  getRooms(): { name: string; venue: string }[] {
    return this.db.prepare(
      "SELECT DISTINCT room as name, venue FROM bookings ORDER BY venue, room"
    ).all() as { name: string; venue: string }[];
  }

  /** Get today's arrivals/departures (for Feyblet's bookings module) */
  getTodayActivity(today: string): { arrivals: BookingRow[]; departures: BookingRow[] } {
    const arrivals = this.db.prepare(
      "SELECT * FROM bookings WHERE checkin = ? AND status = 'confirmed'"
    ).all(today) as BookingRow[];
    const departures = this.db.prepare(
      "SELECT * FROM bookings WHERE checkout = ? AND status = 'confirmed'"
    ).all(today) as BookingRow[];
    return { arrivals, departures };
  }

  /** Get counts by source */
  getCountsBySource(): { amenitiz: number; ooi: number; admin: number } {
    const rows = this.db.prepare(
      "SELECT source, COUNT(*) as count FROM bookings GROUP BY source"
    ).all() as { source: string; count: number }[];
    const counts = { amenitiz: 0, ooi: 0, admin: 0 };
    for (const row of rows) {
      if (row.source in counts) (counts as any)[row.source] = row.count;
    }
    return counts;
  }

  /** Get count of amenitiz bookings (for sync stats) */
  getAmenitizCount(): number {
    return this.getCountsBySource().amenitiz;
  }

  /** Mark stale amenitiz bookings as cancelled (ones not seen in latest sync) */
  markStaleAmenitiz(activeIds: number[]): number {
    if (activeIds.length === 0) return 0;
    const placeholders = activeIds.map(() => "?").join(",");
    const result = this.db.prepare(
      `UPDATE bookings SET status = 'cancelled', updated_at = datetime('now')
       WHERE source = 'amenitiz' AND amenitiz_id NOT IN (${placeholders}) AND status = 'confirmed'`
    ).run(...activeIds);
    return result.changes;
  }

  /** Set person_slug on a booking */
  matchPerson(bookingId: number, slug: string | null): boolean {
    const result = this.db.prepare(
      "UPDATE bookings SET person_slug = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(slug, bookingId);
    return result.changes > 0;
  }

  /** Batch match: set person_slug on all bookings matching a guest name */
  matchPersonByGuest(guest: string, slug: string): number {
    const result = this.db.prepare(
      "UPDATE bookings SET person_slug = ?, updated_at = datetime('now') WHERE guest = ? AND person_slug IS NULL"
    ).run(slug, guest);
    return result.changes;
  }

  /** Get all unmatched bookings (no person_slug) */
  getUnmatched(): BookingRow[] {
    return this.db.prepare(
      "SELECT * FROM bookings WHERE person_slug IS NULL AND status != 'cancelled' ORDER BY guest"
    ).all() as BookingRow[];
  }

  /** Get distinct unmatched guest names with booking count */
  getUnmatchedGuests(): { guest: string; count: number; sources: string }[] {
    return this.db.prepare(`
      SELECT guest, COUNT(*) as count, GROUP_CONCAT(DISTINCT source) as sources
      FROM bookings WHERE person_slug IS NULL AND status != 'cancelled'
      GROUP BY guest ORDER BY guest
    `).all() as { guest: string; count: number; sources: string }[];
  }

  /** Add a nickname for a person slug */
  addNickname(slug: string, nickname: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO person_nicknames (slug, nickname) VALUES (?, ?)"
    ).run(slug, nickname);
  }

  /** Remove a nickname */
  removeNickname(slug: string, nickname: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM person_nicknames WHERE slug = ? AND nickname = ?"
    ).run(slug, nickname);
    return result.changes > 0;
  }

  /** Get all nicknames for a slug */
  getNicknames(slug: string): string[] {
    const rows = this.db.prepare(
      "SELECT nickname FROM person_nicknames WHERE slug = ?"
    ).all(slug) as { nickname: string }[];
    return rows.map(r => r.nickname);
  }

  /** Get all nicknames */
  getAllNicknames(): PersonNickname[] {
    return this.db.prepare(
      "SELECT slug, nickname FROM person_nicknames ORDER BY slug"
    ).all() as PersonNickname[];
  }

  /** Get person stats (how many bookings per person_slug) */
  getPersonStats(): { slug: string; bookings: number }[] {
    return this.db.prepare(`
      SELECT person_slug as slug, COUNT(*) as bookings
      FROM bookings WHERE person_slug IS NOT NULL AND status != 'cancelled'
      GROUP BY person_slug ORDER BY person_slug
    `).all() as { slug: string; bookings: number }[];
  }

  close() {
    this.db.close();
  }
}

/**
 * FeyOps directory adapter — registered as `feyops` in the directory
 * registry at module load. Deployments reference it by name in
 * config.adapters.directory. Other communities can implement their own
 * DirectoryFactory or skip the directory layer (config.adapters.directory = null).
 *
 * The factory returns the raw FeyOpsDB class (which is richer than the
 * minimal Directory interface — it has amenitiz sync, room mapping, etc.).
 * Feÿ-specific modules (bookings, people-sync, onboarding, radio-calendar)
 * cast it back to FeyOpsDB when they need the rich API. Generic consumers
 * use it through the Directory interface.
 */
import { registerDirectory } from "../../../src/core/adapter-registry.js";
import type { DirectoryFactory, Directory } from "../../../src/adapters/directory/types.js";

export function createFeyOpsDB(params: { path?: string } = {}): FeyOpsDB {
  return new FeyOpsDB(params.path ?? "./data/feyops.db");
}

export const feyOpsDirectoryFactory: DirectoryFactory = {
  name: "feyops",
  create: (params) => createFeyOpsDB(params as { path?: string }) as unknown as Directory,
};
registerDirectory(feyOpsDirectoryFactory);
