/**
 * OOI Fetcher — uses Puppeteer to fetch room status (OOI/OOO/pre_booked)
 * from the Amenitiz calendar API, which requires a Cloudflare browser session.
 *
 * First run: opens a visible Chrome window for login.
 * Subsequent runs: headless, reuses the saved session profile.
 *
 * Usage:
 *   node --loader tsx src/feyops/ooi-fetcher.ts login    # Interactive login
 *   node --loader tsx src/feyops/ooi-fetcher.ts fetch    # Headless fetch
 */

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("OOI");

const CHROME_PATH = "/usr/bin/google-chrome";
const PROFILE_DIR = path.resolve("data/chrome-profile");
const OOI_CACHE = path.resolve("data/ooi-cache.json");

const CALENDAR_API = "https://chateaubourgogne.amenitiz.io/en/api/v2/calendar/rooms";

// Room ID → display name mapping (from MCP config)
const ROOM_ID_MAP: Record<number, string> = {
  48436: "Ninon de L'Enclos (Le Château)",
  50522: "Bardane (Le Château)",
  50523: "Angélique (Le Château)",
  50524: "Eglantiers (Le Château)",
  50525: "Lin (Le Château)",
  50526: "Primevère (Le Château)",
  50527: "Sureau (Le Château)",
  50516: "Valériane (Le Château)",
  50528: "Camomille (Le Château)",
  50529: "Millepertuis (Le Château)",
  50530: "Reine Des Prés (Le Château)",
  50531: "AC Eglantier (Le Chateau)",
  50532: "AC Bardane (Le Château)",
  48435: "Mélisse (Le Château)",
  50533: "Boudoir (Le Château)",
  48437: "Chambre Rose (Le Château)",
  50506: "Chambrette (Le Château)",
  50509: "Tilleul (Dorm #1)",
  167536: "Tilleul (Dorm #2)",
  167537: "Tilleul (Dorm #3)",
  167538: "Tilleul (Dorm #4)",
  50517: "Armoise (Le Cottage)",
  50518: "Gentiane (Le Cottage)",
  50519: "Thym (Le Cottage)",
  50520: "Passiflore (Le Cottage)",
  50521: "Le Gîte",
  50514: "Pensée Sauvage (La Ferme)",
  50515: "Marjolaine (La Ferme)",
  86583: "Glycine (La Ferme)",
  86586: "Chardon Marie (La Ferme)",
  86584: "Calendula (La Ferme)",
  99621: "Glamping 1",
  99622: "Glamping 3",
  99623: "Glamping 2",
};

export interface OOIEntry {
  room_id: number;
  room_name: string;
  start_date: string;
  end_date: string;
  status: string; // ooi, ooo, pre_booked
  reason: string;
}

async function launchBrowser(headless: boolean) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: headless ? "new" : false,
    userDataDir: PROFILE_DIR,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

/** Interactive login — opens visible browser */
export async function login(): Promise<void> {
  log.info("Opening Chrome for Amenitiz login...");
  log.info("Log in at https://chateaubourgogne.amenitiz.io then close the browser.");

  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  const startDate = `${year}-12-01`;
  const endDate = `${year + 1}-05-05`;
  const apiUrl = `${CALENDAR_API}?start_date=${startDate}&end_date=${endDate}`;

  log.info(`Opening: ${apiUrl}`);
  log.info("Log in if needed, then close the browser when you see the JSON data.");

  const browser = await launchBrowser(false);
  const page = await browser.newPage();
  await page.goto(apiUrl, { waitUntil: "networkidle2", timeout: 60000 });

  // Wait for browser to be closed by user
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });

  log.info("Session saved to", PROFILE_DIR);
}

/** Fetch OOI data headlessly using saved session */
export async function fetchOOI(): Promise<OOIEntry[]> {
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  const startDate = `${year}-12-01`;
  const endDate = `${year + 1}-05-05`;

  const url = `${CALENDAR_API}?start_date=${startDate}&end_date=${endDate}`;

  log.info(`[OOI] Fetching ${url} ...`);

  // Use visible browser to pass Cloudflare, then fetch via page.evaluate
  const browser = await launchBrowser(false);
  try {
    const page = await browser.newPage();

    // Navigate directly to the API URL — it will redirect to login if needed
    log.info(" Navigating to API URL...");
    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    const text = response ? await response.text() : "";

    let data: { rooms?: Array<{ room_id: number; start_date: string; end_date: string; status: string; reason?: string }> };

    try {
      data = JSON.parse(text);
    } catch {
      if (text.includes("<!DOCTYPE") || text.includes("<html")) {
        throw new Error("Got HTML instead of JSON — not logged in. Log in in the browser window, then try again.");
      }
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }

    const entries: OOIEntry[] = (data.rooms || []).map((r) => ({
      room_id: r.room_id,
      room_name: ROOM_ID_MAP[r.room_id] || `Room ${r.room_id}`,
      start_date: r.start_date,
      end_date: r.end_date,
      status: r.status,
      reason: r.reason || "",
    }));

    // Cache to disk
    fs.writeFileSync(OOI_CACHE, JSON.stringify({ fetched_at: new Date().toISOString(), entries }, null, 2));
    log.info(`[OOI] Fetched ${entries.length} status entries, cached to ${OOI_CACHE}`);

    return entries;
  } finally {
    await browser.close();
  }
}

/** Read cached OOI data (returns empty if no cache) */
export function readCachedOOI(): OOIEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(OOI_CACHE, "utf-8"));
    return data.entries || [];
  } catch {
    return [];
  }
}

/** Check if cache exists and how old it is */
export function getOOICacheAge(): number | null {
  try {
    const stat = fs.statSync(OOI_CACHE);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

// CLI entry point
if (process.argv[1]?.includes("ooi-fetcher")) {
  const cmd = process.argv[2] || "fetch";

  if (cmd === "login") {
    login().catch(console.error);
  } else if (cmd === "fetch") {
    fetchOOI()
      .then((entries) => {
        log.info(`\n${entries.length} OOI entries:`);
        for (const e of entries) {
          log.info(`  ${e.room_name}: ${e.start_date} → ${e.end_date} [${e.status}] ${e.reason}`);
        }
      })
      .catch(console.error);
  } else {
    log.info("Usage: ooi-fetcher.ts [login|fetch]");
  }
}
