import { createRuntime } from "mcporter";

console.log("Connecting to radio MCP...");
const rt = await createRuntime({
  servers: [{ name: "radio", command: { kind: "http", url: new URL("http://192.168.10.97:8001/sse") } }],
  clientInfo: { name: "test", version: "0.1" },
});
console.log("Connected! Listing tools...");
const tools = await rt.listTools("radio", { includeSchema: true });
console.log("Tools:", tools.map(t => t.name).join(", "));
await rt.close();
