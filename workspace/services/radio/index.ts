/**
 * Radio Module — now driven by workspace/modules/radio.md via agent-module.
 *
 * This thin wrapper handles the calendar's scheduled items before
 * handing off to the generic agent module for the main broadcast logic.
 * The radio.md prompt guides the Agent on what to do.
 */

import type { ModuleContext } from "../../../src/core/types.js";
import { completeText } from "../../../src/core/llm.js";

export function createRadioModule() {
  return async function radio(ctx: ModuleContext): Promise<void> {
    // Process any due calendar items
    await processCalendarItems(ctx);

    // The main broadcast logic is handled by the radio agent module
    // loaded from workspace/modules/radio.md via load-modules.ts.
    // This function only handles calendar item processing.
  };
}

async function processCalendarItems(ctx: ModuleContext): Promise<void> {
  const content = await ctx.memory.readFile("radio/calendar.json");
  if (!content) return;

  // Malformed calendar.json shouldn't crash the cycle — radio-calendar
  // is hot-edited by the executive; a half-written save is recoverable
  // on the next save.
  let cal: { upcoming?: Array<{ at: number; done?: boolean; intent?: string }> };
  try {
    cal = JSON.parse(content);
  } catch (err) {
    ctx.log(`processCalendarItems: failed to parse radio/calendar.json: ${(err as Error).message}`);
    return;
  }

  const now = Date.now();
  const due = (cal.upcoming || []).filter((u: any) => u.at <= now && !u.done);
  if (due.length === 0) return;

  const broadcastTool = ctx.tools.find((t: any) => t.name === "radio_broadcast");
  if (!broadcastTool) return;

  // Check if human is on mic — don't interrupt
  const statusTool = ctx.tools.find((t: any) => t.name === "radio_status");
  if (statusTool) {
    try {
      const status = await statusTool.execute("check", {});
      const statusText = status.content.map((c: any) => c.text || "").join("");
      if (statusText.includes('"source":"real"') || statusText.includes("real mic active")) {
        ctx.log("Radio: human on mic, deferring scheduled items");
        return;
      }
    } catch {}
  }

  for (const item of due) {
    let script = item.script;

    if (script === "generate" && item.context) {
      script = await completeText(ctx.model, {
        system: "You are Feyblet hosting FM radio. Write a brief segment.",
        messages: [{ role: "user", content: item.context }],
        temperature: 0.8,
        maxTokens: 200,
        apiKey: ctx.apiKey,
      });
    }

    if (script && script !== "generate") {
      try {
        await broadcastTool.execute("cal", { message: script.trim() });
        // Log to history
        cal.history = cal.history || [];
        cal.history.push({ when: new Date().toISOString(), what: script.trim().slice(0, 100) });
        if (cal.history.length > 50) cal.history = cal.history.slice(-50);
        ctx.log(`Radio: calendar broadcast done`);
      } catch (err) {
        ctx.log(`Radio: calendar broadcast failed: ${err}`);
      }
    }
    item.done = true;
  }

  // Clean up
  cal.upcoming = (cal.upcoming || []).filter((u: any) => !u.done || (now - u.at) < 3600000);
  cal.meta.last_updated = new Date().toISOString();
  await ctx.memory.writeFile("radio/calendar.json", JSON.stringify(cal, null, 2));
}
