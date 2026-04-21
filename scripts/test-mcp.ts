import { createRuntime } from "mcporter";

async function main() {
  console.log("Connecting to radio MCP...");
  const rt = await createRuntime({
    servers: [{ name: "radio", command: { kind: "http" as const, url: new URL("http://192.168.10.97:8001/mcp") } }],
    clientInfo: { name: "test", version: "0.1" },
  });
  console.log("Connected. Listing tools...");
  const tools = await rt.listTools("radio", { includeSchema: true });
  console.log("Tools:", tools.map(t => t.name));

  console.log("\nCalling radio_overview...");
  const res = await rt.callTool("radio", "radio_overview", {});
  console.log("Result:", JSON.stringify(res).slice(0, 500));

  await rt.close();
  console.log("Done.");
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
