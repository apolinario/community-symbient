/**
 * FeyOps tools — person lookup, booking queries, season log.
 * Person lookup + booking queries read from the FeyOps PMS.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { FeyOpsDB } from "./db.js";
import type { MemoryManager } from "../../../src/memory/manager.js";

/** Render a booking's stay-status relative to a YYYY-MM-DD reference date. */
function bookingStatusLabel(b: { checkin: string; checkout: string }, today: string): string {
  if (b.checkout <= today) return "departed";
  if (b.checkin <= today) return "HERE NOW";
  const days = Math.ceil((new Date(b.checkin).getTime() - new Date(today).getTime()) / 86400000);
  return `arriving in ${days} day${days === 1 ? "" : "s"}`;
}

export function createLookupPersonTool(db: FeyOpsDB, memory: MemoryManager): AgentTool {
  return {
    name: "lookup_person",
    description: "Look up a person by name — shows their profile, current room, booking dates, and whether they're here now",
    label: "Person Lookup",
    parameters: Type.Object({
      name: Type.String({ description: "Person name to look up" }),
    }),
    execute: async (_id, params) => {
      const name = params.name.trim();
      const today = new Date().toISOString().slice(0, 10);
      const parts: string[] = [];

      // Search bookings
      const allBookings = db.getBookings();
      const lower = name.toLowerCase();
      const matched = allBookings.filter((b) => {
        const guestLower = b.guest.toLowerCase();
        return guestLower.includes(lower) || lower.includes(guestLower.split(" ")[0]);
      });

      if (matched.length > 0) {
        const guests = [...new Set(matched.map((b) => b.guest))];
        for (const guest of guests) {
          const bookings = matched.filter((b) => b.guest === guest);
          parts.push(`**${guest}**`);
          for (const b of bookings) {
            const status = bookingStatusLabel(b, today);
            parts.push(`  ${b.room} (${b.venue}): ${b.checkin} → ${b.checkout} — ${status}`);
          }
        }
      } else {
        parts.push(`No bookings found for "${name}".`);
      }

      // Check people profile
      const person = await memory.readPerson(name);
      if (person) {
        const fmMatch = person.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) parts.push(`\nProfile: ${fmMatch[1].trim()}`);
      }

      return { content: [{ type: "text", text: parts.join("\n") }], details: {} };
    },
  };
}
export function createCheckBookingsTool(db: FeyOpsDB): AgentTool {
  return {
    name: "check_bookings",
    description: "Check booking system — arrivals, departures, who's here today, room occupancy",
    label: "Check Bookings",
    parameters: Type.Object({
      query: Type.String({ description: "What to check: 'today', 'arrivals', 'departures', or a general question" }),
    }),
    execute: async (_id, params) => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const allBookings = db.getBookings();
      const isPlaceholder = (name: string) => {
        const lower = name.toLowerCase();
        return lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden");
      };
      const real = allBookings.filter((b) => !isPlaceholder(b.guest));
      const currentGuests = real.filter((b) => b.checkin <= today && b.checkout > today);
      const parts: string[] = [];

      parts.push(`**Currently here**: ${new Set(currentGuests.map(b => b.guest)).size} guests`);

      const todayArrivals = real.filter((b) => b.checkin === today);
      if (todayArrivals.length > 0) parts.push(`**Arriving today**: ${todayArrivals.map(b => `${b.guest} (${b.room})`).join(", ")}`);

      const todayDepartures = real.filter((b) => b.checkout === today);
      if (todayDepartures.length > 0) parts.push(`**Departing today**: ${todayDepartures.map(b => `${b.guest} (${b.room})`).join(", ")}`);

      const tomorrowArrivals = real.filter((b) => b.checkin === tomorrow);
      if (tomorrowArrivals.length > 0) parts.push(`**Arriving tomorrow**: ${tomorrowArrivals.map(b => `${b.guest} (${b.room})`).join(", ")}`);

      return { content: [{ type: "text", text: parts.join("\n") }], details: {} };
    },
  };
}
export function createSeasonLogTool(workspacePath: string): AgentTool {
  const appendFile = async (path: string, data: string, encoding: string) => {
    const fs = await import("node:fs/promises");
    await fs.appendFile(path, data, encoding as BufferEncoding);
  };
  const join = (...parts: string[]) => parts.join("/");

  const categories: Record<string, string> = {
    events: "season/events.md",
    parties: "season/parties.md",
    meals: "season/meals.md",
    crispy: "season/crispy.md",
  };

  return {
    name: "season_log",
    description: "Log something to the season record — events, parties, meals, or crispy bits",
    label: "Season Log",
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("events"),
        Type.Literal("parties"),
        Type.Literal("meals"),
        Type.Literal("crispy"),
      ], { description: "Category to log to" }),
      entry: Type.String({ description: "What to log" }),
    }),
    execute: async (_id, params) => {
      if (!categories[params.category]) {
        return { content: [{ type: "text", text: `Unknown category. Use: ${Object.keys(categories).join(", ")}` }], details: {} };
      }
      const fs = await import("node:fs/promises");
      const filePath = join(workspacePath, categories[params.category]);
      const today = new Date().toISOString().slice(0, 10);

      // Check for duplicate — read today's entries and skip if similar
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const todayEntries = content.split("\n").filter((l: string) => l.includes(`**${today}:**`));
        const entryLower = params.entry.toLowerCase().slice(0, 60);
        const isDuplicate = todayEntries.some((e: string) => {
          const existing = e.toLowerCase();
          // Check if the core topic already exists (first 60 chars similarity)
          return existing.includes(entryLower.slice(0, 30));
        });
        if (isDuplicate) {
          return { content: [{ type: "text", text: `Already logged something similar to ${params.category} today. Recent entries:\n${todayEntries.slice(-3).join("\n")}` }], details: {} };
        }
      } catch {}

      const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const line = `\n*   **${today} ${timeStr}:** ${params.entry}\n`;
      await appendFile(filePath, line, "utf-8");
      return { content: [{ type: "text", text: `Logged to ${params.category}: "${params.entry}"` }], details: {} };
    },
  };
}
