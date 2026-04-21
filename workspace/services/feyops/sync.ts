/**
 * Amenitiz Sync — pulls bookings from Amenitiz API into SQLite,
 * and OOI/OOO room statuses from the calendar API cache.
 */

import { FeyOpsDB } from "./db.js";
import { readCachedOOI } from "./ooi-fetcher.js";
import { formatDate, addDays } from "../../../src/core/date-utils.js";

interface AmenitizConfig {
  accessToken: string;
  hotelId: string;
  baseUrl: string;
}

interface AmenitizBooking {
  booking_id: number;
  status: string;
  checkin: string;
  checkout: string;
  booker: { first_name: string; last_name: string };
  room_type?: { name?: string };
  rooms?: Array<{ individual_room_name?: string; name?: string }>;
}

const DEFAULT_CONFIG: AmenitizConfig = {
  accessToken: process.env.AMENITIZ_ACCESS_TOKEN || "",
  hotelId: process.env.AMENITIZ_HOTEL_ID || "",
  baseUrl: "https://api.amenitiz.io/vendor_api/v1",
};

export async function syncAmenitiz(
  db: FeyOpsDB,
  config: Partial<AmenitizConfig> = {},
  log: (msg: string) => void = console.log
): Promise<{ synced: number; stale: number; ooi: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.accessToken || !cfg.hotelId) {
    log("Amenitiz sync skipped: no credentials");
    return { synced: 0, stale: 0 };
  }

  // Season runs Dec 1 - May 5. Amenitiz limits to 31-day windows.
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1; // season straddles years
  const rangeStart = new Date(`${year}-12-01`);
  const rangeEnd = new Date(`${year + 1}-05-05`);

  log(`Syncing Amenitiz bookings ${formatDate(rangeStart)} to ${formatDate(rangeEnd)}...`);

  const allBookings: AmenitizBooking[] = [];
  let cursor = new Date(rangeStart);
  while (cursor < rangeEnd) {
    const windowEnd = new Date(Math.min(addDays(cursor, 30).getTime(), rangeEnd.getTime()));
    const from = formatDate(cursor);
    const to = formatDate(windowEnd);
    try {
      const batch = await fetchAllBookings(cfg, from, to);
      allBookings.push(...batch);
    } catch (err) {
      log(`Warning: failed to fetch ${from} to ${to}: ${err}`);
    }
    cursor = addDays(cursor, 31);
  }

  // Deduplicate by booking_id
  const seen = new Set<number>();
  const bookings = allBookings.filter(b => {
    if (seen.has(b.booking_id)) return false;
    seen.add(b.booking_id);
    return true;
  });

  const confirmed = bookings.filter(b => b.status === "confirmed");

  const seenIds: number[] = [];

  for (const b of confirmed) {
    const guest = `${b.booker.first_name} ${b.booker.last_name}`.trim() || "Unknown";
    const room = b.rooms?.[0]?.individual_room_name || b.rooms?.[0]?.name || b.room_type?.name || "Unknown Room";

    db.upsertAmenitiz({
      amenitiz_id: b.booking_id,
      guest,
      room,
      checkin: b.checkin,
      checkout: b.checkout,
      status: b.status,
    });
    seenIds.push(b.booking_id);
  }

  const stale = db.markStaleAmenitiz(seenIds);

  // Also sync OOI data from cache
  const ooiEntries = readCachedOOI();
  if (ooiEntries.length > 0) {
    db.clearOOI();
    for (const entry of ooiEntries) {
      db.upsertOOI({
        room_id: entry.room_id,
        room: entry.room_name,
        checkin: entry.start_date,
        checkout: entry.end_date,
        status: entry.status,
        reason: entry.reason,
      });
    }
    log(`Synced ${ooiEntries.length} OOI entries`);
  }

  log(`Synced ${confirmed.length} bookings, marked ${stale} stale`);
  return { synced: confirmed.length, stale, ooi: ooiEntries.length };
}

async function fetchAllBookings(
  cfg: AmenitizConfig,
  from: string,
  to: string
): Promise<AmenitizBooking[]> {
  const url = `${cfg.baseUrl}/bookings/checkin?hotel_id=${cfg.hotelId}&from=${from}&to=${to}&locale=en`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Amenitiz ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data.data) return Array.isArray(data.data) ? data.data : [data.data];
  if (data.bookings) return data.bookings;
  return [];
}

