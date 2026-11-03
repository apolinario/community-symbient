import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, type TemplateVars } from "./prompt-template.js";
import { parseFrontmatter } from "./frontmatter.js";

const DEFAULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
let workspacePath: string | null = null;

export function setPromptsWorkspace(path: string): void {
  workspacePath = path;
}

/** Render prompt `name`: `workspace/prompts/<name>.md` if the workspace has one, else the framework default in `src/prompts/`. */
export function prompt(name: string, vars: TemplateVars = {}): string {
  const candidates = [
    ...(workspacePath ? [join(workspacePath, "prompts", `${name}.md`)] : []),
    join(DEFAULTS_DIR, `${name}.md`),
  ];
  for (const path of candidates) {
    try {
      return render(readFileSync(path, "utf-8").trim(), vars);
    } catch {}
  }
  return "";
}

/**
 * Tool guides: how a group of tools works together, beyond what each tool's description holds.
 * A guide is `guides/<name>.md` (workspace over framework, by name) whose frontmatter `tools:`
 * lists the tools it explains. A run gets the guides for the tools it has, after its prompt.
 */
export function withToolGuides(systemPrompt: string, toolNames: string[], vars: TemplateVars = {}): string {
  const have = new Set(toolNames);
  const files = new Map<string, string>();
  for (const dir of [join(DEFAULTS_DIR, "..", "guides"), ...(workspacePath ? [join(workspacePath, "guides")] : [])]) {
    let names: string[] = [];
    try { names = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch {}
    for (const name of names) files.set(name, join(dir, name));
  }
  const guides: string[] = [];
  for (const [, path] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const { fields, body } = parseFrontmatter(readFileSync(path, "utf-8"));
    const tools = Array.isArray(fields.tools) ? fields.tools.map(String) : [];
    if (tools.some((t) => have.has(t))) guides.push(render(body.trim(), vars));
  }
  return guides.length ? `${systemPrompt}\n\n${prompt("tool-guides", { ...vars, guides })}` : systemPrompt;
}
