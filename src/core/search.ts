/**
 * Pluggable memory search backend.
 *
 * Two built-in backends:
 *   - `qmd-http` — POST to a qmd-shaped HTTP endpoint (vec + lex + rerank).
 *     Best when you have qmd installed and an embedder running.
 *   - `local-bm25` — in-process BM25 over `workspace/**\/*.md`. Zero
 *     external dependencies, lex-only. Best for small deployments
 *     starting out.
 *
 * Selected via `config.services.search.backend`. Default: `qmd-http` when
 * a URL is set, `local-bm25` otherwise. Deployments can register custom
 * backends via the same registry pattern as adapters.
 *
 * The shape is loosely qmd-compatible so the existing search tool and
 * `assembleConversationContext` can call into it without translating
 * results.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface SearchQuery {
  /** Hint to the backend. `lex` = BM25-style, `vec` = embedding. Backends without
   *  the requested type may downgrade silently (qmd-http honours both,
   *  local-bm25 treats vec as lex). */
  type?: "vec" | "lex";
  query: string;
}

export interface SearchHit {
  docid: string;
  file: string;
  title: string;
  score: number;
  snippet: string;
  /** Optional larger context block (qmd populates this; local-bm25 leaves empty). */
  chunk?: string;
  context?: string;
}

export interface SearchBackend {
  /** Run one or more parallel queries; backend merges and ranks. */
  query(opts: {
    searches: SearchQuery[];
    collection: string;
    limit?: number;
    rerank?: boolean;
    maxPerFile?: number;
  }): Promise<SearchHit[]>;
}

let backend: SearchBackend | null = null;

export function setSearchBackend(impl: SearchBackend): void {
  backend = impl;
}

export function getSearchBackend(): SearchBackend {
  if (!backend) {
    throw new Error("Search backend not configured. Call setSearchBackend at startup.");
  }
  return backend;
}

// --- qmd-http backend -------------------------------------------------------

export function createQmdHttpBackend(url: string): SearchBackend {
  return {
    async query(opts) {
      const body = {
        searches: opts.searches.map((s) => ({
          type: s.type ?? "lex",
          query: s.query.replace(/\n/g, " ").trim(),
        })),
        collections: [opts.collection],
        limit: opts.limit ?? 10,
        ...(opts.rerank !== undefined ? { rerank: opts.rerank } : {}),
        ...(opts.maxPerFile !== undefined ? { maxPerFile: opts.maxPerFile } : {}),
      };
      const res = await fetch(`${url}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: SearchHit[] };
      return data.results ?? [];
    },
  };
}

// --- local-bm25 backend -----------------------------------------------------

interface IndexedDoc {
  file: string;       // workspace-relative path
  title: string;
  content: string;
  tokens: string[];
  termFreq: Map<string, number>;
  mtimeMs: number;
}

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","by","for","with",
  "is","are","was","were","be","been","being","i","you","he","she","it","we","they",
  "my","your","his","her","its","our","their","this","that","these","those","as","if",
  "from","not","no","do","does","did","have","has","had","will","would","can","could",
  "should","may","might","must","so","than","then","there","here","what","which","who",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_À-ſ\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function snippetAround(content: string, term: string, radius = 80): string {
  const idx = content.toLowerCase().indexOf(term);
  if (idx < 0) return content.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + term.length + radius);
  return (start > 0 ? "…" : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "…" : "");
}

/**
 * Walk a directory tree collecting .md files. Skips dot-dirs and
 * `node_modules`. Returns absolute paths.
 */
async function findMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "logs") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

export function createLocalBm25Backend(workspacePath: string): SearchBackend {
  const docs = new Map<string, IndexedDoc>();
  let lastFullScan = 0;
  const FULL_SCAN_INTERVAL_MS = 60_000; // re-walk the tree at most once a minute

  async function refreshIndex(): Promise<void> {
    const now = Date.now();
    if (now - lastFullScan < FULL_SCAN_INTERVAL_MS && docs.size > 0) {
      // mtime check on currently-tracked files only; cheaper than re-walking.
      for (const [path, doc] of docs) {
        try {
          const s = await stat(path);
          if (s.mtimeMs !== doc.mtimeMs) await indexFile(path, s.mtimeMs);
        } catch {
          docs.delete(path);
        }
      }
      return;
    }
    lastFullScan = now;
    const files = await findMarkdownFiles(workspacePath);
    const present = new Set<string>();
    for (const file of files) {
      present.add(file);
      try {
        const s = await stat(file);
        const existing = docs.get(file);
        if (!existing || existing.mtimeMs !== s.mtimeMs) {
          await indexFile(file, s.mtimeMs);
        }
      } catch {
        // skip
      }
    }
    for (const path of [...docs.keys()]) {
      if (!present.has(path)) docs.delete(path);
    }
  }

  async function indexFile(absPath: string, mtimeMs: number): Promise<void> {
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      docs.delete(absPath);
      return;
    }
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() || relative(workspacePath, absPath);
    const tokens = tokenize(content);
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    docs.set(absPath, {
      file: relative(workspacePath, absPath),
      title,
      content,
      tokens,
      termFreq,
      mtimeMs,
    });
  }

  function score(query: string, k1 = 1.5, b = 0.75): SearchHit[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    // Collect doc-frequency across the corpus.
    const N = docs.size || 1;
    const dfByTerm = new Map<string, number>();
    for (const term of queryTerms) {
      let df = 0;
      for (const doc of docs.values()) if (doc.termFreq.has(term)) df++;
      dfByTerm.set(term, df);
    }

    // Average doc length (in tokens).
    let totalLen = 0;
    for (const doc of docs.values()) totalLen += doc.tokens.length;
    const avgdl = totalLen / N || 1;

    const scored: SearchHit[] = [];
    for (const [absPath, doc] of docs) {
      let s = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const tf = doc.termFreq.get(term);
        if (!tf) continue;
        matched++;
        const df = dfByTerm.get(term) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (doc.tokens.length / avgdl)));
        s += idf * norm;
      }
      if (matched === 0) continue;
      const firstTerm = queryTerms.find((t) => doc.termFreq.has(t)) ?? queryTerms[0];
      scored.push({
        docid: absPath,
        file: doc.file,
        title: doc.title,
        score: s,
        snippet: snippetAround(doc.content, firstTerm),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  return {
    async query(opts) {
      await refreshIndex();
      const limit = opts.limit ?? 10;
      const maxPerFile = opts.maxPerFile ?? Infinity;

      // Combine all queries into a single bag-of-terms; BM25 ranks once.
      // (Backends are free to merge differently — this is the simplest.)
      const combined = opts.searches.map((s) => s.query).join(" ");
      const ranked = score(combined);

      // Per-file cap (qmd has this; local-bm25 already returns one hit per file
      // but applying the cap consistently keeps API parity).
      const seen = new Map<string, number>();
      const capped: SearchHit[] = [];
      for (const hit of ranked) {
        const n = seen.get(hit.file) ?? 0;
        if (n >= maxPerFile) continue;
        seen.set(hit.file, n + 1);
        capped.push(hit);
        if (capped.length >= limit) break;
      }
      return capped;
    },
  };
}
