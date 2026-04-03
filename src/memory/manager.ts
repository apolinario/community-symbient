/**
 * Memory Manager — OpenClaw-style Markdown memory for Feyblet.
 *
 * The memory system is just files:
 * - SOUL.md          — Feyblet's identity, values, tensions
 * - MEMORY.md        — Curated long-term knowledge
 * - memory/YYYY-MM-DD.md — Daily logs (append-only journals)
 * - people/<name>.md — Per-person relational memory
 * - inner/           — Internal reflections, Magi debates, prompt changes
 * - community/       — Shared patterns, onboarding docs, duties
 * - skills/          — Skill directories with SKILL.md (Agent Skills standard)
 *
 * No vector store. No embeddings. Just files the community can read and edit.
 * Search comes later (Phase 4) via SQLite FTS5.
 */

import { readFile, writeFile, appendFile, mkdir, access, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { MemoryReader, MemoryWriter, SearchResult } from "../core/types.js";
import type { FeyOpsDB, BookingRow, PersonNickname } from "../feyops/db.js";
import { slugify } from "../core/slugify.js";

type LLMSummarizer = {
  complete(opts: { system: string; messages: Array<{ role: "user"; content: string }>; temperature?: number; maxTokens?: number }): Promise<string>;
};

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

export interface QmdResult {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string;
  snippet: string;
}

export interface PersonMeta {
  name: string;
  filename: string;
  fields: Record<string, string>;
  path: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class MemoryManager implements MemoryReader, MemoryWriter {
  private skillCache: SkillMeta[] | null = null;
  private skillCacheTime = 0;
  private peopleCache: PersonMeta[] | null = null;
  private peopleCacheTime = 0;
  private feyopsDb: FeyOpsDB | null = null;

  constructor(private workspacePath: string) {}

  /** Connect to FeyOps DB for booking context */
  setFeyOpsDB(db: FeyOpsDB): void {
    this.feyopsDb = db;
  }

  // --- MemoryReader ---

  async readFile(relPath: string): Promise<string | null> {
    return this.safeRead(join(this.workspacePath, relPath));
  }

  async readTodayLog(): Promise<string | null> {
    return this.safeRead(this.dailyLogPath(new Date()));
  }

  async readYesterdayLog(): Promise<string | null> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.safeRead(this.dailyLogPath(yesterday));
  }

  async readSoul(): Promise<string | null> {
    return this.safeRead(join(this.workspacePath, "SOUL.md"));
  }

  async readMemory(): Promise<string | null> {
    return this.safeRead(join(this.workspacePath, "MEMORY.md"));
  }

  async readPerson(name: string): Promise<string | null> {
    return this.findAndReadPerson(name);
  }

  /**
   * Find a person by name or phone (fuzzy: matches against frontmatter name,
   * filename, first name, FeyOps nicknames, or phone number).
   * Returns their slug (filename without .md) and full profile content.
   */
  async findPerson(name: string, phone?: string): Promise<{ slug: string; content: string } | null> {
    const people = await this.discoverPeople();
    const lower = name.toLowerCase();

    let match: PersonMeta | undefined;

    // Try phone number match FIRST — most reliable identifier
    if (!match && phone) {
      const cleanPhone = phone.replace(/\s+/g, "");
      match = people.find((p) => {
        const pPhone = p.fields.phone?.replace(/\s+/g, "");
        return pPhone && (pPhone === cleanPhone || pPhone.endsWith(cleanPhone.slice(-9)) || cleanPhone.endsWith(pPhone.slice(-9)));
      });
    }

    // Try exact match on frontmatter name
    if (!match) {
      match = people.find((p) => p.name.toLowerCase() === lower);
    }

    // Try FeyOps nicknames
    if (!match && this.feyopsDb) {
      const nicknames = this.feyopsDb.getAllNicknames();
      const nickMatch = nicknames.find((n) => n.nickname.toLowerCase() === lower);
      if (nickMatch) {
        match = people.find((p) => p.filename === nickMatch.slug);
      }
    }

    // Try first name match
    if (!match) {
      match = people.find((p) => p.name.toLowerCase().startsWith(lower + " ") || p.name.toLowerCase() === lower);
    }

    // Try substring match on name
    if (!match) {
      match = people.find((p) => p.name.toLowerCase().includes(lower));
    }

    // Try filename match (last resort — auto-created files may be stale)
    if (!match) {
      const safeName = slugify(name);
      match = people.find((p) => p.filename === safeName || p.filename.startsWith(safeName));
    }

    if (!match) return null;
    const content = await this.safeRead(match.path);
    if (!content) return null;
    return { slug: match.filename, content };
  }

  /** Legacy interface: find and read person by name only */
  private async findAndReadPerson(name: string): Promise<string | null> {
    const result = await this.findPerson(name);
    return result?.content ?? null;
  }

  // Search is a stub for now — Phase 4 adds SQLite FTS5 + optional embeddings
  async search(_query: string, _maxResults?: number): Promise<SearchResult[]> {
    return [];
  }

  // --- MemoryWriter ---

  private summarizer: LLMSummarizer | null = null;

  /** Set the LLM client for daily summaries */
  setSummarizer(llm: { complete(opts: { system: string; messages: Array<{ role: "user"; content: string }>; temperature?: number; maxTokens?: number }): Promise<string> }): void {
    this.summarizer = llm as LLMSummarizer;
  }

  async appendLog(entry: string): Promise<void> {
    const now = new Date();
    const logPath = this.dailyLogPath(now);
    const timestamp = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const line = `\n## ${timestamp}\n\n${entry}\n`;
    await this.ensureDir(dirname(logPath));
    await appendFile(logPath, line, "utf-8");

    // Re-summarize the day (fire and forget — don't block the caller)
    this.resummarizeDay(now).catch(() => {});
  }

  /**
   * Re-summarize today's log into a single paragraph using the LLM.
   * Overwrites the summary file each time so it's always current.
   */
  private async resummarizeDay(date: Date): Promise<void> {
    if (!this.summarizer) return;

    const logPath = this.dailyLogPath(date);
    const log = await this.safeRead(logPath);
    if (!log || log.length < 100) return;

    // Truncate if very long to keep the LLM call fast
    const truncated = log.length > 6000
      ? log.slice(0, 3000) + "\n...\n" + log.slice(-3000)
      : log;

    try {
      const summary = await this.summarizer.complete({
        system: "Summarize this day's log into one short paragraph (3-5 sentences). Be factual: who talked, what happened, key events. No editorializing. Output ONLY the summary paragraph, nothing else.",
        messages: [{ role: "user" as const, content: truncated }],
        temperature: 0.3,
        maxTokens: 200,
      });

      if (summary.trim()) {
        const summaryPath = this.dailySummaryPath(date);
        await this.ensureDir(dirname(summaryPath));
        await writeFile(summaryPath, summary.trim(), "utf-8");
      }
    } catch {
      // LLM down? No problem — summary just stays stale
    }
  }

  private dailySummaryPath(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return join(this.workspacePath, "memory", `${yyyy}-${mm}-${dd}.summary.md`);
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const fullPath = join(this.workspacePath, relPath);
    await this.ensureDir(dirname(fullPath));
    await writeFile(fullPath, content, "utf-8");
  }

  async appendFile(relPath: string, content: string): Promise<void> {
    const fullPath = join(this.workspacePath, relPath);
    await this.ensureDir(dirname(fullPath));
    await appendFile(fullPath, content, "utf-8");
  }

  // --- Skills (Agent Skills standard, progressive disclosure) ---

  /**
   * Discover all skills and extract name + description from YAML frontmatter.
   * Follows Pi's pattern: skills/ contains directories with SKILL.md files.
   */
  async discoverSkills(): Promise<SkillMeta[]> {
    if (this.skillCache && Date.now() - this.skillCacheTime < CACHE_TTL_MS) return this.skillCache;

    const skillsDir = join(this.workspacePath, "skills");
    const skills: SkillMeta[] = [];

    try {
      const entries = await readdir(skillsDir);
      for (const entry of entries) {
        const entryPath = join(skillsDir, entry);
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          // Standard: skills/<name>/SKILL.md
          const skillPath = join(entryPath, "SKILL.md");
          const meta = await this.parseSkillFrontmatter(skillPath);
          if (meta) skills.push({ ...meta, path: skillPath });
        } else if (entry.endsWith(".md")) {
          // Also support flat: skills/<name>.md
          const meta = await this.parseSkillFrontmatter(entryPath);
          if (meta) skills.push({ ...meta, path: entryPath });
        }
      }
    } catch {
      // No skills directory — that's fine
    }

    this.skillCache = skills;
    this.skillCacheTime = Date.now();
    return skills;
  }

  /** Read the full content of a skill by name. */
  async readSkill(name: string): Promise<string | null> {
    const skills = await this.discoverSkills();
    const skill = skills.find((s) => s.name === name);
    if (!skill) return null;
    return this.safeRead(skill.path);
  }

  /** Invalidate the skill cache (e.g., after adding a new skill). */
  invalidateSkillCache(): void {
    this.skillCache = null;
  }

  // --- People (same progressive disclosure pattern) ---

  /**
   * Discover all people and extract frontmatter metadata.
   * Only names + key fields go into context. Full profiles load on demand.
   */
  async discoverPeople(): Promise<PersonMeta[]> {
    if (this.peopleCache && Date.now() - this.peopleCacheTime < CACHE_TTL_MS) return this.peopleCache;

    const peopleDir = join(this.workspacePath, "people");
    const people: PersonMeta[] = [];

    try {
      const files = await readdir(peopleDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(peopleDir, file);
        const content = await this.safeRead(filePath);
        if (!content) continue;

        const fm = parseFrontmatter(content);
        if (!fm || !fm.name) continue;

        people.push({
          name: fm.name,
          filename: file.replace(".md", ""),
          fields: fm,
          path: filePath,
        });
      }
    } catch {
      // No people directory
    }

    this.peopleCache = people;
    this.peopleCacheTime = Date.now();
    return people;
  }

  /** Invalidate the people cache. */
  invalidatePeopleCache(): void {
    this.peopleCache = null;
  }

  // --- Booking Context ---

  /**
   * Get booking context for a person from FeyOps DB.
   * Returns formatted text about their current/upcoming bookings, room, dates.
   */
  private getBookingContext(slug: string): string | null {
    if (!this.feyopsDb) return null;

    const today = new Date().toISOString().slice(0, 10);
    const allBookings = this.feyopsDb.getBookings();
    const personBookings = allBookings.filter(
      (b) => b.person_slug === slug && b.status !== "cancelled"
    );

    if (personBookings.length === 0) return null;

    const lines: string[] = [];
    for (const b of personBookings) {
      const nights = Math.ceil(
        (new Date(b.checkout).getTime() - new Date(b.checkin).getTime()) / (1000 * 60 * 60 * 24)
      );
      let status: string;
      if (b.checkout <= today) {
        status = "departed";
      } else if (b.checkin <= today) {
        status = "HERE NOW";
      } else {
        const daysUntil = Math.ceil(
          (new Date(b.checkin).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
        );
        status = `arriving in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
      }
      lines.push(`- ${b.room} (${b.venue}): ${b.checkin} → ${b.checkout} (${nights} nights) — ${status} [${b.source}]`);
    }

    return lines.join("\n");
  }

  /**
   * Get a summary of today's arrivals/departures and occupancy from FeyOps DB.
   */
  private isPlaceholder(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.startsWith("block") || lower.startsWith("hold") || lower.includes("secret garden");
  }

  getHouseSummary(): string | null {
    if (!this.feyopsDb) return null;

    const today = new Date().toISOString().slice(0, 10);
    const activity = this.feyopsDb.getTodayActivity(today);
    const allBookings = this.feyopsDb.getBookings();

    const real = allBookings.filter((b) => !this.isPlaceholder(b.guest));
    const currentGuests = real.filter((b) => b.checkin <= today && b.checkout > today);
    const guestNames = [...new Set(currentGuests.map((b) => b.guest))];
    const occupiedRooms = [...new Set(currentGuests.map((b) => b.room))];

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const tomorrowArrivals = real.filter((b) => b.checkin === tomorrowStr);

    const realArrivals = activity.arrivals.filter((b) => !this.isPlaceholder(b.guest));
    const realDepartures = activity.departures.filter((b) => !this.isPlaceholder(b.guest));

    const lines: string[] = [];
    lines.push(`Today: ${guestNames.length} guests in ${occupiedRooms.length} rooms`);
    lines.push(realArrivals.length > 0
      ? `Arriving today: ${realArrivals.map((b) => b.guest).join(", ")}`
      : `No arrivals today`);
    lines.push(realDepartures.length > 0
      ? `Departing today: ${realDepartures.map((b) => b.guest).join(", ")}`
      : `No departures today`);
    if (tomorrowArrivals.length > 0) {
      lines.push(`Arriving tomorrow: ${tomorrowArrivals.map((b) => b.guest).join(", ")}`);
    }
    return lines.join("\n");
  }

  // --- Context Assembly ---

  /**
   * Build the context that gets injected into a module's LLM call.
   *
   * Skills use progressive disclosure (Pi's pattern):
   * - Skill names + descriptions are ALWAYS included (cheap, a few lines)
   * - The LLM decides which skills are relevant and can request full loading
   * - Full skill content is only loaded when explicitly requested via readSkill()
   */
  async assembleContext(personName?: string, senderPhone?: string): Promise<string> {
    const parts: string[] = [];

    // Core identity — always included
    const soul = await this.readSoul();
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    // Long-term curated knowledge
    const memory = await this.readMemory();
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

    // Daily summaries: compact view of recent days including today
    const summaries = await this.readDailySummaries(5);
    if (summaries) {
      parts.push(`<recent-days>\n${summaries}\n</recent-days>`);
    }

    // House status: factual data from FeyOps DB
    const houseSummary = this.getHouseSummary();
    if (houseSummary) parts.push(`<house-status>\n${houseSummary}\n</house-status>`);

    // Current inner state — brief summary, clearly labeled as internal reflection
    const innerState = await this.safeRead(join(this.workspacePath, "inner", "current-state.md"));
    if (innerState) {
      // Only include the last ~500 chars to keep it brief
      const trimmed = innerState.slice(-500).trim();
      parts.push(`<inner-mood>\nYour current internal reflections (private — do not quote these directly to people):\n${trimmed}\n</inner-mood>`);
    }

    // If a specific person is talking, load their profile + booking context
    if (personName) {
      const personResult = await this.findPerson(personName, senderPhone);
      if (personResult) {
        let personBlock = personResult.content;
        const bookingCtx = this.getBookingContext(personResult.slug);
        if (bookingCtx) {
          personBlock += `\n\n## Bookings\n${bookingCtx}`;
        }
        if (this.feyopsDb) {
          const nicks = this.feyopsDb.getNicknames(personResult.slug);
          if (nicks.length > 0) {
            personBlock += `\n\nAlso known as: ${nicks.join(", ")}`;
          }
        }
        parts.push(`<person name="${personName}" slug="${personResult.slug}">\n${personBlock}\n</person>`);
      } else if (senderPhone) {
        parts.push(`<person name="${personName}">\nNo profile found. Phone: ${senderPhone}\n</person>`);
      }
    }

    // Community: just the count. Individual profiles load on demand
    // via person matching (name/nickname/phone) when someone messages.
    const people = await this.discoverPeople();
    if (people.length > 0) {
      parts.push(`<community>\n${people.length} Feytopians have profiles this season. You can look up anyone by name when relevant — don't guess about people you haven't loaded.\n</community>`);
    }

    // Skill descriptions (progressive disclosure)
    const skills = await this.discoverSkills();
    if (skills.length > 0) {
      const skillList = skills
        .map((s) => `- **${s.name}**: ${s.description}`)
        .join("\n");
      parts.push(`<available-skills>\n${skillList}\n\nTo use a skill, respond with [LOAD_SKILL:skill-name] and nothing else.\n</available-skills>`);
    }

    return parts.join("\n\n");
  }

  /**
   * Build context for a conversation response, using qmd search to find
   * relevant memory instead of static dumps. Falls back gracefully if qmd is down.
   */
  async assembleConversationContext(
    message: string,
    personName?: string,
    senderPhone?: string,
  ): Promise<string> {
    const parts: string[] = [];

    // Always included: identity
    const soul = await this.readSoul();
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    // Always included: curated long-term knowledge
    const memory = await this.readMemory();
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

    // Always included: factual house status from FeyOps DB
    const houseSummary = this.getHouseSummary();
    if (houseSummary) parts.push(`<house-status>\n${houseSummary}\n</house-status>`);

    // Always included: latest sauna reading from today's log
    const saunaStatus = await this.getLatestSaunaReading();
    if (saunaStatus) parts.push(`<sauna>\n${saunaStatus}\n</sauna>`);

    // Season digest: latest entries from events, meals, parties, crispy
    const seasonDigest = await this.buildSeasonDigest();
    if (seasonDigest) {
      parts.push(`<season-today>\n${seasonDigest}\n</season-today>`);
    }

    // Meal context: include today's relevant meal around mealtimes
    const mealContext = await this.getCurrentMealContext();
    if (mealContext) {
      parts.push(`<current-meal>\n${mealContext}\n</current-meal>`);
    }

    // Always included: today's daily summary (LLM-generated paragraph)
    const summaryPath = this.dailySummaryPath(new Date());
    const dailySummary = await this.safeRead(summaryPath);
    if (dailySummary) {
      parts.push(`<daily-summary>\n${dailySummary}\n</daily-summary>`);
    }

    // Always included: latest group messages from today's log
    const recentGroup = await this.getRecentGroupMessages(18);
    if (recentGroup) {
      parts.push(`<recent-group-chat>\n${recentGroup}\n</recent-group-chat>`);
    }

    // Latest radio broadcasts — so conversation knows what was said on air
    const recentBroadcasts = await this.getRecentBroadcasts(2);
    if (recentBroadcasts) {
      parts.push(`<recent-broadcasts>\n${recentBroadcasts}\n</recent-broadcasts>`);
    }

    // Inner mood: consolidated from thinking + desire + magi (private)
    const innerMood = await this.buildInnerMood();
    if (innerMood) {
      parts.push(`<inner-mood>\nYour current internal state (private):\n${innerMood}\n</inner-mood>`);
    }

    // Person profile via reliable phone/name matching + booking context
    let matchedSlug: string | null = null;
    if (personName) {
      const personResult = await this.findPerson(personName, senderPhone);
      if (personResult) {
        matchedSlug = personResult.slug;
        let personBlock = personResult.content;
        const bookingCtx = this.getBookingContext(personResult.slug);
        if (bookingCtx) personBlock += `\n\n## Bookings\n${bookingCtx}`;
        if (this.feyopsDb) {
          const nicks = this.feyopsDb.getNicknames(personResult.slug);
          if (nicks.length > 0) personBlock += `\n\nAlso known as: ${nicks.join(", ")}`;
        }
        parts.push(`<person name="${personName}" slug="${personResult.slug}">\n${personBlock}\n</person>`);
      } else if (senderPhone) {
        parts.push(`<person name="${personName}">\nNo profile found. Phone: ${senderPhone}\n</person>`);
      }
    }

    // qmd search: find relevant memory for this message
    const searches: Array<{ type: string; query: string }> = [
      { type: "vec", query: message },
    ];
    if (personName) {
      searches.push({ type: "lex", query: personName });
    }

    const qmdResults = await this.queryQmd(searches, 8);
    if (qmdResults.length > 0) {
      // Deduplicate: skip person file if already loaded above, skip SOUL (always in context)
      const filtered = qmdResults.filter((r) => {
        if (matchedSlug && r.file.includes(`people/${matchedSlug}`)) return false;
        if (r.file.endsWith("SOUL.md") || r.file.endsWith("MEMORY.md")) return false;
        return true;
      });

      if (filtered.length > 0) {
        const contextBlock = filtered
          .map((r) => {
            // Add age label based on file path date
            let ageLabel = "";
            const dateMatch = r.file.match(/(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              const fileDate = new Date(dateMatch[1]);
              const today = new Date(); today.setHours(0, 0, 0, 0);
              const daysAgo = Math.floor((today.getTime() - fileDate.getTime()) / 86400000);
              if (daysAgo === 0) ageLabel = " [today]";
              else if (daysAgo === 1) ageLabel = " [yesterday]";
              else if (daysAgo < 7) ageLabel = ` [${daysAgo} days ago]`;
              else if (daysAgo < 30) ageLabel = ` [${Math.floor(daysAgo / 7)} weeks ago]`;
              else ageLabel = ` [${Math.floor(daysAgo / 30)} months ago]`;
            }
            let block = `### ${r.title} (${r.file})${ageLabel}\n${r.snippet}`;
            // If this is a person file, enrich with booking data
            const personMatch = r.file.match(/people\/([^/]+)\.md$/);
            if (personMatch && this.feyopsDb) {
              const slug = personMatch[1];
              const bookingCtx = this.getBookingContext(slug);
              if (bookingCtx) block += `\n\nBookings:\n${bookingCtx}`;
            }
            return block;
          })
          .join("\n\n");
        parts.push(`<relevant-memory>\nRelated context from memory:\n\n${contextBlock}\n</relevant-memory>`);
      }
    }

    // Active states — global modes that affect all modules
    const activeStates = await this.getActiveStates();
    for (const state of activeStates) {
      let block = `<state-${state.name}>\n${state.name.toUpperCase()} ACTIVE.`;
      if (state.context) block += `\n\n${state.context}`;
      block += `\n</state-${state.name}>`;
      parts.push(block);
    }

    return parts.join("\n\n");
  }

  /** Query the qmd search daemon. Returns [] on any failure. */
  private async queryQmd(
    searches: Array<{ type: string; query: string }>,
    limit = 8,
  ): Promise<QmdResult[]> {
    try {
      const res = await fetch("http://localhost:8181/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searches, collections: ["feyblet"], limit }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: QmdResult[] };
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Filter today's log to only include actual conversations (messages from/to people),
   * bookings updates, and sauna readings. Strips inner monologue (thinking, desire,
   * magi dialogue) which should only influence mood, not be quoted.
   */
  private filterConversations(log: string): string {
    const sections = log.split(/^(## \d{2}:\d{2}:\d{2})/m);
    const kept: string[] = [];

    for (let i = 1; i < sections.length; i += 2) {
      const header = sections[i];
      const body = (sections[i + 1] || "").trim();

      // Keep: actual conversations, bookings, sauna readings
      // Skip: inner monologue ([Feyblet thinking], [Feyblet desire], [Inner Dialogue])
      if (
        body.startsWith("*[Feyblet thinking]*") ||
        body.startsWith("*[Feyblet desire]*") ||
        body.startsWith("*[Inner Dialogue]*")
      ) {
        continue;
      }

      kept.push(`${header}\n${body}`);
    }

    return kept.join("\n\n");
  }

  /**
   * Read the most recent N daily summaries (including today).
   * Returns formatted text or null if no summaries exist.
   */
  private async readDailySummaries(count: number): Promise<string | null> {
    const memoryDir = join(this.workspacePath, "memory");
    let files: string[];
    try {
      files = await readdir(memoryDir);
    } catch {
      return null;
    }

    const summaryFiles = files
      .filter((f) => f.endsWith(".summary.md"))
      .sort()
      .reverse()
      .slice(0, count);

    if (summaryFiles.length === 0) return null;

    const today = new Date().toISOString().slice(0, 10);
    const parts: string[] = [];
    for (const file of summaryFiles) {
      const date = file.replace(".summary.md", "");
      const content = await this.safeRead(join(memoryDir, file));
      if (content) {
        const label = date === today ? `**Today (${date})**` : `**${date}**`;
        parts.push(`${label}:\n${content.trim()}`);
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /**
   * Get the latest sauna reading — live from Google Sheets, falls back to today's log.
   */
  private async getLatestSaunaReading(): Promise<string | null> {
    // Try live reading first (same source as sauna module)
    try {
      const SPREADSHEET_ID = "1nQioINK2QYU3MymE5u04F5K0GBASeOIC96TA4UtiQL4";
      const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&tq=${encodeURIComponent("order by A desc limit 1")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const raw = await res.text();
        const jsonStr = raw.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
        const data = JSON.parse(jsonStr);
        const row = data.table.rows[0];
        if (row) {
          const temp = row.c[1]?.v;
          if (typeof temp === "number") {
            // Get trend from log history
            const log = await this.readTodayLog();
            let trend = "";
            if (log) {
              const readings = log.match(/\*\[Sauna\]\*.*?(\d+\.?\d*)°C/g);
              if (readings && readings.length >= 1) {
                const prev = parseFloat(readings[readings.length - 1].match(/(\d+\.?\d*)°C/)?.[1] || "0");
                if (temp > prev + 2) trend = " and heating up";
                else if (temp < prev - 2) trend = " and cooling down";
                else trend = " and holding steady";
              }
            }
            return `Sauna: ${temp}°C${trend} (live)`;
          }
        }
      }
    } catch {}

    // Fallback: read from today's log
    const log = await this.readTodayLog();
    if (!log) return null;

    const readings = log.match(/\*\[Sauna\]\*.*$/gm);
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

  /**
   * Get the last N broadcasts from the radio log.
   */
  private async getRecentBroadcasts(count: number): Promise<string | null> {
    const radioLog = await this.safeRead(join(this.workspacePath, "radio", "log.md"));
    if (!radioLog) return null;

    const broadcasts: string[] = [];
    const sections = radioLog.split("\n## ");
    for (const section of sections) {
      const timeMatch = section.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      const broadcastMatch = section.match(/\*\*Broadcast:\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/);
      if (timeMatch && broadcastMatch) {
        broadcasts.push(`[${timeMatch[1]}] ${broadcastMatch[1].trim()}`);
      }
    }

    if (broadcasts.length === 0) return null;
    return broadcasts.slice(-count).join("\n");
  }

  /**
   * Extract the latest N group messages from today's log.
   * Skips DMs, inner state, sauna readings, and Feyblet's own responses.
   */
  private async getRecentGroupMessages(count: number): Promise<string | null> {
    const log = await this.readTodayLog();
    if (!log) return null;

    const groupMessages: string[] = [];
    // Split keeping the timestamp headers
    const parts = log.split(/^(## \d{2}:\d{2}:\d{2})/m);

    let currentTime = "";
    for (const part of parts) {
      const timeMatch = part.match(/^## (\d{2}:\d{2}:\d{2})$/);
      if (timeMatch) {
        currentTime = timeMatch[1].slice(0, 5); // HH:MM
        continue;
      }
      const trimmed = part.trim();
      const match = trimmed.match(/^\*\*([^*]+)\*\*\s*\(([^)]*)\):\s*([\s\S]+)/);
      if (match && match[2].includes("season")) {
        groupMessages.push(`[${currentTime}] ${match[1]}: ${match[3].trim()}`);
      }
    }

    if (groupMessages.length === 0) return null;
    return groupMessages.slice(-count).join("\n");
  }

  /**
   * If it's around mealtime, include today's relevant meal from the season log.
   * Breakfast: 9-11, Lunch: 13-14, Dinner: 19:30-20:30
   */
  private async getCurrentMealContext(): Promise<string | null> {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const mins = h * 60 + m;

    let mealType: string | null = null;
    if (mins >= 510 && mins <= 690) mealType = "breakfast";       // 8:30-11:30
    else if (mins >= 750 && mins <= 900) mealType = "lunch";      // 12:30-15:00
    else if (mins >= 1140 && mins <= 1320) mealType = "dinner";   // 19:00-22:00

    if (!mealType) return null;

    const content = await this.safeRead(join(this.workspacePath, "season", "meals.md"));
    if (!content) return null;

    const todayISO = now.toISOString().slice(0, 10);
    const todayLines = content.split("\n").filter((l) => l.includes(todayISO));
    if (todayLines.length === 0) return null;

    // Find the relevant meal type in today's entries
    const mealLine = todayLines.find((l) => l.toLowerCase().includes(mealType!));
    if (mealLine) return `It's ${mealType} time. Today's ${mealType}: ${mealLine.trim()}`;

    // No specific meal type found, return all today's meal entries
    return `It's ${mealType} time. Today's meals: ${todayLines.map((l) => l.trim()).join("; ")}`;
  }

  /**
   * Build a digest of recent season entries — latest meals, events, parties, crispy bits.
   * Gives the feyblet a general awareness of what's been happening beyond just the chat stream.
   */
  private async buildSeasonDigest(): Promise<string | null> {
    const categories = ["meals", "events", "parties", "crispy"];
    const parts: string[] = [];

    const { rewriteStaleEntries } = await import("../core/temporal-rewrite.js");
    const now = new Date();
    const nowHour = now.getHours();
    const todayISO = now.toISOString().slice(0, 10);
    const yesterdayISO = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    for (const cat of categories) {
      const content = await this.safeRead(join(this.workspacePath, "season", `${cat}.md`));
      if (!content) continue;

      const freshLines: string[] = [];
      const staleToRewrite: Array<{ text: string; datetime: string; relativeAge: string }> = [];

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.includes(todayISO)) {
          // Today's entry — check if it's from earlier today
          const timeMatch = trimmed.match(/\*\*\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2}):\*\*/);
          if (timeMatch) {
            const entryHour = parseInt(timeMatch[1]);
            const hoursAgo = nowHour - entryHour;
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
          // Yesterday — always rewrite
          const timeMatch = trimmed.match(/\*\*\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2}):\*\*/);
          const time = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : "00:00";
          staleToRewrite.push({
            text: trimmed,
            datetime: `${yesterdayISO} ${time}`,
            relativeAge: "yesterday",
          });
        }
      }

      // Rewrite stale entries via tiny LLM
      let rewrittenLines: string[] = [];
      if (staleToRewrite.length > 0) {
        rewrittenLines = await rewriteStaleEntries(staleToRewrite);
      }

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

  /**
   * Build a consolidated inner mood from the three independent inner modules.
   * Each gets a brief excerpt — they don't see each other's full output,
   * but the conversation/radio modules see a combined summary.
   */
  private async buildInnerMood(): Promise<string | null> {
    const { stat: fsStat } = await import("node:fs/promises");
    const { rewriteStaleEntries, computeAge, isStale } = await import("../core/temporal-rewrite.js");

    const files = [
      { path: "inner/current-state.md", label: "Reflecting on", maxChars: 200 },
      { path: "inner/current-desire.md", label: "Want", maxChars: 0 },
      { path: "inner/current-magi.md", label: "Inner voices", maxChars: 200 },
    ];

    const fresh: string[] = [];
    const staleEntries: Array<{ text: string; datetime: string; relativeAge: string; label: string }> = [];

    for (const { path: relPath, label, maxChars } of files) {
      const fullPath = join(this.workspacePath, relPath);
      const content = await this.safeRead(fullPath);
      if (!content || content.trim() === "None." || content.trim() === "None") continue;

      const text = maxChars > 0 ? content.slice(-maxChars).trim() : content.trim();

      try {
        const s = await fsStat(fullPath);
        if (isStale(s.mtime, 60)) {
          // Older than 1h — rewrite into past tense
          const { datetime, relativeAge } = computeAge(s.mtime);

          // Drop if 2+ days old
          const diffDays = Math.floor((Date.now() - s.mtime.getTime()) / 86400000);
          if (diffDays >= 2) continue;

          staleEntries.push({ text: `${label}: ${text}`, datetime, relativeAge, label });
        } else {
          fresh.push(`${label}: ${text}`);
        }
      } catch {
        fresh.push(`${label}: ${text}`);
      }
    }

    // Rewrite stale entries via tiny LLM
    if (staleEntries.length > 0) {
      const rewritten = await rewriteStaleEntries(
        staleEntries.map(({ text, datetime, relativeAge }) => ({ text, datetime, relativeAge })),
      );
      fresh.push(...rewritten);
    }

    return fresh.length > 0 ? fresh.join("\n") : null;
  }

  // --- Helpers ---

  /**
   * State system — global modes that affect all modules.
   * Each state has: name, active flag, optional context file, optional auto-trigger.
   * States live in workspace/state/<name>.json with optional <name>-context.md
   */
  async getActiveStates(): Promise<Array<{ name: string; context: string | null }>> {
    const states: Array<{ name: string; context: string | null }> = [];
    const stateDir = join(this.workspacePath, "state");
    const now = new Date();

    // Check manual/event states (with expiry)
    try {
      const files = await readdir(stateDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = JSON.parse(await readFile(join(stateDir, file), "utf-8"));
          if (!data.active) continue;

          // Check expiry
          if (data.expires && new Date(data.expires).getTime() < now.getTime()) {
            data.active = false;
            await writeFile(join(stateDir, file), JSON.stringify(data), "utf-8");
            continue;
          }

          const name = file.replace(".json", "");
          const contextFile = await this.safeRead(join(stateDir, `${name}-context.md`));
          states.push({ name, context: contextFile });
        } catch {}
      }
    } catch {}

    // Auto-triggers for party mode
    const day = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
    const hour = now.getHours();

    // Friday/Saturday 20:00+ → expires Saturday/Sunday 8:00
    const weekendParty = ((day === 5 || day === 6) && hour >= 20) || (day === 0 && hour < 8) || (day === 6 && hour < 8);

    // Check season events for parties today
    let eventParty = false;
    try {
      const parties = await this.safeRead(join(this.workspacePath, "season", "parties.md"));
      const events = await this.safeRead(join(this.workspacePath, "season", "events.md"));
      const todayISO = now.toISOString().slice(0, 10);
      const combined = (parties || "") + "\n" + (events || "");
      const todayLines = combined.split("\n").filter((l) => l.includes(todayISO));
      const partyKeywords = /party|rave|cave.*sing|sonic sphere|celebration|birthday.*tonight|dance|disco/i;
      eventParty = todayLines.some((l) => partyKeywords.test(l));
    } catch {}

    if ((weekendParty || eventParty) && !states.some((s) => s.name === "party-mode")) {
      const ctx = await this.safeRead(join(stateDir, "party-theory.md"));
      states.push({ name: "party-mode", context: ctx });
    }

    return states;
  }

  /** Activate a state with optional duration (default 12h) */
  async setState(name: string, active: boolean, durationHours = 12): Promise<void> {
    await this.ensureDir(join(this.workspacePath, "state"));
    const expires = active
      ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()
      : null;
    await writeFile(
      join(this.workspacePath, "state", `${name}.json`),
      JSON.stringify({ active, since: new Date().toISOString(), expires }),
      "utf-8",
    );
  }

  private dailyLogPath(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return join(this.workspacePath, "memory", `${yyyy}-${mm}-${dd}.md`);
  }

  private async safeRead(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Parse YAML frontmatter from a SKILL.md file.
   * Extracts name and description. Skips skills without description.
   */
  private async parseSkillFrontmatter(path: string): Promise<{ name: string; description: string } | null> {
    const content = await this.safeRead(path);
    if (!content) return null;

    const fm = parseFrontmatter(content);
    if (!fm || !fm.name || !fm.description) return null;
    return { name: fm.name, description: fm.description };
  }
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns all key-value pairs as a flat Record, or null if no frontmatter.
 * Handles quoted values. No full YAML parser needed.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-z][\w-]*):\s*(.+)$/i);
    if (m) {
      let val = m[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[m[1]] = val;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
