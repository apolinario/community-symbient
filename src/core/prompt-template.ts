/**
 * Prompt Template — Handlebars wrapper + section splitter.
 *
 * Module .md files carry all prompt prose. TS provides runtime values.
 * Handlebars renders `{{var}}` and `{{#if cond}}...{{/if}}` blocks.
 *
 * Sections (optional): split a body at `## name` H2 headings so one .md can
 * hold multiple named sub-prompts. Useful for things like magi's three voices
 * or conversation's group-vs-DM variants.
 */

import Handlebars from "handlebars";

export type TemplateVars = Record<string, unknown>;

export function render(template: string, vars: TemplateVars): string {
  return Handlebars.compile(template, { noEscape: true })(vars);
}

/**
 * Split a markdown body at `## name` headings.
 *
 * Returns:
 *   - body: content before the first H2 heading
 *   - sections: map of heading name → body for each H2 block
 *
 * Example:
 *   # Magi
 *   Main prose.
 *
 *   ## pragmatic
 *   You are Magi-A...
 *
 *   ## critical
 *   You are Magi-B...
 *
 * → { body: "# Magi\nMain prose.",
 *     sections: { pragmatic: "You are Magi-A...", critical: "You are Magi-B..." } }
 */
export function parseSections(markdown: string): { body: string; sections: Record<string, string> } {
  const lines = markdown.split("\n");
  const sections: Record<string, string> = {};
  const bodyLines: string[] = [];

  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentKey !== null) {
      sections[currentKey] = currentLines.join("\n").trim();
    }
    currentKey = null;
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+([\w.-]+)\s*$/);
    if (headingMatch) {
      flush();
      currentKey = headingMatch[1];
      continue;
    }
    if (currentKey !== null) {
      currentLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }
  flush();

  return {
    body: bodyLines.join("\n").trim(),
    sections,
  };
}
