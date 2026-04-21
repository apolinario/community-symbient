/**
 * Feÿ memory enricher — per-person blocks only.
 *
 * Global context blocks (house-status, sauna, season, meal, broadcasts)
 * live in `workspace/extensions/providers.ts` as context providers —
 * modules declare what they want in frontmatter.
 *
 * The enricher here handles what context-providers can't express well:
 * per-matched-person data (booking history, aliases). MemoryManager
 * calls `personBlocks(slug)` during context assembly whenever a person
 * is matched, and concatenates each returned block into the <person>
 * block.
 */

import type { MemoryEnricher } from "../../../src/memory/manager.js";
import type { FeyOpsDB } from "./db.js";

export interface EnricherDeps {
  feyopsDb: FeyOpsDB;
  workspacePath: string;
}

export function createFeyEnricher(deps: EnricherDeps): MemoryEnricher {
  const { feyopsDb } = deps;

  return {
    resolveNickname: (name: string) => {
      const lower = name.toLowerCase();
      const nicknames = feyopsDb.getAllNicknames();
      const match = nicknames.find((n) => n.nickname.toLowerCase() === lower);
      return match?.slug ?? null;
    },

    personBlocks: (slug: string) => {
      const blocks: string[] = [];
      const booking = buildBookingContext(feyopsDb, slug);
      if (booking) blocks.push(`## Bookings\n${booking}`);
      const nicks = feyopsDb.getNicknames(slug);
      if (nicks.length > 0) blocks.push(`Also known as: ${nicks.join(", ")}`);
      return blocks;
    },

    // No globalBlocks — all global context comes through providers now.
  };
}

function buildBookingContext(db: FeyOpsDB, slug: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const bookings = db.getBookings().filter(
    (b) => b.person_slug === slug && b.status !== "cancelled",
  );
  if (bookings.length === 0) return null;
  return bookings.map((b) => {
    const nights = Math.ceil(
      (new Date(b.checkout).getTime() - new Date(b.checkin).getTime()) / 86_400_000,
    );
    let status: string;
    if (b.checkout <= today) status = "departed";
    else if (b.checkin <= today) status = "HERE NOW";
    else {
      const days = Math.ceil((new Date(b.checkin).getTime() - new Date(today).getTime()) / 86_400_000);
      status = `arriving in ${days} day${days === 1 ? "" : "s"}`;
    }
    return `- ${b.room} (${b.venue}): ${b.checkin} → ${b.checkout} (${nights} nights) — ${status} [${b.source}]`;
  }).join("\n");
}
