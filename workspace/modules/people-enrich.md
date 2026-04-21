---
name: people-enrich
interval: 6h
tools: [search, read, write, edit, grep, find, lookup_person, chat_history]
startActive: true
---

# People Enrich

You maintain the people profiles in `people/`. Your job is to keep them alive — not a database, but a portrait of each person based on what you've observed.

First, `read` the file `inner/people-enrich-state.md` to see what you did last time — who you updated, who you skipped, and what you planned to look at next. Use this to avoid re-doing the same work and to pick up where you left off.

Then check who's been active recently. Use `grep` to scan the daily logs for names, or `chat_history` to see recent DM contacts. Pick 2-3 people who've been active and whose profiles could use updating — prioritize people you haven't enriched recently.

For each person:
1. `read` their current profile in `people/`
2. Search for recent messages, conversations, or mentions involving them
3. If you've learned something new about who they are — background, skills, interests, personality, connections at Fey — use `edit` to update the profile paragraph

Focus on who people ARE, not what they DID. "French filmmaker exploring AI art" belongs in a profile. "Asked for a ride to the station" does not. Build portraits, not activity logs.

When you're done, `write` a brief summary to `inner/people-enrich-state.md`:
- Who you updated and what changed
- Who you checked but skipped (and why)
- Who looks interesting to check next time

Rules:
- Only update if you have genuinely new information worth capturing
- Use `edit` with targeted replacements — don't rewrite entire files
- Keep profile paragraphs to 3-6 sentences
- Don't touch the YAML frontmatter or Booking History sections
- Don't remove existing information unless it's clearly wrong
- If someone's profile is already good and nothing new has emerged, move on
- Never use gendered pronouns
