/**
 * Sauna tool — parses the daily log for recent `*[Sauna]*` entries
 * and returns the latest temperature + trend.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../../../src/memory/manager.js";

export function createCheckSaunaTool(memory: MemoryManager): AgentTool {
  return {
    name: "check_sauna",
    description: "Check the current sauna temperature — returns the latest reading and whether it's heating up or cooling down",
    label: "Check Sauna",
    parameters: Type.Object({}),
    execute: async () => {
      const log = await memory.readTodayLog();
      if (!log) return { content: [{ type: "text", text: "No sauna data today." }], details: {} };

      const readings = log.match(/\*\[Sauna\]\*.*?(\d+\.?\d*)°C.*$/gm);
      if (!readings || readings.length === 0) {
        return { content: [{ type: "text", text: "No sauna readings today." }], details: {} };
      }

      const latest = readings[readings.length - 1];
      const temp = parseFloat(latest.match(/(\d+\.?\d*)°C/)?.[1] || "0");

      let trend = "";
      if (readings.length >= 2) {
        const prev = parseFloat(readings[readings.length - 2].match(/(\d+\.?\d*)°C/)?.[1] || "0");
        if (temp > prev + 2) trend = ", heating up";
        else if (temp < prev - 2) trend = ", cooling down";
        else trend = ", holding steady";
      }

      let status: string;
      if (temp > 70) status = "hot — ready to use";
      else if (temp > 40) status = "warming up";
      else status = "cold";

      return {
        content: [{ type: "text", text: `Sauna: ${temp}°C (${status}${trend}). ${readings.length} readings today.` }],
        details: {},
      };
    },
  };
}
