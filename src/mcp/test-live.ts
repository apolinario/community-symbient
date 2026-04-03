import { callMCPTool } from "../mcp/bridge.js";
import { initMCP } from "../mcp/bridge.js";

// Init MCP first
await initMCP([{ name: "radio", url: "http://192.168.10.97:8001" }]);

// 1. Check status
console.log("=== STATUS ===");
const status = await callMCPTool("radio", "get_status");
console.log(status.slice(0, 300));

// 2. Search for music
console.log("\n=== YOUTUBE SEARCH ===");
const search = await callMCPTool("radio", "youtube_search", { query: "morning acoustic folk chill", max_results: 3 });
console.log(search.slice(0, 500));

// 3. Play first result (extract URL from search)
const urlMatch = search.match(/https:\/\/www\.youtube\.com\/watch\?v=[^\s"]+/);
if (urlMatch) {
  console.log(`\n=== PLAYING: ${urlMatch[0]} ===`);
  const play = await callMCPTool("radio", "youtube_play", { url: urlMatch[0], title: "Morning chill" });
  console.log(play);
} else {
  console.log("No URL found in search results");
}

// 4. Broadcast
console.log("\n=== BROADCAST ===");
const TTS_API = "http://localhost:8000";
const voicePath = "/home/plantoidz/Downloads/primavera.wav";

const ttsRes = await fetch(`${TTS_API}/v1/audio/speech`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "qwen3-tts",
    voice: "default",
    input: "Good morning Feytopia! It's a beautiful Monday at the chateau. We have 31 guests today, and the music is flowing.",
    response_format: "wav",
    voice_path: voicePath,
  }),
  signal: AbortSignal.timeout(60000),
});
console.log(`TTS: ${ttsRes.status}`);

if (ttsRes.ok) {
  const fs = await import("node:fs/promises");
  const http = await import("node:http");
  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  const tmpPath = `/tmp/feyblet-radio-live-${Date.now()}.wav`;
  await fs.writeFile(tmpPath, audioBuffer);

  const port = 9877;
  const myIp = "192.168.10.130";
  const audioUrl = `http://${myIp}:${port}/broadcast.wav`;

  await new Promise<void>((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audioBuffer.length.toString() });
      res.end(audioBuffer);
      server.close();
    });
    server.listen(port, async () => {
      console.log(`Serving on ${audioUrl}`);
      const r = await callMCPTool("radio", "ai_mic_play_url", { url: audioUrl });
      console.log("Play result:", r);
      setTimeout(() => { server.close(); resolve(); }, 10000);
    });
  });
}

process.exit(0);
