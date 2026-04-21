/**
 * ChatAdapter — pluggable chat transport.
 *
 * The framework talks to "the outside world of conversation" through this
 * interface, not through any specific vendor's client. Built-in adapters
 * (Signal) live in this folder; deployments can add their own in
 * `workspace/extensions/adapters/*.js` (Matrix, Discord, Slack, CLI,
 * WebUI, etc.) and select one via `workspace/config.yaml`.
 *
 * Required methods: start, send, onMessage.
 * Optional: sendTyping (adapters without typing indicators just leave it
 * undefined — conversation.ts checks).
 *
 * Inbound and outbound message shapes are the framework's `InboundMessage`
 * and `OutboundMessage` — adapters translate to/from their protocol.
 */

import type { InboundMessage, OutboundMessage } from "../../core/types.js";

export type ChatMessageHandler = (msg: InboundMessage) => Promise<void> | void;

export interface ChatAdapter {
  /** Adapter identity — shown in logs and referenced from config.yaml. */
  readonly name: string;

  /** Connect and start receiving messages. Resolves once the transport is live. */
  start(): Promise<void>;

  /** Cleanly disconnect. Optional — most adapters can omit unless they hold resources. */
  stop?(): Promise<void>;

  /** Send a message (DM or group). `groupId` present = group; otherwise DM to `to`. */
  send(msg: OutboundMessage): Promise<void>;

  /** Register a handler for incoming messages. Called multiple times supported. */
  onMessage(handler: ChatMessageHandler): void;

  /** Optional: show a "typing" indicator. No-op if unsupported. */
  sendTyping?(to: string, groupId?: string): Promise<void>;
}

/**
 * Factory signature for adapters. A workspace extension exports one of these
 * per adapter name; config.yaml references it by `adapter: <name>` and the
 * framework calls the factory with config-provided params at startup.
 */
export interface ChatAdapterFactory {
  name: string;
  create(params: Record<string, unknown>): ChatAdapter;
}
