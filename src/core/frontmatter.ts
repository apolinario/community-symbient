/**
 * YAML frontmatter helpers — shared across modules/, memory/, dashboard/.
 *
 * Centralised here (rather than in modules/load-modules.ts) so non-module
 * consumers (memory/manager.ts for people files, dashboard/server.ts for
 * per-module dashboardFiles/dashboardLogTag) don't reach upward into the
 * module-loader package for a generic markdown utility.
 */

import { load as yamlLoad } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Split a markdown document into its YAML frontmatter (parsed) and body.
 * Returns `{ fields: {}, body: <whole content> }` if no frontmatter
 * delimiter is found.
 */
export function parseFrontmatter(content: string): { fields: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const parsed = yamlLoad(match[1]);
  const fields: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return { fields, body: match[2].trim() };
}

/** Parse interval strings like "3h", "10m", "500ms". Default: 1 min (60_000ms). */
export function parseInterval(s: string): number {
  const match = s.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match) return 60_000;
  const n = parseInt(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    default: return n;
  }
}

/**
 * A module's interval in ms. `state/rhythms.json` ({ "<module>": "2h" }) is runtime state the
 * symbient can write; it overrides the frontmatter so deploys don't reset a rhythm it chose.
 */
export function moduleIntervalMs(workspacePath: string, name: string, fields: Record<string, unknown>): number {
  let override: unknown;
  try {
    override = JSON.parse(readFileSync(join(workspacePath, "state", "rhythms.json"), "utf-8"))[name];
  } catch {}
  const raw = typeof override === "string" ? override : fields.interval;
  return typeof raw === "string" ? parseInterval(raw) : typeof raw === "number" ? raw : 60_000;
}
