/**
 * Onboarding/Offboarding Module — sends welcome and goodbye messages.
 *
 * Runs once per day. Checks the FeyOps DB for:
 * - Tomorrow's arrivals → sends onboarding DM today
 * - Yesterday's departures → sends offboarding DM today
 *
 * Templates are in workspace/community/onboarding.md and offboarding.md.
 * Placeholders: {name}, {room}, {venue}
 */

import type { ModuleContext } from "../../core/types.js";
import type { FeyOpsDB, BookingRow } from "../../feyops/db.js";
import type { ChatAdapter } from "../../adapters/chat/types.js";
import { formatDate, addDays } from "../../core/date-utils.js";

export function createOnboardingModule(db: FeyOpsDB, bridge: ChatAdapter) {
  let lastRunDate: string | null = null;

  return async function onboarding(ctx: ModuleContext): Promise<void> {
    const today = formatDate(new Date());

    // Only run once per day
    if (lastRunDate === today) return;
    lastRunDate = today;

    const tomorrow = formatDate(addDays(new Date(), 1));
    const yesterday = formatDate(addDays(new Date(), -1));

    // Load templates
    const onboardTemplate = await ctx.memory.readFile("community/onboarding.md");
    const offboardTemplate = await ctx.memory.readFile("community/offboarding.md");

    // Get bookings
    const allBookings = db.getBookings();

    // Tomorrow's arrivals → onboarding DM
    const arrivals = allBookings.filter((b) => b.checkin === tomorrow && b.status === "confirmed");
    if (onboardTemplate && arrivals.length > 0) {
      // Deduplicate by guest name (same person may have multiple room bookings)
      const seen = new Set<string>();
      for (const booking of arrivals) {
        if (seen.has(booking.guest)) continue;
        seen.add(booking.guest);

        const phone = await findPhoneForGuest(ctx, booking);
        if (!phone) {
          ctx.log(`Onboard: no phone for ${booking.guest}, skipping`);
          continue;
        }

        const message = fillTemplate(extractBody(onboardTemplate), booking);
        try {
          await bridge.send({ to: phone, text: message });
          await ctx.memory.appendLog(`*[Onboarding]* Sent welcome to ${booking.guest} (arriving tomorrow in ${booking.room})`);
          ctx.log(`Onboard: sent to ${booking.guest}`);
        } catch (err) {
          ctx.log(`Onboard: failed to send to ${booking.guest}: ${err}`);
        }
      }
    }

    // Yesterday's departures → offboarding DM
    const departures = allBookings.filter((b) => b.checkout === yesterday);
    if (offboardTemplate && departures.length > 0) {
      const seen = new Set<string>();
      for (const booking of departures) {
        if (seen.has(booking.guest)) continue;
        seen.add(booking.guest);

        // Skip if they have another active booking (they're not actually leaving)
        const stillHere = allBookings.some(
          (b) => b.guest === booking.guest && b.checkin <= today && b.checkout > today,
        );
        if (stillHere) continue;

        const phone = await findPhoneForGuest(ctx, booking);
        if (!phone) {
          ctx.log(`Offboard: no phone for ${booking.guest}, skipping`);
          continue;
        }

        const message = fillTemplate(extractBody(offboardTemplate), booking);
        try {
          await bridge.send({ to: phone, text: message });
          await ctx.memory.appendLog(`*[Offboarding]* Sent goodbye to ${booking.guest} (departed yesterday from ${booking.room})`);
          ctx.log(`Offboard: sent to ${booking.guest}`);
        } catch (err) {
          ctx.log(`Offboard: failed to send to ${booking.guest}: ${err}`);
        }
      }
    }

    if (arrivals.length === 0 && departures.length === 0) {
      ctx.log("No arrivals tomorrow or departures yesterday.");
    }
  };
}

/** Extract the message body from the template (everything after the --- separator) */
function extractBody(template: string): string {
  const parts = template.split(/^---$/m);
  // Take the last part after the final ---
  return (parts[parts.length - 1] || template).trim();
}

/** Replace {name}, {room}, {venue} placeholders */
function fillTemplate(template: string, booking: BookingRow): string {
  return template
    .replace(/\{name\}/g, booking.guest.split(" ")[0]) // first name only
    .replace(/\{room\}/g, booking.room)
    .replace(/\{venue\}/g, booking.venue);
}

/** Try to find a phone number for a guest via their people/*.md profile */
async function findPhoneForGuest(ctx: ModuleContext, booking: BookingRow): Promise<string | null> {
  // Try the person slug from the booking
  if (booking.person_slug && booking.person_slug !== "__unlinked__") {
    const profile = await ctx.memory.readFile(`people/${booking.person_slug}.md`);
    if (profile) {
      const phoneMatch = profile.match(/^phone:\s*"?([^"\n]+)"?/m);
      if (phoneMatch) return phoneMatch[1].replace(/\s+/g, "");
    }
  }

  // Try matching by guest name
  const person = await ctx.memory.readPerson(booking.guest);
  if (person) {
    const phoneMatch = person.match(/^phone:\s*"?([^"\n]+)"?/m);
    if (phoneMatch) return phoneMatch[1].replace(/\s+/g, "");
  }

  return null;
}
