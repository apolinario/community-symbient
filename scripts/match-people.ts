// One-shot matcher: takes the name→uuid map scraped from event logs,
// runs each through findPerson with the production wiring, and reports
// matched vs unmatched + which matches need their signal-uuid updated.
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryManager } from "/home/plantoidz/pi/feyblet/src/memory/manager.ts";
import { createFeyEnricher } from "/home/plantoidz/pi/feyblet/workspace/services/feyops/enricher.ts";
import { FeyOpsDB } from "/home/plantoidz/pi/feyblet/workspace/services/feyops/db.ts";

const WORKSPACE = "/home/plantoidz/pi/feyblet/workspace";
const VALID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPLY = process.argv.includes("--apply");

async function main() {
const memory = new MemoryManager(WORKSPACE);
const feyopsDb = new FeyOpsDB("/home/plantoidz/pi/feyblet/data/feyops.db");
memory.setEnricher(createFeyEnricher({ feyopsDb, workspacePath: WORKSPACE }));

const pairs: [string, string][] = JSON.parse(readFileSync("/tmp/feyblet-name-uuid.json", "utf-8"));

const matched: Array<{ name: string; uuid: string; slug: string; existing_uuid: string | null; action: "noop" | "fill" | "replace" }> = [];
const unmatched: Array<{ name: string; uuid: string }> = [];

for (const [name, uuid] of pairs) {
  if (name === "Feyblet" || name === "feyblet") continue;
  const r = await memory.findPerson(name);
  if (!r) { unmatched.push({ name, uuid }); continue; }
  const existing = r.content.match(/signal-uuid:\s*["']?([\w-]+)["']?/)?.[1] ?? null;
  let action: "noop" | "fill" | "replace" = "noop";
  if (!existing) action = "fill";
  else if (!VALID_UUID.test(existing)) action = "replace";
  else if (existing.toLowerCase() !== uuid.toLowerCase()) action = "replace"; // wrong uuid stored
  matched.push({ name, uuid, slug: r.slug, existing_uuid: existing, action });
}

console.log(`MATCHED: ${matched.length}`);
console.log(`  noop:    ${matched.filter(m => m.action === "noop").length}`);
console.log(`  fill:    ${matched.filter(m => m.action === "fill").length}`);
console.log(`  replace: ${matched.filter(m => m.action === "replace").length}`);
console.log(`UNMATCHED: ${unmatched.length}`);

console.log("\n--- fills ---");
for (const m of matched.filter(m => m.action === "fill")) console.log(`  ${m.slug.padEnd(35)} ← ${m.name}`);
console.log("\n--- replaces ---");
for (const m of matched.filter(m => m.action === "replace")) console.log(`  ${m.slug.padEnd(35)} ← ${m.name} (was: ${m.existing_uuid})`);
console.log("\n--- unmatched ---");
for (const u of unmatched) console.log(`  ${u.name}`);

if (APPLY) {
  for (const m of matched) {
    if (m.action === "noop") continue;
    const filePath = `${WORKSPACE}/people/${m.slug}.md`;
    let content = readFileSync(filePath, "utf-8");
    const existingMatch = content.match(/signal-uuid:\s*["']?([\w-]+)["']?/);
    if (existingMatch) {
      content = content.replace(existingMatch[0], `signal-uuid: "${m.uuid}"`);
    } else {
      content = content.replace(/^(---\n)/, `$1signal-uuid: "${m.uuid}"\n`);
    }
    writeFileSync(filePath, content, "utf-8");
    console.log(`updated ${m.slug}`);
  }
}
}
main();
