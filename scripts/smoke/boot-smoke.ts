/**
 * Boot smoke test (used by CI and `npm run smoke`).
 *
 * Copies the minimal starter workspace to a temp dir, serves a mock
 * OpenAI-compatible LLM, boots the framework against it with local-bm25
 * search and no chat adapter, and asserts the boot reaches
 * "All systems ready". Needs an MQTT broker on localhost:1883.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoDir = resolve(".");

const mock = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.includes("/models")) {
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
    return;
  }
  res.end(JSON.stringify({
    id: "mock", object: "chat.completion", model: "mock",
    choices: [{ index: 0, message: { role: "assistant", content: "[SILENT]" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = (mock.address() as { port: number }).port;

const tmp = mkdtempSync(join(tmpdir(), "symbient-smoke-"));
cpSync(join(repoDir, "starter-templates/minimal/workspace"), join(tmp, "workspace"), { recursive: true });
writeFileSync(join(tmp, "config.json"), JSON.stringify({
  name: "smoke-symbient",
  workspacePath: join(tmp, "workspace"),
  mqtt: { brokerUrl: "localhost", port: 1883 },
  llm: { provider: "mock", model: "mock", baseUrl: `http://127.0.0.1:${mockPort}` },
  services: { search: { backend: "local-bm25" } },
  adapters: { chat: null, directory: null },
  modules: {},
}, null, 2));

const child = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: repoDir,
  env: { ...process.env, SYMBIENT_CONFIG: join(tmp, "config.json"), DASHBOARD_PORT: "3444" },
});

let out = "";
const ok = await new Promise<boolean>((resolveDone) => {
  const timer = setTimeout(() => resolveDone(false), 90_000);
  const onData = (b: Buffer) => {
    out += b.toString();
    if (out.includes("All systems ready")) { clearTimeout(timer); resolveDone(true); }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", () => { clearTimeout(timer); resolveDone(false); });
});

child.kill("SIGTERM");
mock.close();
if (!ok) {
  console.error(`SMOKE FAILED — last output:\n${out.slice(-4000)}`);
  process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
console.log("SMOKE OK — booted to 'All systems ready' (mock LLM, local-bm25, no chat adapter).");
process.exit(0);
