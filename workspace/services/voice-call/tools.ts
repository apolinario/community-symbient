/**
 * Voice-call operator tools — `start_call_line` opens the phone-in line
 * for a fixed window, `end_call_line` closes it manually.
 *
 * The actual voice-call WebSocket server runs as a separate Python
 * process (workspace/services/voice-call/server.py). These tools don't
 * spawn or kill the server — they just emit events. The radio-calls
 * module sees them in `<events-recent>` on its next 30s cycle and
 * reacts (announce, broadcast wrap-ups, etc.).
 *
 * Trust gate: the operator (typically Apolinário) shares the URL+key
 * verbally on-air; anyone with the key can connect. Single concurrent
 * call enforced server-side.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { recordEvent } from "../../../src/core/event-log.js";

export function createStartCallLineTool(): AgentTool {
  return {
    name: "start_call_line",
    description:
      "Open the radio call-in line for a fixed window. Anyone who has the URL + access key can call in during this window — their voice and your responses both air on FM. Use only when an operator (typically Apolinário) explicitly requests it. The url + key are shared verbally on the radio, not via this tool.",
    label: "Start Call Line",
    parameters: Type.Object({
      duration_minutes: Type.Number({
        description: "How long the line stays open in minutes. Typical: 5–15. Hard cap 60.",
        minimum: 1,
        maximum: 60,
      }),
      reason: Type.Optional(Type.String({
        description: "Optional context — what prompted opening the line, what the segment is about.",
      })),
    }),
    execute: async (_id, params) => {
      const duration = Math.min(60, Math.max(1, params.duration_minutes));
      const closeAt = Date.now() + duration * 60_000;
      recordEvent({
        type: "call_line_opened",
        duration_minutes: duration,
        close_at: closeAt,
        reason: params.reason ?? null,
      });
      return {
        content: [{
          type: "text",
          text: `Call line opening for ${duration} minutes. The radio-calls module will broadcast the announcement on its next cycle (within 30s).`,
        }],
        details: { duration_minutes: duration, close_at: closeAt },
      };
    },
  };
}

export function createEndCallLineTool(): AgentTool {
  return {
    name: "end_call_line",
    description:
      "Close the radio call-in line immediately. Use to wrap up early or if a call is going off the rails. An in-progress call is allowed to finish; new connections refused.",
    label: "End Call Line",
    parameters: Type.Object({}),
    execute: async () => {
      recordEvent({ type: "call_line_closed", manual: true });
      return { content: [{ type: "text", text: "Call line closing. The radio-calls module will broadcast the wrap-up on its next cycle." }], details: {} };
    },
  };
}
