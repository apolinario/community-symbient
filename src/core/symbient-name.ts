/**
 * Symbient name registry — the symbient's own name, used in daily-log
 * entry prefixes (`**<Symbient>** (dm to X): ...`) and when filtering logs
 * so a symbient doesn't mistake its own past messages for someone else's.
 *
 * Set once at startup from `config.name`. Readers get both the canonical
 * form (lowercase, as in config) and a display form (capitalized for
 * markdown headings). For a community that picks a different name, the
 * whole log pipeline adapts without any source edits.
 */

let canonical = "symbient";

/** Call once at startup from src/index.ts with config.name. */
export function setSymbientName(name: string): void {
  canonical = (name || "symbient").trim();
}

/** Lowercase/canonical form (as configured). */
export function symbientName(): string {
  return canonical;
}

/** Display form — first letter uppercased. Used in markdown log entries. */
export function symbientDisplayName(): string {
  if (!canonical) return "Symbient";
  return canonical[0].toUpperCase() + canonical.slice(1);
}
