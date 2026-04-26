/**
 * Memory Manager — OpenClaw-style Markdown memory.
 *
 * Files in the deployment's workspace:
 * - SOUL.md          — symbient identity
 * - MEMORY.md        — curated long-term knowledge
 * - memory/YYYY-MM-DD.md — daily logs (append-only journals)
 * - people/<slug>.md — per-person relational memory (deployment convention)
 * - state/*.json     — transient global modes with optional expiry
 *
 * Framework memory is intentionally domain-agnostic. Deployments inject
 * any extra context via:
 *   - MemoryEnricher (per-person blocks, e.g. booking history),
 *   - context providers declared in module frontmatter (anything else),
 *   - onAppend listeners for post-write side effects like LLM-generated
 *     daily summaries.
 */

import { readFile, writeFile, appendFile, mkdir, access, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { MemoryReader, MemoryWriter } from "../core/types.js";
import { slugify } from "../core/slugify.js";
import { symbientName } from "../core/symbient-name.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { getSearchBackend, type SearchHit } from "../core/search.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("memory");

/**
 * Optional deployment-provided hook into context assembly. Handles the
 * two things that are hard to express as context providers:
 *
 *   - `personBlocks(slug)`: extra blocks appended to a <person> block
 *     when a specific person is matched (booking history, aliases).
 *     Context providers don't see "the current person" — only enrichers
 *     know it.
 *
 *   - `resolveNickname(input)`: resolve any string to a person slug —
 *     fuzzy nicknames, chat-platform identifiers (Signal UUID, Matrix
 *     MXID, Discord ID), or any deployment-specific alias scheme. Called
 *     during findPerson() when name+phone alone don't match.
 *
 * Global context blocks (sensor state, recent broadcasts, current
 * occupants, etc.) are NOT part of the enricher — they live as context
 * providers in `workspace/extensions/providers.js` and modules reference
 * them by name in frontmatter `context:` blocks.
 */
export interface MemoryEnricher {
  /** Extra blocks for a specific person (booking/stay history, aliases). */
  personBlocks?: (slug: string) => Promise<string[]> | string[];
  /** Resolve a nickname, alias, or chat-platform identifier to a person slug. */
  resolveNickname?: (input: string) => Promise<string | null> | string | null;
}

/**
 * Listener fired after each successful `appendLog`. Receives the entry
 * and the date it was written under. Deployments use this for things
 * like daily summaries, indexing, or notification — none of which are
 * framework concerns.
 */
export type AppendLogListener = (entry: string, date: Date) => void | Promise<void>;

export interface PersonMeta {
  name: string;
  filename: string;
  /** Raw frontmatter fields. Strings most of the time, but can be arrays
   *  (e.g. `aliases:`), booleans, or numbers — js-yaml preserves the type. */
  fields: Record<string, unknown>;
  path: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Render a "[X days ago]" suffix from a YYYY-MM-DD date in the file path. */
function ageLabelForFile(file: string): string {
  const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return "";
  const fileDate = new Date(dateMatch[1]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysAgo = Math.floor((today.getTime() - fileDate.getTime()) / 86400000);
  if (daysAgo === 0) return " [today]";
  if (daysAgo === 1) return " [yesterday]";
  if (daysAgo < 7) return ` [${daysAgo} days ago]`;
  if (daysAgo < 30) return ` [${Math.floor(daysAgo / 7)} weeks ago]`;
  return ` [${Math.floor(daysAgo / 30)} months ago]`;
}

export class MemoryManager implements MemoryReader, MemoryWriter {
  private peopleCache: PersonMeta[] | null = null;
  private peopleCacheTime = 0;
  private enricher: MemoryEnricher | null = null;
  private appendListeners: AppendLogListener[] = [];

  constructor(public readonly workspacePath: string) {}

  /** @deprecated read `.workspacePath` directly. */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Attach a deployment-specific context enricher. MemoryManager stays
   * domain-agnostic; all booking/inventory/people-metadata comes through
   * this hook. A CLI-only deployment just never calls this.
   */
  setEnricher(enricher: MemoryEnricher): void {
    this.enricher = enricher;
  }

  /**
   * Register a listener that fires after each successful `appendLog`.
   * Listeners run sequentially; any error is logged and swallowed so a
   * misbehaving listener never breaks the writer's flow.
   */
  onAppend(listener: AppendLogListener): void {
    this.appendListeners.push(listener);
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
   * Find a person by name. Resolution order:
   *   1. phone-number match (suffix-aware, handles country-code variants)
   *   2. exact frontmatter name
   *   3. deployment-provided nickname / chat-id resolver (`resolveNickname`)
   *   4. first-name / substring fallback
   *   5. filename slug fallback
   *
   * Chat-platform identifiers (Signal UUID, Matrix MXID, Discord ID, etc.)
   * resolve through the deployment's `resolveNickname` hook rather than
   * being baked into core — the framework knows nothing about specific
   * transports. Returns the person's slug and full profile content.
   */
  async findPerson(name: string, phone?: string): Promise<{ slug: string; content: string } | null> {
    const people = await this.discoverPeople();
    const lower = name.toLowerCase();

    let match: PersonMeta | undefined;

    // Phone-number match — suffix-aware so "+33 6 12 34 56 78" and
    // "0612345678" can resolve to the same person.
    if (phone) {
      const cleanPhone = phone.replace(/\s+/g, "");
      match = people.find((p) => {
        const raw = p.fields.phone;
        if (typeof raw !== "string") return false;
        const pPhone = raw.replace(/\s+/g, "");
        return pPhone && (pPhone === cleanPhone || pPhone.endsWith(cleanPhone.slice(-9)) || cleanPhone.endsWith(pPhone.slice(-9)));
      });
    }

    // Exact match on frontmatter name
    if (!match) {
      match = people.find((p) => p.name.toLowerCase() === lower);
    }

    // Deployment-provided nickname/alias/chat-id resolution.
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

  // --- MemoryWriter ---

  async appendLog(entry: string): Promise<void> {
    const now = new Date();
    const logPath = this.dailyLogPath(now);
    const timestamp = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const line = `\n## ${timestamp}\n\n${entry}\n`;
    await this.ensureDir(dirname(logPath));
    await appendFile(logPath, line, "utf-8");

    // Fire registered listeners — fire-and-forget, errors logged but not thrown.
    for (const listener of this.appendListeners) {
      Promise.resolve()
        .then(() => listener(entry, now))
        .catch((err) => log.warn(`onAppend listener failed: ${(err as Error)?.message || err}`));
    }
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

        const { fields } = parseFrontmatter(content);
        const personName = typeof fields.name === "string" ? fields.name : null;
        if (!personName) continue;

        people.push({
          name: personName,
          filename: file.replace(".md", ""),
          fields,
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
   * Minimal generic context: SOUL + MEMORY + optional person profile.
   * Anything deployment-specific (sensor state, recent broadcasts, mood
   * snapshots, etc.) comes via context providers declared in the module's
   * `.md` frontmatter — not here.
   */
  async assembleContext(personName?: string, phone?: string): Promise<string> {
    const parts: string[] = [];

    const soul = await this.readSoul();
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    const memory = await this.readMemory();
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

    // Person profile — universal concept; deployment enricher can add
    // extra per-person blocks via MemoryEnricher.personBlocks.
    if (personName) {
      const personResult = await this.findPerson(personName, phone);
      if (personResult) {
        let personBlock = personResult.content;
        const extras = await this.callPersonEnrichers(personResult.slug);
        for (const e of extras) personBlock += `\n\n${e}`;
        parts.push(`<person name="${personName}" slug="${personResult.slug}">\n${personBlock}\n</person>`);
      } else if (phone) {
        parts.push(`<person name="${personName}">\nNo profile found. Phone: ${phone}\n</person>`);
      }
    }

    return parts.join("\n\n");
  }

  /**
   * Context assembly for conversation — same skeleton as assembleContext
   * (SOUL + MEMORY + person + enricher) plus a qmd <relevant-memory> block
   * for the incoming message. Anything else (chat digests, sensor state,
   * mood snapshots) belongs in the module's `context:` frontmatter as a
   * declarative provider, not here. Falls back to static context if qmd
   * is unreachable.
   */
  async assembleConversationContext(
    message: string,
    personName?: string,
    phone?: string,
  ): Promise<string> {
    const parts: string[] = [];

    const soul = await this.readSoul();
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    const memory = await this.readMemory();
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

    // Person profile + deployment-provided per-person blocks.
    let matchedSlug: string | null = null;
    if (personName) {
      const personResult = await this.findPerson(personName, phone);
      if (personResult) {
        matchedSlug = personResult.slug;
        let personBlock = personResult.content;
        for (const extra of await this.callPersonEnrichers(personResult.slug)) {
          personBlock += `\n\n${extra}`;
        }
        parts.push(`<person name="${personName}" slug="${personResult.slug}">\n${personBlock}\n</person>`);
      } else if (phone) {
        parts.push(`<person name="${personName}">\nNo profile found. Phone: ${phone}\n</person>`);
      }
    }

    // Search the memory backend for relevant chunks for this message.
    const searches: Array<{ type: "lex" | "vec"; query: string }> = [
      { type: "vec", query: message },
    ];
    if (personName) {
      searches.push({ type: "lex", query: personName });
    }

    const searchResults = await this.runSearch(searches, 8);
    if (searchResults.length > 0) {
      const filtered = searchResults.filter((r) => {
        if (matchedSlug && r.file.includes(`people/${matchedSlug}`)) return false;
        if (r.file.endsWith("SOUL.md") || r.file.endsWith("MEMORY.md")) return false;
        return true;
      });

      if (filtered.length > 0) {
        const blocks = await Promise.all(filtered.map((r) => this.formatMemoryHit(r)));
        const contextBlock = blocks.join("\n\n");
        parts.push(`<relevant-memory>\nRelated context from memory:\n\n${contextBlock}\n</relevant-memory>`);
      }
    }

    return parts.join("\n\n");
  }

  /** Render one search hit as a markdown block, with an age label and any
   *  per-person enrichments. Pulled out of assembleConversationContext to
   *  keep that method's nesting flat. */
  private async formatMemoryHit(r: SearchHit): Promise<string> {
    let block = `### ${r.title} (${r.file})${ageLabelForFile(r.file)}\n${r.snippet}`;
    const personMatch = r.file.match(/people\/([^/]+)\.md$/);
    if (personMatch) {
      for (const extra of await this.callPersonEnrichers(personMatch[1])) {
        block += `\n\n${extra}`;
      }
    }
    return block;
  }

  /**
   * Query the configured search backend. Returns [] on any failure (so
   * conversation context degrades gracefully when search is unavailable).
   */
  private async runSearch(
    searches: Array<{ type: "lex" | "vec"; query: string }>,
    limit = 8,
  ): Promise<SearchHit[]> {
    return getSearchBackend()
      .query({ searches, collection: symbientName(), limit })
      .catch(() => [] as SearchHit[]);
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
  /**
   * Return currently-active states.
   *
   * Side effect: states whose `expires` timestamp has passed are marked
   * `active: false` on disk during this call. The mutation is incidental
   * (lazy expiry) — separate it out by calling `expireStaleStates()` first
   * if you need a pure read.
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
            // Lazy expiry — write the disabled flag and skip in this scan.
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

  private safeRead(path: string): Promise<string | null> {
    return readFile(path, "utf-8").catch(() => null);
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
  }

}
