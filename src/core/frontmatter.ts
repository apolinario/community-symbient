/**
 * YAML frontmatter helpers — shared across modules/, memory/, dashboard/.
 *
 * Centralised here (rather than in modules/load-modules.ts) so non-module
 * consumers (memory/manager.ts for people files, dashboard/server.ts for
 * per-module dashboardFiles/dashboardLogTag) don't reach upward into the
 * module-loader package for a generic markdown utility.
 */

import { load as yamlLoad } from "js-yaml";

/**
 * Split a markdown document into its YAML frontmatter (parsed) and body.
 * Returns `{ fields: {}, body: <whole content> }` if no frontmatter
 * delimiter is found.
 */
export function parseFrontmatter(content: string): { fields: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const fields = (yamlLoad(match[1]) as Record<string, unknown>) ?? {};
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
