/**
 * People Sync Module — ensures person files exist for everyone in the community.
 *
 * Sources:
 * - Bookings DB: guests with current/upcoming bookings get profiles
 * - Daily log: anyone who messages in the group gets a profile
 *
 * Also enriches existing profiles with booking history (no LLM needed).
 * LLM-based profile enrichment is handled by people-enrich (separate module).
 *
 * Runs every 30 minutes.
 */

import type { ModuleContext } from "../../../src/core/types.js";
import type { FeyOpsDB, BookingRow } from "../feyops/db.js";
import type { MemoryManager } from "../../../src/memory/manager.js";
import { slugify } from "../../../src/core/slugify.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatDate, addDays } from "../../../src/core/date-utils.js";

export function createPeopleSyncModule(db: FeyOpsDB, memory: MemoryManager) {
  return async function peopleSync(ctx: ModuleContext): Promise<void> {
    const workspacePath = "./workspace";
    let created = 0;
    let enriched = 0;

    try {
      // --- 1. Sync from bookings: current + upcoming guests ---
      const today = formatDate(new Date());
      const future = formatDate(addDays(new Date(), 14));
      const allBookings = db.getBookings();
      const active = allBookings.filter((b) => b.status !== "cancelled");
      const upcoming = active.filter((b) => b.checkout >= today && b.checkin <= future);

      // Deduplicate by guest name
      const guestNames = new Map<string, BookingRow[]>();
      for (const b of upcoming) {
        const existing = guestNames.get(b.guest);
        if (existing) existing.push(b);
        else guestNames.set(b.guest, [b]);
      }

      for (const [guest, bookings] of guestNames) {
        // Skip placeholders
        const lower = guest.toLowerCase();
        if (lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden")) continue;

        const result = await matchPerson(memory, guest);
        if (result) {
          // Person exists — enrich with booking history
          const didEnrich = await enrichWithBookings(workspacePath, result.slug, guest, active);
          if (didEnrich) enriched++;
        } else {
          // New person — create profile from booking
          await createPersonFromBooking(workspacePath, guest, bookings[0], active);
          created++;
        }
      }

      // --- 2. Scan today's log for unknown message senders ---
      const todayLog = await memory.readTodayLog();
      if (todayLog) {
        const senderPattern = /^\*\*([^*]+)\*\*\s*\((?:group|dm)/gm;
        const seenNames = new Set<string>();
        let m;
        while ((m = senderPattern.exec(todayLog)) !== null) {
          const name = m[1];
          if (name === "Feyblet") continue;
          seenNames.add(name);
        }

        for (const name of seenNames) {
          const result = await matchPerson(memory, name);
          if (!result) {
            await createPersonFromMessage(workspacePath, name);
            created++;
          }
        }
      }

      if (created > 0 || enriched > 0) {
        ctx.log(`People sync: ${created} created, ${enriched} enriched`);
      }
    } catch (err) {
      ctx.log(`People sync error: ${err}`);
    }
  };
}

async function matchPerson(
  memory: MemoryManager,
  name: string,
): Promise<{ slug: string; content: string } | null> {
  const found = await memory.findPerson(name);
  if (found) return found;

  // Try first name only (Signal names are often just first names)
  const firstName = name.split(/\s+/)[0];
  if (firstName !== name && firstName.length > 2) {
    const firstNameMatch = await memory.findPerson(firstName);
    if (firstNameMatch) return firstNameMatch;
  }

  return null;
}

/** Build booking history summary for a person. */
function buildBookingHistory(guest: string, allBookings: BookingRow[]): string {
  const guestBookings = allBookings.filter((b) =>
    b.guest === guest || b.guest.startsWith(guest) || guest.startsWith(b.guest),
  );
  if (guestBookings.length === 0) return "";

  const stays = guestBookings.map((b) => `${b.checkin} → ${b.checkout} (${b.room})`);
  const totalNights = guestBookings.reduce((sum, b) => {
    const nights = Math.max(1, Math.round((new Date(b.checkout).getTime() - new Date(b.checkin).getTime()) / 86400000));
    return sum + nights;
  }, 0);
  const rooms = [...new Set(guestBookings.map((b) => b.room))];
  const isReturner = guestBookings.length > 1;

  const lines = [
    `## Booking History`,
    ``,
    `Total stays: ${guestBookings.length} | Total nights: ${totalNights}${isReturner ? " | Returner" : ""}`,
    `Rooms: ${rooms.join(", ")}`,
    ``,
    ...stays.map((s) => `- ${s}`),
  ];
  return lines.join("\n");
}

/** Enrich an existing person file with booking history if outdated. */
async function enrichWithBookings(
  workspacePath: string,
  slug: string,
  guest: string,
  allBookings: BookingRow[],
): Promise<boolean> {
  const path = join(workspacePath, "people", `${slug}.md`);
  let content: string;
  try { content = await readFile(path, "utf-8"); } catch { return false; }

  const history = buildBookingHistory(guest, allBookings);
  if (!history) return false;

  // Replace existing booking history or append
  if (content.includes("## Booking History")) {
    const updated = content.replace(/## Booking History[\s\S]*?(?=\n## |\n*$)/, history);
    if (updated === content) return false;
    await writeFile(path, updated, "utf-8");
  } else {
    await writeFile(path, content.trimEnd() + "\n\n" + history + "\n", "utf-8");
  }
  return true;
}

async function createPersonFromBooking(
  workspacePath: string,
  guest: string,
  booking: BookingRow,
  allBookings: BookingRow[],
): Promise<void> {
  const slug = slugify(guest);
  const path = join(workspacePath, "people", `${slug}.md`);
  try { await readFile(path, "utf-8"); return; } catch {} // Don't overwrite

  const now = new Date().toISOString().slice(0, 10);
  const history = buildBookingHistory(guest, allBookings);
  const content = `---
name: ${guest}
first-encountered: ${now}
source: booking
---

# ${guest}

${history}
`;
  await writeFile(path, content, "utf-8");
}

async function createPersonFromMessage(workspacePath: string, name: string): Promise<void> {
  const slug = slugify(name);
  const path = join(workspacePath, "people", `${slug}.md`);
  try { await readFile(path, "utf-8"); return; } catch {} // Don't overwrite

  const now = new Date().toISOString().slice(0, 10);
  const content = `---
name: ${name}
first-encountered: ${now}
source: signal
---

# ${name}
`;
  await writeFile(path, content, "utf-8");
}
