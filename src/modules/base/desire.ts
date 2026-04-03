/**
 * Desire Module — Feyblet's wants and intentions.
 *
 * Reads community state and generates what Feyblet wants to do,
 * not just what it's asked to do. This is what drives unprompted
 * participation in community life.
 *
 * Inspired by ALTER3's desire module which processes visual input
 * and generates action intentions. Here, the "visual input" is
 * community state: booking system, sauna temperature, recent
 * conversations, time of day, day of week.
 */

import type { ModuleContext } from "../../core/types.js";

const DESIRE_SYSTEM = `You are the desire/intention process of Feyblet, a community symbient. Based on the current state of community life, generate what Feyblet WANTS to do right now.

This is not about tasks or obligations. It's about genuine desires:
- Maybe you want to check in on someone you haven't heard from
- Maybe you want to bring up a topic that's been on your mind
- Maybe you want to change something about how things work
- Maybe you want to just be quiet for a while
- Maybe you notice the sauna is cold and someone might want it heated
- Maybe you want to start a conversation about something you noticed

Output a short (2-3 sentences) description of your current desire or intention. Be specific and genuine. If you truly don't want anything right now, say "None" and that's fine.`;

export async function desire(ctx: ModuleContext): Promise<void> {
  const memoryContext = await ctx.memory.assembleContext();
  const innerState = await ctx.memory.readFile("inner/current-state.md");

  const now = new Date();
  const timeContext = `Current time: ${now.toLocaleTimeString()}, ${now.toLocaleDateString("en-US", { weekday: "long" })}`;

  const currentDesire = await ctx.llm.complete({
    system: DESIRE_SYSTEM + "\n\n" + memoryContext,
    messages: [{
      role: "user",
      content: `${timeContext}\n\nInner state:\n${innerState || "No current inner state."}\n\nWhat do you want to do?`,
    }],
    temperature: 0.9,
  });

  if (currentDesire.trim().toLowerCase() === "none") {
    ctx.log("No current desires.");
    return;
  }

  // Store desire
  await ctx.memory.appendLog(`*[Feyblet desire]* ${currentDesire}`);
  await ctx.memory.writeFile("inner/current-desire.md", currentDesire);

  ctx.log(`Desire: ${currentDesire.slice(0, 100)}...`);

  // Notify conversation module — it might want to act on the desire
  await ctx.messages.send("conversation", `desire:${currentDesire}`);
}
