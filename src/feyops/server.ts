/**
 * FeyOps HTTP API Server
 *
 * Serves the React frontend (static files) and provides REST API
 * for booking CRUD + Amenitiz sync.
 *
 * Run standalone: node --loader tsx src/feyops/server.ts
 * Or import startFeyOpsServer() from Feyblet's main process.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { FeyOpsDB } from "./db.js";
import { syncAmenitiz } from "./sync.js";
import { fetchOOI, getOOICacheAge } from "./ooi-fetcher.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("FeyOps");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function startFeyOpsServer(options: {
  port?: number;
  dbPath?: string;
  staticDir?: string;
} = {}): { db: FeyOpsDB; server: http.Server } {
  const port = options.port ?? (process.env.FEYOPS_PORT ? Number(process.env.FEYOPS_PORT) : 3737);
  const dbPath = options.dbPath ?? "./data/feyops.db";
  const staticDir = options.staticDir ?? path.resolve(
    new URL(".", import.meta.url).pathname, "../../feyops-ui/dist"
  );

  const db = new FeyOpsDB(dbPath);
  log.info(` DB at ${dbPath}`);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      // Bearer token auth for mutating endpoints
      const apiToken = process.env.FEYOPS_API_TOKEN;
      if (apiToken && req.method !== "GET") {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${apiToken}`) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
      }

      try {
        await handleAPI(db, req, res, url);
      } catch (err) {
        log.error(`API error: ${err}`);
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // Static files
    serveStatic(staticDir, url.pathname, res);
  });

  server.listen(port, () => {
    log.info(` Server running on http://localhost:${port}`);
  });

  // Full sync: Amenitiz API bookings + OOI via Puppeteer
  const fullSync = async () => {
    await syncAmenitiz(db, {}, (msg) => log.info(` ${msg}`)).catch(err =>
      log.error(` Amenitiz sync failed: ${err}`)
    );
    // OOI fetch — try Puppeteer, fall back to cached data
    const cacheAge = getOOICacheAge();
    const staleMs = 12 * 60 * 60 * 1000; // refresh if older than 12h
    if (!cacheAge || cacheAge > staleMs) {
      try {
        const entries = await fetchOOI();
        log.info(` OOI refreshed: ${entries.length} entries`);
        // Re-sync to pick up new OOI data
        await syncAmenitiz(db, {}, (msg) => log.info(` ${msg}`));
      } catch (err) {
        log.warn(` OOI fetch failed (using cached): ${err}`);
      }
    } else {
      log.info(` OOI cache fresh (${Math.round(cacheAge / 60000)}min old)`);
    }
  };

  // Initial sync
  fullSync();

  // Periodic sync every 6 hours
  setInterval(fullSync, 6 * 60 * 60 * 1000);

  return { db, server };
}

async function handleAPI(
  db: FeyOpsDB,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const method = req.method || "GET";
  const apiPath = url.pathname.replace("/api", "");

  // GET /api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD
  if (method === "GET" && apiPath === "/bookings") {
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    const bookings = db.getBookings(from, to);
    const rooms = db.getRooms();
    json(res, 200, { bookings, rooms });
    return;
  }

  // GET /api/bookings/:id
  if (method === "GET" && apiPath.match(/^\/bookings\/\d+$/)) {
    const id = parseInt(apiPath.split("/")[2]);
    const booking = db.getBooking(id);
    if (!booking) return json(res, 404, { error: "Not found" });
    json(res, 200, booking);
    return;
  }

  // POST /api/bookings — create admin booking
  if (method === "POST" && apiPath === "/bookings") {
    const body = await readBody(req);
    if (!body.guest || !body.room || !body.checkin || !body.checkout) {
      return json(res, 400, { error: "Missing required fields: guest, room, checkin, checkout" });
    }
    const id = db.insertAdmin({
      guest: body.guest,
      room: body.room,
      checkin: body.checkin,
      checkout: body.checkout,
      plus_one_of: body.plus_one_of,
      notes: body.notes,
      status: body.status,
    });
    json(res, 201, { id, ...db.getBooking(id) });
    return;
  }

  // PUT /api/bookings/:id — update booking
  if (method === "PUT" && apiPath.match(/^\/bookings\/\d+$/)) {
    const id = parseInt(apiPath.split("/")[2]);
    const body = await readBody(req);
    const ok = db.update(id, body);
    if (!ok) return json(res, 404, { error: "Not found or no changes" });
    json(res, 200, db.getBooking(id));
    return;
  }

  // DELETE /api/bookings/:id — delete admin booking
  if (method === "DELETE" && apiPath.match(/^\/bookings\/\d+$/)) {
    const id = parseInt(apiPath.split("/")[2]);
    const ok = db.deleteAdmin(id);
    if (!ok) return json(res, 404, { error: "Not found or not an admin booking" });
    json(res, 200, { deleted: true });
    return;
  }

  // POST /api/sync — trigger Amenitiz sync
  if (method === "POST" && apiPath === "/sync") {
    const result = await syncAmenitiz(db, {}, (msg) => log.info(` ${msg}`));
    json(res, 200, result);
    return;
  }

  // GET /api/people — list people .md files
  if (method === "GET" && apiPath === "/people") {
    const peopleDir = path.resolve(
      new URL(".", import.meta.url).pathname, "../../workspace/people"
    );
    let people: { slug: string; name: string }[] = [];
    if (fs.existsSync(peopleDir)) {
      const files = fs.readdirSync(peopleDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        const slug = file.replace(/\.md$/, "");
        const content = fs.readFileSync(path.join(peopleDir, file), "utf-8");
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?\s*$/m);
        people.push({ slug, name: nameMatch ? nameMatch[1].trim() : slug });
      }
    }
    json(res, 200, { people });
    return;
  }

  // GET /api/unmatched — unmatched guest names
  if (method === "GET" && apiPath === "/unmatched") {
    json(res, 200, { guests: db.getUnmatchedGuests() });
    return;
  }

  // POST /api/match — match a booking or guest name to a person slug
  if (method === "POST" && apiPath === "/match") {
    const body = await readBody(req);
    if (body.booking_id) {
      const ok = db.matchPerson(Number(body.booking_id), body.slug as string | null);
      json(res, ok ? 200 : 404, ok ? { matched: true } : { error: "Booking not found" });
    } else if (body.guest) {
      const count = db.matchPersonByGuest(body.guest as string, body.slug as string);
      json(res, 200, { matched: count });
    } else {
      json(res, 400, { error: "Provide booking_id or guest, and slug" });
    }
    return;
  }

  // POST /api/unmatch — remove person match from a booking
  if (method === "POST" && apiPath === "/unmatch") {
    const body = await readBody(req);
    if (body.booking_id) {
      db.matchPerson(Number(body.booking_id), null);
      json(res, 200, { unmatched: true });
    } else {
      json(res, 400, { error: "Provide booking_id" });
    }
    return;
  }

  // GET /api/nicknames
  if (method === "GET" && apiPath === "/nicknames") {
    json(res, 200, { nicknames: db.getAllNicknames() });
    return;
  }

  // POST /api/nicknames — add nickname
  if (method === "POST" && apiPath === "/nicknames") {
    const body = await readBody(req);
    if (!body.slug || !body.nickname) {
      return json(res, 400, { error: "Provide slug and nickname" });
    }
    db.addNickname(body.slug as string, body.nickname as string);
    json(res, 201, { added: true });
    return;
  }

  // DELETE /api/nicknames — remove nickname
  if (method === "DELETE" && apiPath === "/nicknames") {
    const body = await readBody(req);
    const ok = db.removeNickname(body.slug as string, body.nickname as string);
    json(res, ok ? 200 : 404, ok ? { deleted: true } : { error: "Not found" });
    return;
  }

  // GET /api/person-stats — bookings per person
  if (method === "GET" && apiPath === "/person-stats") {
    json(res, 200, { stats: db.getPersonStats() });
    return;
  }

  // GET /api/stats
  if (method === "GET" && apiPath === "/stats") {
    const today = new Date().toISOString().slice(0, 10);
    const activity = db.getTodayActivity(today);
    const allBookings = db.getBookings();
    const counts = db.getCountsBySource();
    json(res, 200, {
      total: allBookings.length,
      amenitiz: counts.amenitiz,
      ooi: counts.ooi,
      admin: counts.admin,
      arrivals_today: activity.arrivals.length,
      departures_today: activity.departures.length,
    });
    return;
  }

  json(res, 404, { error: "Not found" });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(dir: string, pathname: string, res: http.ServerResponse): void {
  let filePath = path.join(dir, pathname === "/" ? "index.html" : pathname);

  // SPA fallback: if file doesn't exist, serve index.html
  if (!fs.existsSync(filePath)) {
    filePath = path.join(dir, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(filePath).pipe(res);
}

// Run standalone
if (process.argv[1]?.includes("feyops/server")) {
  startFeyOpsServer();
}
