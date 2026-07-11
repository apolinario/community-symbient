/**
 * Symbient setup — profile-driven provisioning.
 *
 * Renders systemd units for the chosen hardware profile into
 * infra/rendered/ and smoke-pings the configured endpoints. Never touches
 * the system itself: installing the rendered units is an explicit sudo
 * step printed at the end (or `--install` to run it now).
 *
 *   npx tsx scripts/setup/index.ts                  # auto-detect profile
 *   npx tsx scripts/setup/index.ts --profile cpu-only
 *   npx tsx scripts/setup/index.ts --with searxng,signal --install
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, cpSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { userInfo } from "node:os";
import Handlebars from "handlebars";
import { loadConfig } from "../../src/config.js";

interface Profile {
  describe: string;
  units: string[];
  optionalUnits: string[];
  llm: string;
  search: string;
}

const repoDir = resolve(".");
const infraDir = join(repoDir, "infra");
const outDir = join(infraDir, "rendered");

function sh(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function detectVramMb(): number | null {
  const out = sh("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits");
  if (!out) return null;
  return out.split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0);
}

function suggestProfile(vramMb: number | null): string {
  if (vramMb === null || vramMb === 0) return "cpu-only";
  if (vramMb >= 22_000) return "full-local";
  if (vramMb >= 7_000) return "small-gpu";
  return "cpu-only";
}

function resolveQmdExec(): string {
  const direct = sh("command -v qmd");
  if (direct) return direct;
  const bun = sh("command -v bun");
  if (bun) return `${bun} x @tobilu/qmd`;
  const npx = sh("command -v npx") ?? "/usr/bin/npx";
  return `${npx} -y @tobilu/qmd`;
}

async function ping(label: string, url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return `  ✓ ${label}: ${url} → HTTP ${res.status}`;
  } catch (err) {
    return `  ✗ ${label}: ${url} unreachable (${err instanceof Error ? err.message : err})`;
  }
}

function initCommand(args: string[]): void {
  const template = args.find((a) => !a.startsWith("--")) ?? "minimal";
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const into = flag("into") ? resolve(flag("into")!) : null;
  const tmplDir = join(repoDir, "starter-templates", template);
  if (!existsSync(tmplDir)) {
    console.error(`Unknown template "${template}". Available: ${readdirSync(join(repoDir, "starter-templates")).join(", ")}`);
    process.exit(1);
  }
  if (!into) {
    console.error("Usage: ./setup init <minimal|community> --into <dir> [--name <symbient-name>]");
    process.exit(1);
  }
  if (existsSync(join(into, "workspace"))) {
    console.error(`${join(into, "workspace")} already exists — refusing to overwrite.`);
    process.exit(1);
  }
  const name = flag("name") ?? basename(into);
  mkdirSync(into, { recursive: true });
  cpSync(join(tmplDir, "workspace"), join(into, "workspace"), { recursive: true });
  // Workspace extensions import framework internals via relative ../src
  // paths and npm packages by bare specifier — both resolve from the
  // extension file's location, so the deployment dir links back here.
  for (const link of ["src", "node_modules"]) {
    try { symlinkSync(join(repoDir, link), join(into, link)); } catch { /* exists */ }
  }
  const tmplConfig = JSON.parse(readFileSync(join(into, "workspace", "config", "config.json"), "utf-8"));
  const configPath = join(into, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...tmplConfig, name, workspacePath: join(into, "workspace") }, null, 2) + "\n");
  console.log(`Initialized "${name}" from the ${template} template at ${into}

Next:
  1. Write ${into}/workspace/SOUL.md — who is this symbient?
  2. Point llm at your endpoint in ${configPath} — see docs/choosing-your-llm.md
  3. Configure the chat adapter (adapters.chat), or leave it null to start
  4. Run:  SYMBIENT_CONFIG=${configPath} npx tsx src/index.ts   (from ${repoDir})
  5. For systemd units:  SYMBIENT_CONFIG=${configPath} ./setup --profile <p>`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "init") return initCommand(args.slice(1));
  const getFlag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(`--${name}`);

  const profiles: Record<string, Profile> = JSON.parse(readFileSync(join(infraDir, "profiles.json"), "utf-8"));

  // ── profile ────────────────────────────────────────────────────────
  const vram = detectVramMb();
  const suggested = suggestProfile(vram);
  const profileName = getFlag("profile") ?? suggested;
  const profile = profiles[profileName];
  if (!profile) {
    console.error(`Unknown profile "${profileName}". Available: ${Object.keys(profiles).join(", ")}`);
    process.exit(1);
  }
  console.log(`Hardware: ${vram ? `${Math.round(vram / 1024)} GB VRAM detected` : "no NVIDIA GPU detected"} → suggested profile: ${suggested}`);
  console.log(`Profile: ${profileName} — ${profile.describe}\n`);

  // ── config (optional at setup time) ────────────────────────────────
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig();
  } catch (err) {
    console.log(`Config not loadable yet (${err instanceof Error ? err.message.split("\n")[0] : err}) — rendering with defaults.\n`);
  }

  // ── render units ───────────────────────────────────────────────────
  const withExtras = (getFlag("with") ?? "").split(",").filter(Boolean);
  const unitNames = [...profile.units, ...withExtras.flatMap((w) =>
    w === "signal" ? ["signal-api", "signal-watchdog"] : [w])];
  const vars = {
    name: config?.name ?? "symbient",
    user: userInfo().username,
    repoDir,
    npxBin: sh("command -v npx") ?? "/usr/bin/npx",
    qmdExec: resolveQmdExec(),
    qmdPort: new URL(config?.services?.search?.url ?? "http://localhost:8181").port || "8181",
    withQmd: unitNames.includes("qmd"),
    withSearxng: unitNames.includes("searxng"),
    // External deployments run with SYMBIENT_CONFIG pointing at their dir
    configPath: process.env.SYMBIENT_CONFIG ?? "",
  };

  mkdirSync(outDir, { recursive: true });
  const rendered: string[] = [];
  for (const tmpl of readdirSync(join(infraDir, "systemd"))) {
    const unit = tmpl.replace(/\.(service|timer)\.hbs$/, "");
    if (!unitNames.includes(unit)) continue;
    const suffix = tmpl.endsWith(".timer.hbs") ? ".timer" : ".service";
    // The symbient unit is named after the deployment (feyblet.service etc.)
    const outName = (unit === "symbient" ? vars.name : unit) + suffix;
    const template = Handlebars.compile(readFileSync(join(infraDir, "systemd", tmpl), "utf-8"));
    writeFileSync(join(outDir, outName), template(vars), "utf-8");
    rendered.push(outName);
  }
  console.log(`Rendered ${rendered.length} unit(s) into infra/rendered/: ${rendered.join(", ")}\n`);

  // ── smoke-ping endpoints ───────────────────────────────────────────
  if (!has("skip-ping") && config) {
    console.log("Endpoint check:");
    const checks: Promise<string>[] = [];
    if (config.llm.baseUrl) {
      const base = config.llm.baseUrl.endsWith("/v1") ? config.llm.baseUrl : `${config.llm.baseUrl}/v1`;
      checks.push(ping("LLM", `${base}/models`));
    } else {
      checks.push(Promise.resolve(`  • LLM: hosted provider "${config.llm.provider}" — checked at first request (key env: ${config.llm.apiKeyEnv ?? "conventional"})`));
    }
    if (config.llm.tinyBaseUrl) checks.push(ping("tiny LLM", `${config.llm.tinyBaseUrl}/v1/models`));
    if (config.services?.search?.url) checks.push(ping("search (qmd)", config.services.search.url));
    if (config.services?.tts?.url) checks.push(ping("TTS", config.services.tts.url));
    if (config.services?.searxng?.url) checks.push(ping("SearXNG", config.services.searxng.url));
    for (const line of await Promise.all(checks)) console.log(line);
    console.log();
  }

  // ── guidance ───────────────────────────────────────────────────────
  console.log(`LLM:    ${profile.llm}`);
  console.log(`Search: ${profile.search}\n`);

  const installCmds = [
    `sudo cp ${rendered.map((r) => `infra/rendered/${r}`).join(" ")} /etc/systemd/system/`,
    "sudo systemctl daemon-reload",
    `sudo systemctl enable --now ${rendered.filter((r) => r.endsWith(".service")).map((r) => r.replace(/\.service$/, "")).join(" ")}`,
  ];
  if (has("install")) {
    for (const cmd of installCmds) {
      console.log(`$ ${cmd}`);
      const res = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
      if (res.status !== 0) process.exit(res.status ?? 1);
    }
  } else {
    console.log("To install (review infra/rendered/ first):");
    for (const cmd of installCmds) console.log(`  ${cmd}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
