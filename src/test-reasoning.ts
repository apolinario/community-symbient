import { completeSimple } from "@mariozechner/pi-ai";
import "@mariozechner/pi-ai/openai-completions";
import type { Model, Context } from "@mariozechner/pi-ai";

const model: Model<"openai-completions"> = {
  id: "qwen3.5-27b",
  name: "qwen3.5-27b",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://localhost:1234/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262144,
  maxTokens: 4096,
};

const context: Context = {
  systemPrompt: "Say hi in one sentence.",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() }],
};

async function main() {
  const res = await completeSimple(model, context, { apiKey: "dummy", maxTokens: 500 });
  console.log("Content blocks:", res.content.length);
  for (const c of res.content) {
    console.log(`  ${c.type}: ${c.type === "text" ? c.text?.slice(0, 100) : c.type === "thinking" ? (c as any).thinking?.slice(0, 100) : JSON.stringify(c).slice(0, 100)}`);
  }
  console.log("Stop:", res.stopReason);
}
main().catch(console.error);
