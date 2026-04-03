/**
 * People Enrich Module — LLM-based profile enrichment.
 *
 * Every 2 days, scans for people with recent activity and asks the LLM
 * to update their profile based on what they've said in group chat.
 *
 * This doesn't log interactions — it builds a living portrait:
 * who they are, what they do, what they care about, languages they speak,
 * connections they've made at Fey.
 */

import type { ModuleContext } from "../../core/types.js";
import type { MemoryManager } from "../../memory/manager.js";
import { completeText } from "../../core/llm.js";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export function createPeopleEnrichModule(memory: MemoryManager) {
  return async function peopleEnrich(ctx: ModuleContext): Promise<void> {
    const workspacePath = "./workspace";
    let enriched = 0;

    try {
      // Gather recent messages from last 2 days
      const todayLog = await memory.readTodayLog();
      const yesterdayLog = await memory.readYesterdayLog();
      const recentLogs = [yesterdayLog, todayLog].filter(Boolean).join("\n\n");

      if (!recentLogs || recentLogs.length < 100) return;

      // Extract who's been active
      const senderPattern = /^\*\*([^*]+)\*\*\s*\((?:group|dm)[^)]*\):\s*([\s\S]*?)(?=\n## |\n\*\*[^*]+\*\*|$)/gm;
      const messagesByPerson = new Map<string, string[]>();
      let m;
      while ((m = senderPattern.exec(recentLogs)) !== null) {
        const name = m[1];
        const text = m[2].trim();
        if (name === "Feyblet" || text.length < 10) continue;
        const existing = messagesByPerson.get(name);
        if (existing) existing.push(text);
        else messagesByPerson.set(name, [text]);
      }

      // For each active person, check if their profile could use enrichment
      const peopleDir = join(workspacePath, "people");
      for (const [name, messages] of messagesByPerson) {
        // Need at least 2 substantive messages to be worth enriching
        if (messages.length < 2) continue;

        const found = await memory.findPerson(name);
        if (!found) continue;

        const profilePath = join(peopleDir, `${found.slug}.md`);
        let profile: string;
        try { profile = await readFile(profilePath, "utf-8"); } catch { continue; }

        // Extract existing profile paragraph (between heading and first ## section)
        const body = profile.replace(/^---[\s\S]*?---\s*/, "").replace(/^#[^\n]*\n*/, "");
        const sectionIdx = body.indexOf("\n## ");
        const existingParagraph = (sectionIdx >= 0 ? body.slice(0, sectionIdx) : body).trim();

        // Step 1: Extract new info from recent messages
        const messageBlock = messages.slice(-20).join("\n---\n");

        const newInfo = await completeText(ctx.model, {
          system: `You are reading a community member's recent messages at Château du Feÿ. Extract any NEW biographical information about who this person is.

Focus on: background, skills, profession, interests, projects, languages, where they're from, personality.

Do NOT list what they did ("they asked for a ride"). Extract who they ARE ("French filmmaker based in Paris, works with AI").
If the messages are too mundane (logistics, greetings, reactions) to learn anything about the person, output SKIP.

Output a brief summary of what you learned, or SKIP.`,
          messages: [{
            role: "user",
            content: `Person: ${name}\n\nRecent messages:\n${messageBlock}`,
          }],
          temperature: 0.3,
          maxTokens: 200,
          apiKey: ctx.apiKey,
        });

        const newInfoTrimmed = newInfo.trim();
        if (!newInfoTrimmed || newInfoTrimmed === "SKIP" || newInfoTrimmed.length < 20) continue;

        // Step 2: Synthesize with existing profile — minimal changes
        const synthesized = await completeText(ctx.model, {
          system: `You are maintaining a community member's profile at Château du Feÿ. You have their current profile and some newly learned information.

Your job: produce an updated profile paragraph (3-6 sentences) that incorporates any genuinely new details.

Rules:
- Keep the existing profile as close to unchanged as possible
- Only add or adjust what the new information clearly warrants
- If the new info doesn't add anything the profile doesn't already capture, output the existing profile unchanged
- Do NOT remove existing information unless it's clearly wrong
- Build a portrait, not a log — no "they said X" or "they asked about Y"
- Output ONLY the profile paragraph, no headers or formatting`,
          messages: [{
            role: "user",
            content: `Current profile:\n${existingParagraph || "(empty — this is a new profile)"}\n\nNewly learned:\n${newInfoTrimmed}`,
          }],
          temperature: 0.3,
          maxTokens: 300,
          apiKey: ctx.apiKey,
        });

        const trimmed = synthesized.trim();
        if (!trimmed || trimmed.length < 20) continue;
        // Skip if synthesis is identical to existing
        if (trimmed === existingParagraph) continue;

        // Insert the profile paragraph after the # Name heading, before Booking History
        const headingMatch = profile.match(/^(---[\s\S]*?---\s*#[^\n]*\n)/);
        if (!headingMatch) continue;

        const before = headingMatch[1];
        const after = profile.slice(before.length);

        // Replace existing profile paragraph or insert new one
        let newProfile: string;
        if (after.trimStart().startsWith("## Booking History") || after.trim() === "") {
          // No existing paragraph — insert
          newProfile = `${before}\n${trimmed}\n\n${after}`;
        } else {
          // Replace everything between heading and first ## section
          const sectionStart = after.indexOf("\n## ");
          if (sectionStart >= 0) {
            newProfile = `${before}\n${trimmed}\n${after.slice(sectionStart)}`;
          } else {
            newProfile = `${before}\n${trimmed}\n`;
          }
        }

        await writeFile(profilePath, newProfile, "utf-8");
        enriched++;
        ctx.log(`Enriched profile: ${name}`);
      }

      if (enriched > 0) {
        ctx.log(`People enrich: ${enriched} profiles updated`);
      }
    } catch (err) {
      ctx.log(`People enrich error: ${err}`);
    }
  };
}
