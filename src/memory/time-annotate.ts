/**
 * Time Annotator — adds relative timestamps and event status to context lines.
 *
 * Two-stage pipeline:
 * 1. Regex extracts candidate event times from messages (high-confidence patterns pass through)
 * 2. Tiny LLM validates ambiguous candidates (bare HH:MM — is this an event time or not?)
 * 3. Deterministic code computes relative status from validated times
 *
 * Turns:
 *   [14:25] basile: Fundraising workshop starting in 5 minutes
 * Into:
 *   [14:25 — 5h ago] basile: Fundraising workshop starting in 5 minutes [already happened, ~14:30]
 */

import { tinyComplete } from "../core/tiny-llm.js";

const EVENT_LIKELY_OVER_MS = 2 * 60 * 60 * 1000;
const EVENT_DEFINITELY_OVER_MS = 3 * 60 * 60 * 1000;

interface ParsedLine {
  original: string;
  msgTime: Date | null;
  timeStr: string;
  dateStr: string;
  msgText: string;
}

interface EventCandidate {
  lineIndex: number;
  time: Date;
  confidence: "high" | "ambiguous";
  snippet: string; // for LLM validation
}

/**
 * Annotate multiple context lines with relative timestamps and event status.
 */
export async function annotateContextLines(lines: string[], now?: Date): Promise<string[]> {
  const ref = now || new Date();
  const today = ref.toISOString().slice(0, 10);

  // Phase 1: parse lines and extract candidates
  const parsed: ParsedLine[] = [];
  const candidates: EventCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineMatch = lines[i].match(/^\[(\d{4}-\d{2}-\d{2}\s+)?(\d{2}:\d{2})(?::\d{2})?\]\s*/);
    if (!lineMatch) {
      parsed.push({ original: lines[i], msgTime: null, timeStr: "", dateStr: "", msgText: "" });
      continue;
    }
    const dateStr = lineMatch[1]?.trim() || today;
    const timeStr = lineMatch[2];
    const msgTime = new Date(`${dateStr}T${timeStr}:00`);
    const msgText = lines[i].slice(lineMatch[0].length);
    parsed.push({
      original: lines[i],
      msgTime: isNaN(msgTime.getTime()) ? null : msgTime,
      timeStr, dateStr, msgText,
    });

    if (!isNaN(msgTime.getTime())) {
      const result = extractEventTime(msgText, msgTime);
      if (result) {
        candidates.push({ lineIndex: i, time: result.time, confidence: result.confidence, snippet: msgText.slice(0, 150) });
      }
    }
  }

  // Phase 2: validate ambiguous candidates with tiny LLM
  const ambiguous = candidates.filter(c => c.confidence === "ambiguous");
  const validated = new Set<number>(); // line indices that passed validation

  // High-confidence candidates pass automatically
  for (const c of candidates) {
    if (c.confidence === "high") validated.add(c.lineIndex);
  }

  if (ambiguous.length > 0) {
    const batchPrompt = ambiguous.map((c, i) =>
      `${i + 1}. ${c.snippet}`
    ).join("\n");

    try {
      const result = await tinyComplete({
        messages: [{
          role: "user",
          content: `For each message, does the time mentioned refer to an event or activity happening? Answer Y or N per line.

${batchPrompt}`,
        }],
        maxTokens: ambiguous.length * 5,
        timeoutMs: 5000,
      });

      if (result) {
        for (const line of result.split("\n")) {
          const m = line.match(/^(\d+)\.\s*([YN])/i);
          if (m) {
            const idx = parseInt(m[1]) - 1;
            if (idx >= 0 && idx < ambiguous.length && m[2].toUpperCase() === "Y") {
              validated.add(ambiguous[idx].lineIndex);
            }
          }
        }
      } else {
        // LLM failed — accept all ambiguous candidates (better to over-annotate than miss)
        for (const c of ambiguous) validated.add(c.lineIndex);
      }
    } catch {
      // LLM unavailable — accept all ambiguous
      for (const c of ambiguous) validated.add(c.lineIndex);
    }
  }

  // Phase 3: build annotated lines
  const candidateMap = new Map(candidates.map(c => [c.lineIndex, c]));

  return parsed.map((p, i) => {
    if (!p.msgTime) return p.original;

    // Message timestamp annotation
    const msgAge = ref.getTime() - p.msgTime.getTime();
    const msgRel = formatRelative(msgAge);
    const prefix = `[${p.dateStr !== today ? p.dateStr + " " : ""}${p.timeStr} — ${msgRel}]`;

    // Event annotation (only if validated)
    let eventNote = "";
    const candidate = candidateMap.get(i);
    if (candidate && validated.has(i)) {
      const diff = ref.getTime() - candidate.time.getTime();
      const label = candidate.time.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      if (diff > EVENT_DEFINITELY_OVER_MS) {
        eventNote = ` [already happened, ~${label}]`;
      } else if (diff > EVENT_LIKELY_OVER_MS) {
        eventNote = ` [probably over by now, started ~${label}]`;
      } else if (diff > 0) {
        eventNote = ` [might still be happening, started ~${label}]`;
      } else {
        eventNote = ` [happening ${formatUntil(-diff)}, ~${label}]`;
      }
    }

    return `${prefix} ${p.msgText}${eventNote}`;
  });
}

/**
 * Extract a candidate event time from message text.
 * Returns the time and confidence level.
 * "high" = clear pattern like "at 5.30pm", "in 5 min", "tonight at 9"
 * "ambiguous" = bare HH:MM that might or might not be an event time
 */
function extractEventTime(text: string, msgTime: Date): { time: Date; confidence: "high" | "ambiguous" } | null {
  const lower = text.toLowerCase();
  let m: RegExpMatchArray | null;
  let t: Date | null;

  // --- HIGH CONFIDENCE patterns ---

  // "in X min/minutes"
  m = lower.match(/\bin\s+(\d+)\s*(?:min(?:utes?)?|m(?:in)?)\b/);
  if (m) return { time: new Date(msgTime.getTime() + parseInt(m[1]) * 60000), confidence: "high" };

  // "in Xh / X hours"
  m = lower.match(/\bin\s+(\d+)\s*(?:h(?:ours?)?)\b/);
  if (m) return { time: new Date(msgTime.getTime() + parseInt(m[1]) * 3600000), confidence: "high" };

  // "starting now" / "happening now"
  if (/\b(?:starting|happening|begins?|going on)\s+now\b/.test(lower)) {
    return { time: new Date(msgTime.getTime()), confidence: "high" };
  }

  // "at H.MMpm/am" (european style like "5.30pm")
  m = lower.match(/\bat\s+(\d{1,2})\.(\d{2})\s*(am|pm)\b/);
  if (m) { t = buildTime(toH24(parseInt(m[1]), m[3]), parseInt(m[2]), msgTime); if (t) return { time: t, confidence: "high" }; }

  // "at HH:MM am/pm"
  m = lower.match(/\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/);
  if (m) { t = buildTime(toH24(parseInt(m[1]), m[3]), parseInt(m[2]), msgTime); if (t) return { time: t, confidence: "high" }; }

  // "at Hpm/Ham" or "at H pm/am"
  m = lower.match(/\bat\s+(\d{1,2})\s*(am|pm)\b/);
  if (m) { t = buildTime(toH24(parseInt(m[1]), m[2]), 0, msgTime); if (t) return { time: t, confidence: "high" }; }

  // "tonight at H" / "this evening at H"
  m = lower.match(/(?:tonight|this evening)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\b/);
  if (m) {
    let h = parseInt(m[1]);
    if (h < 12) h += 12;
    t = buildTime(h, m[2] ? parseInt(m[2]) : 0, msgTime);
    if (t) return { time: t, confidence: "high" };
  }

  // "tomorrow at H:MM"
  m = lower.match(/tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (m) {
    let h = m[3] ? toH24(parseInt(m[1]), m[3]) : parseInt(m[1]);
    t = buildTime(h, m[2] ? parseInt(m[2]) : 0, msgTime);
    if (t) { t.setDate(t.getDate() + 1); return { time: t, confidence: "high" }; }
  }

  // "starts/meet/opens at HH:MM" or "from HH:MM"
  m = lower.match(/(?:starts?|begins?|meet|gather|opens?|from)\s+(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  if (m) { t = buildTime(parseInt(m[1]), parseInt(m[2]), msgTime); if (t) return { time: t, confidence: "high" }; }

  // "at HH:MM" (with "at" keyword — moderately confident)
  m = lower.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
  if (m) {
    let h = parseInt(m[1]);
    if (h >= 1 && h <= 9 && msgTime.getHours() >= 12) h += 12;
    t = buildTime(h, parseInt(m[2]), msgTime);
    if (t) return { time: t, confidence: "high" };
  }

  // --- AMBIGUOUS patterns (need LLM validation) ---

  // "HH:MM" at start of message content (after "name: ")
  m = lower.match(/^[^:]+:\s*(\d{1,2}):(\d{2})\b/);
  if (m) {
    const h = parseInt(m[1]);
    const min = parseInt(m[2]);
    t = buildTime(h, min, msgTime);
    if (t) return { time: t, confidence: "ambiguous" };
  }

  // Bare "HH:MM" anywhere in a short message
  if (text.length < 300) {
    m = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m) {
      let h = parseInt(m[1]);
      const min = parseInt(m[2]);
      if (h >= 1 && h <= 9 && msgTime.getHours() >= 12) h += 12;
      t = buildTime(h, min, msgTime);
      if (t) return { time: t, confidence: "ambiguous" };
    }
  }

  // Bare "at H" without am/pm
  m = lower.match(/\bat\s+(\d{1,2})\b(?!\s*(?:am|pm|:|\.|\d))/);
  if (m) {
    let h = parseInt(m[1]);
    if (h >= 1 && h <= 9) h += 12;
    t = buildTime(h, 0, msgTime);
    if (t) return { time: t, confidence: "ambiguous" };
  }

  return null;
}

function toH24(h: number, ampm: string): number {
  if (ampm === "pm" && h < 12) return h + 12;
  if (ampm === "am" && h === 12) return 0;
  return h;
}

function buildTime(h: number, m: number, msgTime: Date): Date | null {
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  const d = new Date(msgTime);
  d.setHours(h, m, 0, 0);
  return d;
}

function formatRelative(diffMs: number): string {
  const mins = Math.round(Math.abs(diffMs) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}min ago`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return remMin > 10 ? `${hrs}h${remMin}m ago` : `${hrs}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function formatUntil(diffMs: number): string {
  const mins = Math.round(diffMs / 60000);
  if (mins < 2) return "right now";
  if (mins < 60) return `in ${mins}min`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return remMin > 10 ? `in ${hrs}h${remMin}m` : `in ${hrs}h`;
  return `in ${Math.floor(mins / 1440)}d`;
}
