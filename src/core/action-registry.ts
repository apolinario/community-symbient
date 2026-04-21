/**
 * Action Registry — handlers that fire when a watch matches.
 *
 * Built-in actions dispatch via MQTT nudges to the relevant module
 * (conversation for dm/group, radio for broadcast). Custom actions
 * (webhook, email, etc.) register from `workspace/extensions/actions.js`.
 *
 * Each action receives:
 *   - params: the action's declared fields from watches.json (everything
 *     except `kind`). For `dm`: { to, intent, reasoning? }. For `group`:
 *     { intent, reasoning? }. For `broadcast`: { intent }.
 *   - bus: the MQTT bus, for nudging modules to take follow-up action.
 *   - event: the triggering event, in case the action wants to quote it.
 *   - watchId: which watch fired this — useful for reasoning traces.
 *
 * Actions are fire-and-forget from the evaluator's perspective — they
 * usually translate into "nudge conversation/radio to do X" rather than
 * doing the I/O directly. That keeps the evaluator a tight loop and
 * lets the responsible module phrase the message itself.
 */

import type { MessageClient } from "./types.js";
import type { Event } from "./event-log.js";
import { createLogger } from "./logger.js";

const log = createLogger("actions");

export interface ActionContext {
  params: Record<string, unknown>;
  /** Pre-configured MessageClient the evaluator owns — `from: watch-evaluator`. */
  messages: MessageClient;
  event: Event;
  watchId: string;
}

export type ActionHandler = (ctx: ActionContext) => Promise<void>;

const registry = new Map<string, ActionHandler>();

export function registerAction(kind: string, handler: ActionHandler): void {
  registry.set(kind, handler);
}

export function getAction(kind: string): ActionHandler | undefined {
  return registry.get(kind);
}

export function listActions(): string[] {
  return [...registry.keys()];
}

// --- Built-in actions ---

/**
 * DM a person. Nudges the conversation module with a `send_dm:` payload —
 * conversation then runs as an agent and composes the actual message
 * (using `intent` as the goal), so we don't hardcode wording here.
 */
const dmAction: ActionHandler = async ({ params, messages, watchId }) => {
  const to = params.to;
  const intent = params.intent;
  if (!to || !intent) {
    log.warn(`dm action missing to/intent (watch ${watchId})`);
    return;
  }
  const payload = `send_dm:${JSON.stringify({
    to,
    intent,
    reasoning: params.reasoning ?? `watch ${watchId} fired`,
  })}`;
  await messages.send("conversation", payload);
  log.info(`dm nudge sent (watch ${watchId} → ${to})`);
};

/** Post to the main group. Nudges conversation with `send_group:`. */
const groupAction: ActionHandler = async ({ params, messages, watchId }) => {
  if (!params.intent) {
    log.warn(`group action missing intent (watch ${watchId})`);
    return;
  }
  const payload = `send_group:${JSON.stringify({
    intent: params.intent,
    reasoning: params.reasoning ?? `watch ${watchId} fired`,
  })}`;
  await messages.send("conversation", payload);
  log.info(`group nudge sent (watch ${watchId})`);
};

/**
 * Generic nudge — sends a payload to any module's mailbox. This is the
 * universal "do something" action: the target module's handler/prompt
 * decides what `payload` means. Use this when dm/group don't fit.
 *
 * Example watch action:
 *   { "kind": "nudge", "module": "radio", "payload": "request_broadcast:{\"intent\":\"...\"}" }
 */
const nudgeAction: ActionHandler = async ({ params, messages, watchId }) => {
  const module = params.module;
  const payload = params.payload;
  if (!module || !payload) {
    log.warn(`nudge action missing module/payload (watch ${watchId})`);
    return;
  }
  await messages.send(String(module), String(payload));
  log.info(`nudge sent to ${module} (watch ${watchId})`);
};

registerAction("dm", dmAction);
registerAction("group", groupAction);
registerAction("nudge", nudgeAction);
