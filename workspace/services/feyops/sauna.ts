/**
 * Sauna Perception Module — monitors the sauna temperature.
 *
 * Reads from a Google Sheets sensor log via the gviz JSON API.
 * The spreadsheet receives ~1-minute readings from a temperature
 * sensor in the sauna. We fetch only the latest row.
 *
 * Observations are written to the daily log as natural language.
 * This is how Feyblet "experiences" the sauna — it notices,
 * it has opinions, it remembers patterns.
 */

import type { ModuleContext } from "../../../src/core/types.js";
import { recordEvent } from "../../../src/core/event-log.js";

const SPREADSHEET_ID = "1nQioINK2QYU3MymE5u04F5K0GBASeOIC96TA4UtiQL4";

interface SaunaConfig {
  spreadsheetId: string;
  hotThreshold: number;
  warmThreshold: number;
}

const DEFAULT_SAUNA_CONFIG: SaunaConfig = {
  spreadsheetId: SPREADSHEET_ID,
  hotThreshold: 70,
  warmThreshold: 40,
};

export function createSaunaModule(config: Partial<SaunaConfig> = {}) {
  const cfg = { ...DEFAULT_SAUNA_CONFIG, ...config };
  let lastReportedTemp: number | null = null;
  let lastReportedTime: Date | null = null;
  let previousTemp: number | null = null;

  return async function sauna(ctx: ModuleContext): Promise<void> {

    let reading: SaunaReading;

    // Retry with linear backoff: 1s, 2s, 3s... up to 5 attempts
    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        reading = await fetchLatestReading(cfg.spreadsheetId);
        break;
      } catch (err) {
        if (attempt === maxRetries) {
          ctx.log(`Sauna fetch failed after ${maxRetries} retries: ${err}`);
          return;
        }
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
      }
    }

    const { temperatureC, timestamp } = reading;

    // Always record the raw reading as a structured event — the watch evaluator
    // and context providers may want it even when we suppress the narrative log.
    const trend = previousTemp !== null
      ? (temperatureC > previousTemp + 2 ? "rising"
        : temperatureC < previousTemp - 2 ? "cooling" : "steady")
      : null;
    recordEvent({
      type: "sauna_reading",
      temp: temperatureC,
      trend,
      sensorTimestamp: timestamp.getTime(),
    });

    // Only report on meaningful changes
    if (!shouldReport(temperatureC, lastReportedTemp, lastReportedTime)) return;

    const observation = describeTemperature(temperatureC, previousTemp, timestamp);
    await ctx.memory.appendLog(`*[Sauna]* ${observation}`);

    // Track state transitions for notifications
    const wasHot = previousTemp !== null && previousTemp >= cfg.hotThreshold;
    const isNowHot = temperatureC >= cfg.hotThreshold;

    previousTemp = lastReportedTemp;
    lastReportedTemp = temperatureC;
    lastReportedTime = new Date();

    ctx.log(`Sauna: ${temperatureC}°C - ${observation}`);

    // Notify conversation module on meaningful state transitions
    if (isNowHot && !wasHot) {
      await ctx.messages.send("conversation", `sauna_hot:${temperatureC}`);
    }
  };
}

interface SaunaReading {
  temperatureC: number;
  temperatureF: number;
  timestamp: Date;
}

async function fetchLatestReading(spreadsheetId: string): Promise<SaunaReading> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&tq=${encodeURIComponent("order by A desc limit 1")}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`gviz returned ${res.status}`);

  const raw = await res.text();
  // Strip the JSONP wrapper: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
  const jsonStr = raw.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
  let data: GvizResponse;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse gviz response as JSON");
  }

  const row = data.table.rows[0];
  if (!row) throw new Error("No data in spreadsheet");

  const cells = row.c;
  // Column A: Timestamp as "Date(yyyy,m,d,h,m,s)" — month is 0-indexed
  const tsMatch = cells[0].v.match(/Date\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!tsMatch) throw new Error(`Cannot parse timestamp: ${cells[0].v}`);

  const timestamp = new Date(
    Number(tsMatch[1]),
    Number(tsMatch[2]), // already 0-indexed from gviz
    Number(tsMatch[3]),
    Number(tsMatch[4]),
    Number(tsMatch[5]),
    Number(tsMatch[6]),
  );

  return {
    temperatureC: cells[1].v,
    temperatureF: cells[2].v,
    timestamp,
  };
}

function shouldReport(
  current: number,
  lastTemp: number | null,
  lastTime: Date | null,
): boolean {
  if (lastTemp === null) return true;
  // Report on 5°C change
  if (Math.abs(current - lastTemp) >= 5) return true;
  // Or every 30 minutes regardless
  if (lastTime && Date.now() - lastTime.getTime() > 30 * 60 * 1000) return true;
  return false;
}

function describeTemperature(
  current: number,
  previous: number | null,
  timestamp: Date,
): string {
  const trend = previous !== null
    ? current > previous + 2 ? "rising" : current < previous - 2 ? "cooling" : "steady"
    : null;

  const age = Date.now() - timestamp.getTime();
  const stale = age > 10 * 60 * 1000; // older than 10 minutes
  const staleNote = stale ? " (reading is a bit old, sensor might be offline)" : "";

  if (current >= 70) {
    return `The sauna is hot at ${current}°C${trend === "rising" ? " and still climbing" : ""}. Ready to use.${staleNote}`;
  }
  if (current >= 40) {
    return `The sauna is warming up, currently ${current}°C${trend ? ` (${trend})` : ""}.${staleNote}`;
  }
  if (current >= 25) {
    return `The sauna is lukewarm at ${current}°C. Someone heated it recently but it's cooling off.${staleNote}`;
  }
  return `The sauna is cold (${current}°C). Nobody's heated it.${staleNote}`;
}

// --- gviz response types ---

interface GvizResponse {
  table: {
    cols: Array<{ id: string; label: string; type: string }>;
    rows: Array<{
      c: Array<{ v: any; f: string }>;
    }>;
  };
}
