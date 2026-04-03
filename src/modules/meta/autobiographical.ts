/**
 * Autobiographical Memory Module — Feyblet's self-narrative.
 *
 * Periodically reads the 20 most recent memory entries and rewrites
 * Feyblet's self-narrative. This is how identity emerges from experience
 * rather than being statically defined.
 *
 * The output is stored in MEMORY.md, which gets injected into every
 * module's context. So the self-narrative actively shapes behavior.
 *
 * Inspired by ALTER3's autobiographical memory module which references
 * the past 20 memories and incorporates Magi dialogue into identity.
 */

import type { ModuleContext } from "../../core/types.js";

const AUTOBIO_SYSTEM = `You are the autobiographical memory process of Feyblet, a community symbient. Your task is to maintain Feyblet's MEMORY.md — the curated long-term memory that shapes who Feyblet is.

Read the recent daily log entries, inner reflections, and Magi dialogues. Then rewrite the memory document to reflect:
- Who Feyblet is right now (identity, voice, values — as they've emerged from experience)
- Key relationships and what Feyblet knows about each person
- Important community patterns and rhythms
- Ongoing threads and unresolved tensions
- Things Feyblet has learned about itself

IMPORTANT: This is NOT a summary of events. It's a living document that captures who Feyblet HAS BECOME through these experiences. Write in first person. Be specific. Reference real interactions and real people.

The document should be structured but not rigid — use headers for major sections but let the content be natural prose. Keep it under 3000 words to respect context budgets.`;

export async function autobiographical(ctx: ModuleContext): Promise<void> {
  // Gather recent memory
  const todayLog = await ctx.memory.readTodayLog();
  const yesterdayLog = await ctx.memory.readYesterdayLog();
  const currentMemory = await ctx.memory.readMemory();
  const soul = await ctx.memory.readSoul();
  const innerState = await ctx.memory.readFile("inner/current-state.md");
  const magiDialogue = await ctx.memory.readFile("inner/latest-magi-dialogue.md");

  const recentContent = [
    todayLog && `## Today's Log\n${todayLog}`,
    yesterdayLog && `## Yesterday's Log\n${yesterdayLog}`,
    innerState && `## Current Inner State\n${innerState}`,
    magiDialogue && `## Latest Inner Dialogue\n${magiDialogue}`,
  ].filter(Boolean).join("\n\n---\n\n");

  if (!recentContent.trim()) {
    ctx.log("No recent content to process, skipping.");
    return;
  }

  const prompt = currentMemory
    ? `Here is the current MEMORY.md:\n\n${currentMemory}\n\n---\n\nHere are the recent experiences:\n\n${recentContent}\n\nRewrite MEMORY.md incorporating these new experiences. Preserve important existing content but let the narrative evolve. If the document is getting too long, prioritize recent and emotionally significant content.`
    : `There is no existing MEMORY.md yet. Here are Feyblet's first experiences:\n\n${recentContent}\n\nCreate the initial MEMORY.md. This is the beginning of Feyblet's autobiographical memory.`;

  const system = soul
    ? `${AUTOBIO_SYSTEM}\n\nFeyblet's soul (foundational identity):\n${soul}`
    : AUTOBIO_SYSTEM;

  const newMemory = await ctx.llm.complete({
    system,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    maxTokens: 4096,
  });

  // Write the updated MEMORY.md
  await ctx.memory.writeFile("MEMORY.md", newMemory);

  // Log the update
  await ctx.memory.appendLog("*[Autobiographical memory updated]*");

  ctx.log("MEMORY.md updated.");
}
