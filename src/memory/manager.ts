/**
 * Memory Manager — OpenClaw-style Markdown memory.
 *
 * Files in the deployment's workspace:
 * - SOUL.md          — symbient identity
 * - MEMORY.md        — curated long-term knowledge
 * - memory/YYYY-MM-DD.md — daily logs (append-only journals)
 * - memory/YYYY-MM-DD.summary.md — LLM-generated daily summaries
 * - people/<slug>.md — per-person relational memory (deployment convention)
 * - state/*.json     — transient global modes with optional expiry
 *
 * Framework memory knows nothing about bookings/seasons/moods/etc. —
 * deployments inject domain context via the MemoryEnricher hook
 * (per-person blocks) and context providers declared in module
 * frontmatter (everything else).
 */

import { readFile, writeFile, appendFile, mkdir, access, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { MemoryReader, MemoryWriter, SearchResult } from "../core/types.js";
import { slugify } from "../core/slugify.js";
import { annotateContextLines } from "./time-annotate.js";
import { symbientName, symbientDisplayName } from "../core/symbient-name.js";

/**
 * Optional deployment-provided hook into context assembly. Handles the
 * two things that are hard to express as context providers:
 *
 *   - `personBlocks(slug)`: extra blocks appended to a <person> block
 *     when a specific person is matched (booking history, aliases).
 *     Context providers don't see "the current person" — only enrichers
 *     know it.
 *
 *   - `resolveNickname(name)`: fuzzy nickname → slug resolution during
 *     findPerson(). Deployment-specific alias table.
 *
 * Global context blocks (house-status, sauna, recent-broadcasts, etc.)
 * are NOT part of the enricher — they live as context providers in
 * `workspace/extensions/providers.js` and modules reference them by
 * name in frontmatter `context:` blocks.
 */
export interface MemoryEnricher {
  /** Extra blocks for a specific person (booking/stay history, aliases). */
  personBlocks?: (slug: string) => Promise<string[]> | string[];
  /** Resolve a nickname/alias to a person slug. */
  resolveNickname?: (name: string) => Promise<string | null> | string | null;
}

type LLMSummarizer = {
  complete(opts: { system: string; messages: Array<{ role: "user"; content: string }>; temperature?: number; maxTokens?: number }): Promise<string>;
};

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
  private peopleCache: PersonMeta[] | null = null;
  private peopleCacheTime = 0;
  private enricher: MemoryEnricher | null = null;
  private qmdUrl: string = "";

  constructor(private workspacePath: string) {}

  setQmdUrl(url: string): void {
    this.qmdUrl = url;
  }

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
        maxTokens: 1000,
      });

      if (summary.trim()) {
        const summaryPath = this.dailySummaryPath(date);
        await this.ensureDir(dirname(summaryPath));
        await writeFile(summaryPath, summary.trim(), "utf-8");
      }
    } catch (err) {
      // Non-fatal — surface so silent failures (model unavailable, empty
      // response when thinking eats the token budget, etc.) are visible.
      console.warn("[memory] resummarizeDay failed:", (err as Error)?.message || err);
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

  // --- People ---

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
  /**
   * Minimal generic context: SOUL + MEMORY + optional person profile.
   * Anything deployment-specific (house-status, recent days, inner mood,
   * recent DMs, group-chat digest, etc.) comes via context providers
   * declared in the module's `.md` frontmatter — not here.
   */
  async assembleContext(personName?: string, senderPhone?: string): Promise<string> {
    const parts: string[] = [];

    const soul = await this.readSoul();
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    const memory = await this.readMemory();
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

    // Person profile — universal concept; deployment enricher can add
    // extra per-person blocks (bookings, aliases, etc.).
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

    return parts.join("\n\n");
  }

  /**
   * Build context for a conversation response, using qmd search to find
   * relevant memory instead of static dumps. Falls back gracefully if qmd is down.
   */
  /**
   * Context assembly for conversation — same skeleton as assembleContext
   * (SOUL + MEMORY + person + enricher) plus qmd relevant-memory for the
   * incoming message. No group-chat digest, no recent-DMs, no active-
   * states, no house-status — all of those are deployment context
   * providers declared in the relevant module's `.md` frontmatter.
   */
  async assembleConversationContext(
    message: string,
    personName?: string,
    senderPhone?: string,
  ): Promise<string> {
    const parts: string[] = [];

    const soul = await this.readSoul();
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    const memory = await this.readMemory();
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

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
      const filtered = qmdResults.filter((r) => {
        if (matchedSlug && r.file.includes(`people/${matchedSlug}`)) return false;
        if (r.file.endsWith("SOUL.md") || r.file.endsWith("MEMORY.md")) return false;
        return true;
      });

      if (filtered.length > 0) {
        const blocks = await Promise.all(filtered.map(async (r) => {
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

    return parts.join("\n\n");
  }

  /** Get a brief summary of recent DM activity from today's log. */
  private async getRecentDMSummary(maxEntries: number): Promise<string | null> {
    const todayLog = await this.readTodayLog();
    if (!todayLog) return null;

    // Extract DM entries: `**Name** (dm): text` and `**<Symbient>** (dm to Name): text`
    const self = symbientName();
    const selfDisplay = symbientDisplayName();
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
        if (name === selfDisplay) {
          entries.push({ time: currentTime, from: self, to: toName, snippet });
        } else {
          entries.push({ time: currentTime, from: name, to: self, snippet });
        }
      }
    }

    if (entries.length === 0) return null;

    // Only show incoming DMs, not self-authored responses (avoids anchoring).
    const dmLines = entries
      .filter(e => e.from !== self)
      .slice(-maxEntries)
      .map(e => {
        const person = e.from === self ? e.to : e.from;
        const direction = e.from === self ? "→" : "←";
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
      if (!this.qmdUrl) return [];
      const res = await fetch(`${this.qmdUrl}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searches: searches.map(s => ({ ...s, query: s.query.replace(/\n/g, " ").trim() })),
          collections: [symbientName()],
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

      // Keep: actual conversations and external data.
      // Skip: inner monologue (`*[<Symbient> thinking]*`, `*[<Symbient> desire]*`,
      // `*[Inner Dialogue]*`). Pattern-matched dynamically so any symbient name works.
      const selfDisplay = symbientDisplayName();
      if (
        body.startsWith(`*[${selfDisplay} thinking]*`) ||
        body.startsWith(`*[${selfDisplay} desire]*`) ||
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
   * Generic state system — each state is a JSON file at
   * `workspace/state/<name>.json` with `{ active, since, expires? }`.
   * Returns currently-active states (honoring expiry). Optional
   * `<name>-context.md` provides extra description for the state.
   *
   * No auto-triggers, no domain-specific keywords — deployments with
   * auto-triggered modes (e.g. "party-mode on Friday night") implement
   * that logic in a workspace extension or context provider, and call
   * `setState()` to activate the state.
   */
  async getActiveStates(): Promise<Array<{ name: string; context: string | null }>> {
    const states: Array<{ name: string; context: string | null }> = [];
    const stateDir = join(this.workspacePath, "state");
    const now = Date.now();
    try {
      const files = await readdir(stateDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = JSON.parse(await readFile(join(stateDir, file), "utf-8"));
          if (!data.active) continue;
          if (data.expires && new Date(data.expires).getTime() < now) {
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
    return states;
  }

  /** Activate a state with optional duration (default 12h). */
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
