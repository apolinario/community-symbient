/**
 * Bookings Perception Module — monitors FeyOps DB for arrivals/departures.
 *
 * Checks every 30 min for upcoming check-ins and check-outs.
 * Distinguishes between: new arrivals, returners, room changes, and departures.
 * Uses the local FeyOps SQLite DB (synced from Amenitiz by feyops server).
 */

import type { ModuleContext } from "../../../src/core/types.js";
import type { FeyOpsDB, BookingRow } from "./db.js";
import { formatDate, addDays } from "../../../src/core/date-utils.js";

export function createBookingsModule(db?: FeyOpsDB) {
  let lastReportedDate: string | null = null;
  let lastReportedArrivals: Set<number> = new Set();

  return async function bookings(ctx: ModuleContext): Promise<void> {
    if (!db) return;

    const today = formatDate(new Date());

    try {
      const tomorrow = formatDate(addDays(new Date(), 1));

      const allBookings = db.getBookings();
      const isPlaceholder = (name: string) => {
        const lower = name.toLowerCase();
        return lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden");
      };
      const active = allBookings.filter((b) => b.status !== "cancelled" && !isPlaceholder(b.guest));

      const todayArrivals = active.filter((b) => b.checkin === today);
      const todayDepartures = active.filter((b) => b.checkout === today);
      const tomorrowArrivals = active.filter((b) => b.checkin === tomorrow);

      const currentArrivalIds = new Set(todayArrivals.map((b) => b.id));
      const isNewDay = lastReportedDate !== today;
      const hasNewArrivals = todayArrivals.some((b) => !lastReportedArrivals.has(b.id));

      if (!isNewDay && !hasNewArrivals) return;

      // Build guest-keyed maps for smart categorization
      const arrivalsByGuest = groupByGuest(todayArrivals);
      const departuresByGuest = groupByGuest(todayDepartures);

      // Categorize today's movements
      const roomChanges: string[] = [];
      const newArrivals: string[] = [];
      const returners: string[] = [];
      const departures: string[] = [];
      const departingReturners: string[] = [];

      // Process arrivals: is it a room change, a returner, or brand new?
      for (const [guest, arrivals] of arrivalsByGuest) {
        const dep = departuresByGuest.get(guest);
        if (dep) {
          // Same person departing and arriving today → room change
          const fromRoom = dep[0].room;
          const toRoom = arrivals[0].room;
          roomChanges.push(`${guest} (${fromRoom} → ${toRoom})`);
          // Remove from departures so they don't show up twice
          departuresByGuest.delete(guest);
        } else {
          // Check if they've been here before this season
          const pastStays = active.filter(
            (b) => b.guest === guest && b.checkout < today && b.checkout > "2026-01-01",
          );
          if (pastStays.length > 0) {
            returners.push(`${guest} (${arrivals[0].room})`);
          } else {
            newArrivals.push(`${guest} (${arrivals[0].room})`);
          }
        }
      }

      // Remaining departures (not room changes)
      for (const [guest, deps] of departuresByGuest) {
        // Check if they're coming back later this season
        const futureStays = active.filter(
          (b) => b.guest === guest && b.checkin > today,
        );
        if (futureStays.length > 0) {
          const nextDate = futureStays[0].checkin;
          departingReturners.push(`${guest} (${deps[0].room}, back ${nextDate})`);
        } else {
          departures.push(`${guest} (${deps[0].room})`);
        }
      }

      // Build observation lines
      const observations: string[] = [];

      if (newArrivals.length > 0) {
        observations.push(`New arrivals: ${newArrivals.join(", ")}`);
      }
      if (returners.length > 0) {
        observations.push(`Returning: ${returners.join(", ")}`);
      }
      if (roomChanges.length > 0) {
        observations.push(`Room changes: ${roomChanges.join(", ")}`);
      }
      if (departures.length > 0) {
        observations.push(`Departing: ${departures.join(", ")} — check-out by 11am`);
      }
      if (departingReturners.length > 0) {
        observations.push(`Departing (returning later): ${departingReturners.join(", ")}`);
      }

      if (tomorrowArrivals.length > 0) {
        const tomorrowDepartures = active.filter((b) => b.checkout === tomorrow);
        const tomorrowArrByGuest = groupByGuest(tomorrowArrivals);
        const tomorrowDepByGuest = groupByGuest(tomorrowDepartures);
        const labels: string[] = [];
        for (const [guest, arrivals] of tomorrowArrByGuest) {
          const dep = tomorrowDepByGuest.get(guest);
          if (dep) {
            labels.push(`${guest} (${dep[0].room} → ${arrivals[0].room})`);
          } else {
            const pastStays = active.filter(
              (b) => b.guest === guest && b.checkout < tomorrow && b.checkout > "2026-01-01",
            );
            const tag = pastStays.length > 0 ? " 🔄" : "";
            labels.push(`${guest} (${arrivals[0].room})${tag}`);
          }
        }
        observations.push(`Arriving tomorrow: ${labels.join(", ")}`);
      }

      // Current occupancy
      const currentGuests = active.filter((b) => b.checkin <= today && b.checkout > today);
      const uniqueGuests = new Set(currentGuests.map((b) => b.guest));
      const uniqueRooms = new Set(currentGuests.map((b) => b.room));
      observations.push(`Currently: ${uniqueGuests.size} guests in ${uniqueRooms.size} rooms`);

      if (observations.length > 0) {
        await ctx.memory.appendLog(`*[Bookings]* ${observations.join(". ")}`);
        ctx.log(observations.join("; "));

        const allArrivingToday = [...newArrivals, ...returners];
        if (allArrivingToday.length > 0 && hasNewArrivals) {
          await ctx.messages.send(
            "conversation",
            `arrivals_today:${allArrivingToday.join(", ")}`,
          );
        }
      } else if (isNewDay) {
        await ctx.memory.appendLog(`*[Bookings]* No arrivals or departures today.`);
        ctx.log("No arrivals or departures today.");
      }

      lastReportedDate = today;
      lastReportedArrivals = currentArrivalIds;
    } catch (err) {
      ctx.log(`Bookings error: ${err}`);
    }
  };
}

function groupByGuest(bookings: BookingRow[]): Map<string, BookingRow[]> {
  const map = new Map<string, BookingRow[]>();
  for (const b of bookings) {
    const existing = map.get(b.guest);
    if (existing) existing.push(b);
    else map.set(b.guest, [b]);
  }
  return map;
}
