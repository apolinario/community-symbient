/**
 * Quick integration test for Feyblet's subsystems.
 * Run: node node_modules/tsx/dist/cli.mjs test-systems.ts
 */

import { MemoryManager } from "./src/memory/manager.js";

async function testMemory() {
  console.log("=== MEMORY ===");
  const m = new MemoryManager("./workspace");

  const soul = await m.readSoul();
  console.log("SOUL.md:", soul ? `${soul.slice(0, 80)}... (${soul.length} chars)` : "MISSING");

  const people = await m.discoverPeople();
  console.log("People:", people.length);
  if (people.length > 0) console.log("  Sample:", people.slice(0, 3).map(p => p.name).join(", "));

  const skills = await m.discoverSkills();
  console.log("Skills:", skills.length);
  skills.forEach(s => console.log(`  - ${s.name}: ${s.description.slice(0, 60)}`));

  const joscha = await m.readPerson("Joscha");
  console.log("Person lookup 'Joscha':", joscha ? `found (${joscha.length} chars)` : "NOT FOUND");

  const ctx = await m.assembleContext("Joscha Bach");
  console.log("Context assembly:", ctx.length, "chars");
  console.log("  soul:", ctx.includes("<soul>"), "| person:", ctx.includes("Joscha"), "| skills:", ctx.includes("<available-skills>"), "| directory:", ctx.includes("<community-directory>"));
}

async function testLLM() {
  console.log("\n=== LLM (LM Studio) ===");
  try {
    const res = await fetch("http://localhost:1234/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen/qwen3.5-35b-a3b",
        messages: [
          { role: "system", content: "You are Feyblet, a symbient at Chateau du Fey. One sentence only." },
          { role: "user", content: "Who are you?" },
        ],
        max_tokens: 150,
        temperature: 0.8,
      }),
    });
    const data = await res.json() as any;
    console.log("OK:", data.choices[0].message.content);
  } catch (err) {
    console.log("FAILED:", err);
  }
}

async function testSignal() {
  console.log("\n=== SIGNAL ===");
  try {
    const about = await fetch("http://localhost:8080/v1/about");
    const info = await about.json() as any;
    console.log("API:", info.version, "mode:", info.mode);

    const groups = await fetch("http://localhost:8080/v1/groups/+15674026181");
    const groupList = await groups.json() as any[];
    console.log("Groups:", groupList.length);
    groupList.forEach(g => console.log(`  - ${g.name}: ${g.members.length} members`));
  } catch (err) {
    console.log("FAILED:", err);
  }
}

async function testSauna() {
  console.log("\n=== SAUNA ===");
  try {
    const res = await fetch("https://docs.google.com/spreadsheets/d/1nQioINK2QYU3MymE5u04F5K0GBASeOIC96TA4UtiQL4/gviz/tq?tqx=out:json&tq=order%20by%20A%20desc%20limit%201");
    const text = await res.text();
    const json = JSON.parse(text.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    const row = json.table.rows[0].c;
    console.log("OK:", row[0].f, "-", row[1].v, "C");
  } catch (err) {
    console.log("FAILED:", err);
  }
}

async function testAmenitiz() {
  console.log("\n=== AMENITIZ ===");
  const token = process.env.AMENITIZ_ACCESS_TOKEN;
  const hotelId = process.env.AMENITIZ_HOTEL_ID;
  if (!token || !hotelId) {
    console.log("SKIPPED (no credentials in env)");
    return;
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `https://api.amenitiz.io/vendor_api/v1/bookings/checkin?hotel_id=${hotelId}&from=${today}&to=${today}&locale=en`,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
    );
    const data = await res.json() as any;
    if (res.ok) {
      const bookings = Array.isArray(data) ? data : data.data || data.bookings || [];
      console.log("OK:", bookings.length, "check-ins today");
    } else {
      console.log("API error:", res.status, JSON.stringify(data).slice(0, 200));
    }
  } catch (err) {
    console.log("FAILED:", err);
  }
}

async function main() {
  console.log("Feyblet Systems Test\n");
  await testMemory();
  await testSignal();
  await testSauna();

  // Load .env for Amenitiz
  const { readFileSync } = await import("node:fs");
  try {
    const env = readFileSync(".env", "utf-8");
    for (const line of env.split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      const [key, ...rest] = line.split("=");
      process.env[key.trim()] = rest.join("=").trim();
    }
  } catch {}

  await testAmenitiz();
  await testLLM(); // last since it's slowest

  console.log("\n=== DONE ===");
}

main().catch(console.error);
