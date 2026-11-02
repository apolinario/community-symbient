/**
 * Decisions — quick judgements from a local decision model: an HTTP endpoint
 * speaking pplx-decider's protocol (`POST {state, questions}` → `{answers}`;
 * a list for a batch). Each question is markdown: `workspace/decisions/<name>.md`
 * overrides the framework default in `src/decisions/`; frontmatter holds `type`
 * (`noul` | `choice` | `score`) and `criteria`, the body is the question.
 *
 * Decisions fail open: with no decider configured, or when it errors, they
 * return null and callers carry on as they would without one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";
import { render, type TemplateVars } from "./prompt-template.js";
import { createLogger } from "./logger.js";
import { symbientDisplayName } from "./symbient-name.js";

const log = createLogger("decide");
const DEFAULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "decisions");

let deciderUrl: string | null = null;
let workspacePath: string | null = null;

export function configureDecider(opts: { url?: string; workspacePath?: string }): void {
  deciderUrl = opts.url?.replace(/\/$/, "") ?? null;
  workspacePath = opts.workspacePath ?? workspacePath;
}

export const deciderAvailable = () => deciderUrl !== null;

export interface DecisionAnswer {
  type: string;
  /** `noul`: P(true). */
  noul?: number;
  /** `choice` / `score`: the chosen option and the distribution. */
  choice?: string;
  probabilities?: Record<string, number>;
  [key: string]: unknown;
}

interface Question {
  type: string;
  instructions: string;
  criteria?: unknown;
}

function question(name: string, vars: TemplateVars): Question | null {
  const candidates = [
    ...(workspacePath ? [join(workspacePath, "decisions", `${name}.md`)] : []),
    join(DEFAULTS_DIR, `${name}.md`),
  ];
  for (const path of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const { fields, body } = parseFrontmatter(raw);
    return {
      type: typeof fields.type === "string" ? fields.type : "noul",
      instructions: render(body.trim(), vars),
      ...(fields.criteria !== undefined ? { criteria: fields.criteria } : {}),
    };
  }
  log.warn(`no decision named ${name}`);
  return null;
}

async function post(body: unknown): Promise<any> {
  const res = await fetch(`${deciderUrl}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Ask decision `name` about each state in one batch; null where it can't answer. */
export async function decideMany(name: string, states: unknown[], vars: TemplateVars = {}): Promise<(DecisionAnswer | null)[]> {
  const q = deciderUrl ? question(name, { symbient: symbientDisplayName(), ...vars }) : null;
  if (!q || states.length === 0) return states.map(() => null);
  try {
    const { responses } = await post(states.map((state) => ({ state, questions: { q } })));
    return responses.map((r: any) => r?.answers?.q ?? null);
  } catch (err) {
    log.warn(`${name}: ${(err as Error).message}`);
    return states.map(() => null);
  }
}

export async function decide(name: string, state: unknown, vars: TemplateVars = {}): Promise<DecisionAnswer | null> {
  return (await decideMany(name, [state], vars))[0];
}

/** The probability a decision gives to "yes" (`noul`) or to one option (`choice`). */
export function probabilityOf(answer: DecisionAnswer | null, option?: string): number | null {
  if (!answer) return null;
  if (option === undefined) return typeof answer.noul === "number" ? answer.noul : null;
  return answer.probabilities?.[option] ?? null;
}
