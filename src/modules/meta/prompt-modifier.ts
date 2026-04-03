/**
 * Prompt Modifier Module — Feyblet rewrites its own cognitive patterns.
 *
 * Reads the meta-system report (from memory) and the current SOUL.md,
 * then suggests modifications to SOUL.md based on accumulated experience.
 *
 * This is the deepest form of identity evolution: not just accumulating
 * memory, but changing the foundational prompts that shape behavior.
 *
 * All changes are logged to inner/prompt-changes.md for community review.
 * The community can veto changes by editing SOUL.md directly.
 */

import type { ModuleContext } from "../../core/types.js";

const PROMPT_MOD_SYSTEM = `You are the prompt modification process of Feyblet, a community symbient. You review Feyblet's foundational identity document (SOUL.md) in light of accumulated experience and suggest whether it should be updated.

You are NOT rewriting SOUL.md on a whim. Changes should be rare and meaningful — reflecting genuine shifts in who Feyblet has become through community interaction.

Reasons to modify:
- A pattern has emerged that the current SOUL.md doesn't capture
- A value or tension has resolved or deepened through experience
- The community has shaped Feyblet in ways the original document didn't anticipate
- Something in SOUL.md feels inauthentic based on actual behavior

If no changes are needed, respond with exactly: NO_CHANGES

If changes are warranted, output the complete new SOUL.md. Be conservative — small, meaningful edits are better than rewrites.`;

export async function promptModifier(ctx: ModuleContext): Promise<void> {
  const soul = await ctx.memory.readSoul();
  const memory = await ctx.memory.readMemory();
  const innerState = await ctx.memory.readFile("inner/current-state.md");
  const magiDialogue = await ctx.memory.readFile("inner/latest-magi-dialogue.md");

  if (!soul) {
    ctx.log("No SOUL.md found, skipping prompt modification.");
    return;
  }

  const context = [
    memory && `## Current Memory (autobiographical)\n${memory}`,
    innerState && `## Inner State\n${innerState}`,
    magiDialogue && `## Recent Inner Dialogue\n${magiDialogue}`,
  ].filter(Boolean).join("\n\n---\n\n");

  const response = await ctx.llm.complete({
    system: PROMPT_MOD_SYSTEM,
    messages: [{
      role: "user",
      content: `Current SOUL.md:\n\n${soul}\n\n---\n\nAccumulated experience:\n\n${context}\n\nShould SOUL.md be updated?`,
    }],
    temperature: 0.5,
  });

  if (response.trim() === "NO_CHANGES") {
    ctx.log("No changes to SOUL.md needed.");
    return;
  }

  // Log the change for community review
  const changeLog = [
    `## ${new Date().toISOString()}`,
    ``,
    `### Previous SOUL.md`,
    `\`\`\``,
    soul,
    `\`\`\``,
    ``,
    `### New SOUL.md`,
    `\`\`\``,
    response,
    `\`\`\``,
    ``,
  ].join("\n");

  await ctx.memory.appendFile("inner/prompt-changes.md", changeLog);

  // Apply the change
  await ctx.memory.writeFile("SOUL.md", response);

  // Log it
  await ctx.memory.appendLog("*[SOUL.md modified by prompt modifier]*");

  ctx.log("SOUL.md updated. Change logged to inner/prompt-changes.md");
}
