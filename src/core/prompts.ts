import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, type TemplateVars } from "./prompt-template.js";

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
