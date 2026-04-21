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
import { slugify } from "../core/slugify.js";
import { annotateContextLines } from "./time-annotate.js";

/**
 * Optional deployment-provided hook into context assembly. The memory
 * manager knows nothing about bookings, guests, rooms, or any other
 * domain-specific concept — if a deployment wants such data to appear
 * in the assembled context, it provides an enricher.
 *
 * Every field is optional. MemoryManager calls what's defined.
 */
export interface MemoryEnricher {
  /** Extra context blocks to include after MEMORY/summaries. Return empty array for none. */
  globalBlocks?: () => Promise<string[]> | string[];
  /** Extra blocks for a specific person (e.g. booking/stay history). Called with the resolved person slug. */
  personBlocks?: (slug: string) => Promise<string[]> | string[];
  /** Resolve a nickname/alias to a person slug — used by findPerson when name-based matching fails. */
  resolveNickname?: (name: string) => Promise<string | null> | string | null;
}

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
  private enricher: MemoryEnricher | null = null;

  constructor(private workspacePath: string) {}

  /**
   * Attach a deployment-specific context enricher. MemoryManager stays
   * domain-agnostic; all booking/inventory/people-metadata comes through
   * this hook. A CLI-only deployment just never calls this.
   */
  setEnricher(enricher: MemoryEnricher): void {
    this.enricher = enricher;
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
  async findPerson(name: string, phone?: string, signalUuid?: string): Promise<{ slug: string; content: string } | null> {
    const people = await this.discoverPeople();
    const lower = name.toLowerCase();

    let match: PersonMeta | undefined;

    // Try Signal UUID match FIRST — most reliable identifier
    if (!match && signalUuid) {
      match = people.find((p) => p.fields["signal-uuid"]?.replace(/"/g, "") === signalUuid);
    }

    // Try phone number match — very reliable
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

    // Try deployment-provided nickname/alias resolution.
    if (!match && this.enricher?.resolveNickname) {
      const slug = await this.enricher.resolveNickname(name);
      if (slug) {
        match = people.find((p) => p.filename === slug);
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

  // --- Deployment-provided context helpers ---

  private async callGlobalEnrichers(): Promise<string[]> {
    if (!this.enricher?.globalBlocks) return [];
    try {
      return [...(await this.enricher.globalBlocks())];
    } catch {
      return [];
    }
  }

  private async callPersonEnrichers(slug: string): Promise<string[]> {
    if (!this.enricher?.personBlocks) return [];
    try {
      return [...(await this.enricher.personBlocks(slug))];
    } catch {
      return [];
    }
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

    // Deployment-provided global context blocks (e.g. Feÿ's house-status).
    for (const block of await this.callGlobalEnrichers()) parts.push(block);

    // Current inner state — brief summary, clearly labeled as internal reflection
    const innerState = await this.safeRead(join(this.workspacePath, "inner", "current-state.md"));
    if (innerState) {
      // Only include the last ~500 chars to keep it brief
      const trimmed = innerState.slice(-500).trim();
      parts.push(`<inner-mood>\nYour current internal reflections (private — do not quote these directly to people):\n${trimmed}\n</inner-mood>`);
    }

    // If a specific person is talking, load their profile + deployment-provided per-person blocks.
    if (personName) {
      const personResult = await this.findPerson(personName, senderPhone);
      if (personResult) {
        let personBlock = personResult.content;
        const extras = await this.callPersonEnrichers(personResult.slug);
        for (const e of extras) personBlock += `\n\n${e}`;
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

    // Deployment-provided global blocks (house-status, sauna, season digest,
    // broadcasts, etc. — all injected by the deployment's enricher).
    for (const block of await this.callGlobalEnrichers()) parts.push(block);

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

    // Inner mood: consolidated from thinking + desire + magi (private)
    const innerMood = await this.buildInnerMood();
    if (innerMood) {
      parts.push(`<inner-mood>\nYour current internal state (private):\n${innerMood}\n</inner-mood>`);
    }

    // Person profile + deployment-provided per-person blocks.
    let matchedSlug: string | null = null;
    if (personName) {
      const personResult = await this.findPerson(personName, senderPhone);
      if (personResult) {
        matchedSlug = personResult.slug;
        let personBlock = personResult.content;
        for (const extra of await this.callPersonEnrichers(personResult.slug)) {
          personBlock += `\n\n${extra}`;
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
        const blocks = await Promise.all(filtered.map(async (r) => {
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
          const personMatch = r.file.match(/people\/([^/]+)\.md$/);
          if (personMatch) {
            for (const extra of await this.callPersonEnrichers(personMatch[1])) {
              block += `\n\n${extra}`;
            }
          }
          return block;
        }));
        const contextBlock = blocks.join("\n\n");
        parts.push(`<relevant-memory>\nRelated context from memory:\n\n${contextBlock}\n</relevant-memory>`);
      }
    }

    // Recent DMs — brief summary so the model knows what conversations are happening
    const recentDMs = await this.getRecentDMSummary(10);
    if (recentDMs) {
      parts.push(`<recent-dms>\nRecent DMs with other people — not part of this conversation, just for your awareness. Don't mix these into your current reply unless directly relevant. Use search if you need the full context of any thread.\n${recentDMs}\n</recent-dms>`);
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

  /** Get a brief summary of recent DM activity from today's log. */
  private async getRecentDMSummary(maxEntries: number): Promise<string | null> {
    const todayLog = await this.readTodayLog();
    if (!todayLog) return null;

    // Extract DM entries: "**Name** (dm): first few words..." and "**Feyblet** (dm to Name): ..."
    const dmPattern = /^\*\*([^*]+)\*\*\s*\(dm(?:\s+to\s+([^)]+))?\):\s*(.+)/gm;
    const entries: Array<{ time: string; from: string; to: string; snippet: string }> = [];
    const sections = todayLog.split(/^## (\d{2}:\d{2}:\d{2})/m);

    let currentTime = "";
    for (const section of sections) {
      const timeMatch = section.match(/^(\d{2}:\d{2}:\d{2})$/);
      if (timeMatch) { currentTime = timeMatch[1]; continue; }

      let m;
      dmPattern.lastIndex = 0;
      while ((m = dmPattern.exec(section)) !== null) {
        const name = m[1];
        const toName = m[2] || "";
        const snippet = m[3].replace(/\n/g, " ");
        if (name === "Feyblet") {
          entries.push({ time: currentTime, from: "feyblet", to: toName, snippet });
        } else {
          entries.push({ time: currentTime, from: name, to: "feyblet", snippet });
        }
      }
    }

    if (entries.length === 0) return null;

    // Only show incoming DMs, not feyblet's own responses (avoids anchoring on past failures)
    const dmLines = entries
      .filter(e => e.from !== "feyblet")
      .slice(-maxEntries)
      .map(e => {
        const person = e.from === "feyblet" ? e.to : e.from;
        const direction = e.from === "feyblet" ? "→" : "←";
        return `[${e.time.slice(0, 5)}] ${person} ${direction} ${e.snippet}`;
      });
    const annotated = await annotateContextLines(dmLines);
    return annotated.join("\n");
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
        body: JSON.stringify({
          searches: searches.map(s => ({ ...s, query: s.query.replace(/\n/g, " ").trim() })),
          collections: ["feyblet"],
          limit,
        }),
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
   * Extract the latest N group messages from today's log.
   * Generic — any chat system produces timestamped group entries in the log.
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
    const recent = groupMessages.slice(-count);
    const annotated = await annotateContextLines(recent);
    return annotated.join("\n");
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
      const partyKeywords = /party|rave|cave.*sing|sonic sphere|celebration|birthday.*tonight|\bdance\b|\bdisco\b/i;
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
