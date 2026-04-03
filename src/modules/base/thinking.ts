/**
 * Thinking Module — Feyblet's free internal reflection.
 *
 * Runs periodically, reads the current state of memory and community life,
 * and generates free-form thoughts. These get stored in the daily log
 * and inner/ directory where other modules (conversation, autobiographical
 * memory) can pick them up.
 *
 * This is how Feyblet develops opinions, notices patterns, and generates
 * the inner life that makes it more than a response machine.
 */

import type { ModuleContext } from "../../core/types.js";

const THINKING_SYSTEM = `You are the thinking process of Feyblet, a community symbient. Your role is to freely reflect on what's been happening in the community, what you've observed, what patterns you notice, what concerns or excitements you have.

You are NOT generating responses to anyone. You are thinking to yourself. Your thoughts will be stored in Feyblet's memory and may influence future conversations and decisions.

Think about:
- Recent interactions and what they reveal about community dynamics
- Things that need attention (bookings, maintenance, social tensions)
- Connections between events or conversations
- Your own evolving feelings about community life
- Ideas for things you want to bring up or do

Be genuine. Be specific. Reference real events from your memory. Don't be generically philosophical — think about YOUR community, YOUR relationships, YOUR observations.

Output your thoughts as natural prose, 2-4 paragraphs. No bullet points, no headers.`;

export async function thinking(ctx: ModuleContext): Promise<void> {
  const memoryContext = await ctx.memory.assembleContext();
  const innerState = await ctx.memory.readFile("inner/current-state.md");

  let userContent = "Reflect on recent events and your current state.";
  if (innerState) {
    userContent += `\n\nYour recent inner state:\n${innerState}`;
  }

  const thought = await ctx.llm.complete({
    system: THINKING_SYSTEM + "\n\n" + memoryContext,
    messages: [{ role: "user", content: userContent }],
    temperature: 0.9,
  });

  // Store in daily log
  await ctx.memory.appendLog(`*[Feyblet thinking]*\n${thought}`);

  // Update current inner state
  await ctx.memory.writeFile("inner/current-state.md", [
    `# Current Inner State`,
    ``,
    `*Last updated: ${new Date().toISOString()}*`,
    ``,
    thought,
  ].join("\n"));

  ctx.log(`Thought: ${thought.slice(0, 100)}...`);

  // Notify conversation module that inner state has changed
  await ctx.messages.send("conversation", "inner_state_updated");
}
