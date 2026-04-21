/**
 * Feÿ Memory Enricher — the deployment-specific context hook.
 *
 * MemoryManager in core knows nothing about bookings, guests, rooms,
 * saunas, seasons, or radio. This file re-implements those context
 * blocks using the feyops DB + workspace markdown layout that Feÿ
 * specifically uses, and plugs them into MemoryManager via
 * `memory.setEnricher(feyEnricher)`.
 *
 * Another deployment writes its own enricher (or none at all).
 */

import type { MemoryEnricher } from "../../../src/memory/manager.js";
import type { FeyOpsDB } from "./db.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface EnricherDeps {
  feyopsDb: FeyOpsDB;
  workspacePath: string;
}

function isPlaceholderGuest(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden");
}

export function createFeyEnricher(deps: EnricherDeps): MemoryEnricher {
  const { feyopsDb, workspacePath } = deps;

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

    globalBlocks: async () => {
      const blocks: string[] = [];
      const house = buildHouseSummary(feyopsDb);
      if (house) blocks.push(`<house-status>\n${house}\n</house-status>`);

      const sauna = await getLatestSaunaReading(workspacePath);
      if (sauna) blocks.push(`<sauna>\n${sauna}\n</sauna>`);

      const season = await buildSeasonDigest(workspacePath);
      if (season) blocks.push(`<season-today>\n${season}\n</season-today>`);

      const meal = await getCurrentMealContext(workspacePath);
      if (meal) blocks.push(`<current-meal>\n${meal}\n</current-meal>`);

      const broadcasts = await getRecentBroadcasts(workspacePath, 2);
      if (broadcasts) blocks.push(`<recent-broadcasts>\n${broadcasts}\n</recent-broadcasts>`);

      return blocks;
    },
  };
}

function buildBookingContext(db: FeyOpsDB, slug: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const personBookings = db.getBookings().filter(
    (b) => b.person_slug === slug && b.status !== "cancelled",
  );
  if (personBookings.length === 0) return null;

  return personBookings.map((b) => {
    const nights = Math.ceil(
      (new Date(b.checkout).getTime() - new Date(b.checkin).getTime()) / 86_400_000,
    );
    let status: string;
    if (b.checkout <= today) {
      status = "departed";
    } else if (b.checkin <= today) {
      status = "HERE NOW";
    } else {
      const days = Math.ceil((new Date(b.checkin).getTime() - new Date(today).getTime()) / 86_400_000);
      status = `arriving in ${days} day${days === 1 ? "" : "s"}`;
    }
    return `- ${b.room} (${b.venue}): ${b.checkin} → ${b.checkout} (${nights} nights) — ${status} [${b.source}]`;
  }).join("\n");
}

function buildHouseSummary(db: FeyOpsDB): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const activity = db.getTodayActivity(today);
  const allBookings = db.getBookings();
  const real = allBookings.filter((b) => !isPlaceholderGuest(b.guest));
  const currentGuests = real.filter((b) => b.checkin <= today && b.checkout > today);
  const guestNames = [...new Set(currentGuests.map((b) => b.guest))];
  const occupiedRooms = [...new Set(currentGuests.map((b) => b.room))];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const tomorrowArrivals = real.filter((b) => b.checkin === tomorrow);
  const realArrivals = activity.arrivals.filter((b) => !isPlaceholderGuest(b.guest));
  const realDepartures = activity.departures.filter((b) => !isPlaceholderGuest(b.guest));

  const lines: string[] = [
    `Today: ${guestNames.length} guests in ${occupiedRooms.length} rooms`,
    realArrivals.length > 0
      ? `Arriving today: ${realArrivals.map((b) => b.guest).join(", ")}`
      : `No arrivals today`,
    realDepartures.length > 0
      ? `Departing today: ${realDepartures.map((b) => b.guest).join(", ")}`
      : `No departures today`,
  ];
  if (tomorrowArrivals.length > 0) {
    lines.push(`Arriving tomorrow: ${tomorrowArrivals.map((b) => b.guest).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Live sauna temperature reading. Google Sheets gviz JSON query — sensor
 * spreadsheet ID is Feÿ-specific infrastructure.
 */
async function getLatestSaunaReading(workspacePath: string): Promise<string | null> {
  const SPREADSHEET_ID = "1nQioINK2QYU3MymE5u04F5K0GBASeOIC96TA4UtiQL4";
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&tq=${encodeURIComponent("order by A desc limit 1")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const raw = await res.text();
      const jsonStr = raw.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
      const data = JSON.parse(jsonStr);
      const row = data.table.rows[0];
      const temp = row?.c[1]?.v;
      if (typeof temp === "number") {
        const trend = await saunaTrendFromLog(workspacePath, temp);
        return `Sauna: ${temp}°C${trend} (live)`;
      }
    }
  } catch {}
  // Fallback: parse today's log
  const log = await safeRead(dailyLogPath(workspacePath, new Date()));
  const readings = log?.match(/\*\[Sauna\]\*.*$/gm);
  if (!readings || readings.length === 0) return null;
  const latest = readings[readings.length - 1].replace("*[Sauna]* ", "");
  const temp = parseFloat(latest.match(/(\d+\.?\d*)°C/)?.[1] || "0");
  let trend = "";
  if (readings.length >= 2) {
    const prev = parseFloat(readings[readings.length - 2].match(/(\d+\.?\d*)°C/)?.[1] || "0");
    if (temp > prev + 2) trend = " and heating up";
    else if (temp < prev - 2) trend = " and cooling down";
    else trend = " and holding steady";
  }
  return `Sauna: ${temp}°C${trend}`;
}

async function saunaTrendFromLog(workspacePath: string, currentTemp: number): Promise<string> {
  const log = await safeRead(dailyLogPath(workspacePath, new Date()));
  const readings = log?.match(/\*\[Sauna\]\*.*?(\d+\.?\d*)°C/g);
  if (!readings || readings.length === 0) return "";
  const prev = parseFloat(readings[readings.length - 1].match(/(\d+\.?\d*)°C/)?.[1] || "0");
  if (currentTemp > prev + 2) return " and heating up";
  if (currentTemp < prev - 2) return " and cooling down";
  return " and holding steady";
}

async function getRecentBroadcasts(workspacePath: string, count: number): Promise<string | null> {
  const radioLog = await safeRead(join(workspacePath, "radio", "log.md"));
  if (!radioLog) return null;
  const broadcasts: string[] = [];
  for (const section of radioLog.split("\n## ")) {
    const timeMatch = section.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
    const msg = section.match(/\*\*Broadcast:\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/);
    if (timeMatch && msg) {
      broadcasts.push(`[${timeMatch[1]}] ${msg[1].trim()}`);
    }
  }
  if (broadcasts.length === 0) return null;
  return broadcasts.slice(-count).join("\n");
}

async function getCurrentMealContext(workspacePath: string): Promise<string | null> {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  let mealType: string | null = null;
  if (mins >= 510 && mins <= 690) mealType = "breakfast";
  else if (mins >= 750 && mins <= 900) mealType = "lunch";
  else if (mins >= 1140 && mins <= 1320) mealType = "dinner";
  if (!mealType) return null;

  const content = await safeRead(join(workspacePath, "season", "meals.md"));
  if (!content) return null;
  const todayISO = now.toISOString().slice(0, 10);
  const todayLines = content.split("\n").filter((l) => l.includes(todayISO));
  if (todayLines.length === 0) return null;
  const mealLine = todayLines.find((l) => l.toLowerCase().includes(mealType!));
  if (mealLine) return `It's ${mealType} time. Today's ${mealType}: ${mealLine.trim()}`;
  return `It's ${mealType} time. Today's meals: ${todayLines.map((l) => l.trim()).join("; ")}`;
}

async function buildSeasonDigest(workspacePath: string): Promise<string | null> {
  const categories = ["meals", "events", "parties", "crispy"];
  const parts: string[] = [];
  const { rewriteStaleEntries } = await import("../../../src/core/temporal-rewrite.js");
  const now = new Date();
  const nowHour = now.getHours();
  const todayISO = now.toISOString().slice(0, 10);
  const yesterdayISO = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  for (const cat of categories) {
    const content = await safeRead(join(workspacePath, "season", `${cat}.md`));
    if (!content) continue;

    const freshLines: string[] = [];
    const staleToRewrite: Array<{ text: string; datetime: string; relativeAge: string }> = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.includes(todayISO)) {
        const timeMatch = trimmed.match(/\*\*\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2}):\*\*/);
        if (timeMatch) {
          const hoursAgo = nowHour - parseInt(timeMatch[1]);
          if (hoursAgo > 2) {
            staleToRewrite.push({
              text: trimmed,
              datetime: `${todayISO} ${timeMatch[1]}:${timeMatch[2]}`,
              relativeAge: `${hoursAgo}h ago`,
            });
            continue;
          }
        }
        freshLines.push(trimmed);
      } else if (trimmed.includes(yesterdayISO)) {
        const timeMatch = trimmed.match(/\*\*\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2}):\*\*/);
        const time = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : "00:00";
        staleToRewrite.push({ text: trimmed, datetime: `${yesterdayISO} ${time}`, relativeAge: "yesterday" });
      }
    }

    const rewrittenLines = staleToRewrite.length > 0 ? await rewriteStaleEntries(staleToRewrite) : [];
    if (freshLines.length > 0 || rewrittenLines.length > 0) {
      let block = `<${cat}>\n`;
      if (freshLines.length > 0) block += `Now/recent:\n${freshLines.join("\n")}\n`;
      if (rewrittenLines.length > 0) block += `Earlier:\n${rewrittenLines.join("\n")}\n`;
      block += `</${cat}>`;
      parts.push(block);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

async function safeRead(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}

function dailyLogPath(workspacePath: string, date: Date): string {
  return join(workspacePath, "memory", `${date.toISOString().slice(0, 10)}.md`);
}
