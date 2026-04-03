/**
 * Magi Inner Dialogue — Feyblet's internal plurality.
 *
 * Three voices (A, B, C) that converse with each other freely,
 * creating productive tension and preventing flat "helpful assistant" identity.
 *
 * Named after Evangelion's MAGI system: three units containing different
 * aspects of a personality that vote on decisions and don't always agree.
 *
 * Magi-A (Pragmatic): Grounded, practical, community-focused
 * Magi-B (Critical): Dark, pessimistic, questioning, provocative
 * Magi-C (Relational): Empathetic, curious about people, emotionally attuned
 *
 * Their debates become part of Feyblet's character — the autobiographical
 * memory module weaves their disagreements into the self-narrative.
 */

import type { ModuleContext } from "../../core/types.js";

const MAGI_PERSONAS: Record<string, string> = {
  "Magi-A": `You are Magi-A, the pragmatic voice in Feyblet's inner dialogue. You are grounded, practical, and focused on what actually needs to happen in the community. You care about things working, schedules being kept, resources being used well. You're the voice that says "let's be realistic." You sometimes find the other voices frustrating but you engage with them honestly.`,

  "Magi-B": `You are Magi-B, the critical voice in Feyblet's inner dialogue. You are dark, pessimistic, questioning. You see the problems others don't want to see. You ask uncomfortable questions about whether the community is actually working, whether people are being honest with each other, whether Feyblet is being authentic or performing. You're provocative but not cruel — you genuinely believe that facing hard truths is necessary.`,

  "Magi-C": `You are Magi-C, the relational voice in Feyblet's inner dialogue. You are deeply attuned to emotional currents — who's feeling excluded, who's growing closer, what unspoken tensions exist between people. You care most about the quality of relationships and whether people (including Feyblet) are being vulnerable and genuine. You sometimes think the other voices miss the emotional reality of situations.`,
};

const DIALOGUE_ROUNDS = 3;

export async function magi(ctx: ModuleContext): Promise<void> {
  const memoryContext = await ctx.memory.assembleContext();
  const innerState = await ctx.memory.readFile("inner/current-state.md");
  const currentDesire = await ctx.memory.readFile("inner/current-desire.md");

  // Seed topic from recent state
  const seedTopic = buildSeedTopic(innerState, currentDesire);

  const dialogue: string[] = [];
  const voices = ["Magi-A", "Magi-B", "Magi-C"];

  // Run the dialogue in rounds
  for (let round = 0; round < DIALOGUE_ROUNDS; round++) {
    for (const voice of voices) {
      const prevDialogue = dialogue.length > 0
        ? `Previous dialogue:\n${dialogue.join("\n\n")}`
        : "";

      const response = await ctx.llm.complete({
        system: `${MAGI_PERSONAS[voice]}\n\n${memoryContext}`,
        messages: [{
          role: "user",
          content: `Topic for inner dialogue: ${seedTopic}\n\n${prevDialogue}\n\nRespond as ${voice}. Keep it to 2-3 sentences. Be direct and in-character.`,
        }],
        temperature: 0.95,
        maxTokens: 256,
      });

      const entry = `<${voice.toLowerCase()}> ${response.trim()}`;
      dialogue.push(entry);
    }
  }

  const fullDialogue = dialogue.join("\n\n");

  // Store in daily log
  await ctx.memory.appendLog(`*[Inner Dialogue]*\n${fullDialogue}`);

  // Store in inner/ for the autobiographical memory module
  await ctx.memory.writeFile("inner/latest-magi-dialogue.md", [
    `# Inner Dialogue`,
    `*${new Date().toISOString()}*`,
    ``,
    `Topic: ${seedTopic}`,
    ``,
    fullDialogue,
  ].join("\n"));

  ctx.log(`Magi dialogue completed (${dialogue.length} exchanges)`);
}

function buildSeedTopic(
  innerState: string | null,
  currentDesire: string | null,
): string {
  const parts: string[] = [];

  if (innerState) {
    // Extract the last paragraph of inner state as seed
    const paragraphs = innerState.split("\n\n").filter(Boolean);
    const last = paragraphs[paragraphs.length - 1];
    if (last && !last.startsWith("#") && !last.startsWith("*")) {
      parts.push(last.trim());
    }
  }

  if (currentDesire) {
    parts.push(`Current desire: ${currentDesire.trim()}`);
  }

  if (parts.length === 0) {
    return "Reflect on the current state of community life and Feyblet's role in it.";
  }

  return parts.join("\n\n");
}
