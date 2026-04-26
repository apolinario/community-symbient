/**
 * Signal ChatAdapter — connects a symbient to Signal via the
 * bbernhard/signal-cli-rest-api Docker container.
 *
 * - Receives messages via WebSocket at /v1/receive/{number}
 * - Sends messages via POST /v2/send
 * - Typing indicators via PUT /v1/typing-indicator/{number}
 *
 * One built-in implementation of the `ChatAdapter` interface; deployments
 * needing a different transport (Matrix, Discord, CLI, WebUI) drop their
 * own factory under `workspace/extensions/adapters/chat/` and select it
 * via `config.adapters.chat`.
 */

import type {
  InboundMessage,
  OutboundMessage,
  MessageSender,
} from "../../core/types.js";
import type { ChatAdapter, ChatAdapterFactory, ChatMessageHandler } from "./types.js";
import { registerChatAdapter } from "../../core/adapter-registry.js";
import { createLogger } from "../../core/logger.js";
import { recordEvent } from "../../core/event-log.js";
import { sleep } from "../../core/sleep.js";
import WebSocket from "ws";

type MessageHandler = ChatMessageHandler;

const log = createLogger("signal");

/** Signal-specific adapter config — passed via config.adapters.chat.params. */
export interface SignalConfig {
  account: string;
  httpHost: string;
  httpPort: number;
  dmPolicy: "open" | "allowlist";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  groupAllowFrom: string[];
}

export class SignalBridge implements ChatAdapter {
  readonly name = "signal";
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private baseUrl: string;
  private wsUrl: string;
  private reconnecting = false;

  constructor(private config: SignalConfig) {
    this.baseUrl = `http://${config.httpHost}:${config.httpPort}`;
    this.wsUrl = `ws://${config.httpHost}:${config.httpPort}`;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    await this.waitForReady();
    this.connectWebSocket();
    log.info("Bridge started, listening for messages...");
  }

  async stop(): Promise<void> {
    this.reconnecting = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    const body: Record<string, unknown> = {
      message: msg.text,
      number: this.config.account,
    };

    if (msg.groupId) {
      // v0.98+: group ID goes in recipients with "group." prefix
      // The groupId from the envelope is the internal base64 ID;
      // the REST API expects it base64-encoded again with "group." prefix
      const b64GroupId = Buffer.from(msg.groupId).toString("base64");
      body.recipients = [`group.${b64GroupId}`];
    } else {
      body.recipients = [msg.to];
    }

    if (msg.attachments?.length) {
      body.base64_attachments = msg.attachments;
    }

    const res = await fetch(`${this.baseUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Signal send error ${res.status}: ${text}`);
    }
  }

  /** signal-cli-rest-api serves binaries at `${baseUrl}/v1/attachments/{id}`. */
  getAttachmentBaseUrl(): string {
    return this.baseUrl;
  }

  async sendTyping(to: string, groupId?: string): Promise<void> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/typing-indicator/${encodeURIComponent(this.config.account)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            groupId ? { recipient: to, group_id: groupId } : { recipient: to },
          ),
        },
      );
      if (!res.ok) {
        // Typing indicators are best-effort, don't throw
        log.warn(`Typing indicator failed: ${res.status}`);
      }
    } catch {
      // Best-effort
    }
  }

  // --- Health Check ---

  private async waitForReady(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/about`);
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await sleep(1000);
    }
    throw new Error("signal-cli-rest-api did not become ready");
  }

  // --- WebSocket Message Loop ---

  private connectWebSocket(): void {
    this.reconnecting = true;
    this.wsConnect();
  }

  private wsConnect(backoff = 1000): void {
    if (!this.reconnecting) return;

    const url = `${this.wsUrl}/v1/receive/${encodeURIComponent(this.config.account)}`;
    log.info(`Connecting WebSocket: ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;
    let alive = true;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    ws.onopen = () => {
      log.info("WebSocket connected");
      backoff = 1000;
      alive = true;

      // Keepalive: ping every 30s, kill if no pong
      pingInterval = setInterval(() => {
        if (!alive) {
          log.warn("WebSocket stale (no pong), reconnecting...");
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 30000);
    };

    ws.on("pong", () => {
      alive = true;
    });

    ws.onmessage = async (event) => {
      alive = true;
      try {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        log.info(`WS raw: ${raw.slice(0, 1500)}`);
        const data = JSON.parse(raw);
        const dm = data?.envelope?.dataMessage;
        if (dm) {
          log.info(`Parsed: msg="${dm.message}" mentions=${JSON.stringify(dm.mentions)} group=${!!dm.groupInfo}`);
        }
        await this.handleEnvelope(data);
      } catch (err) {
        log.error(`Failed to parse WS message: ${err}`);
      }
    };

    ws.onclose = () => {
      if (pingInterval) clearInterval(pingInterval);
      if (!this.reconnecting) return;
      log.warn(`WebSocket closed, reconnecting in ${backoff}ms...`);
      setTimeout(() => this.wsConnect(Math.min(backoff * 2, 30000)), backoff);
    };

    ws.onerror = (err) => {
      log.error(`WebSocket error: ${err}`);
      ws.close();
    };
  }

  private async handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    const dataMsg = envelope.envelope?.dataMessage;
    log.info(`handleEnvelope: has dataMsg=${!!dataMsg}, message=${!!dataMsg?.message}, attachments=${!!dataMsg?.attachments?.length}`);
    if (!dataMsg?.message && !dataMsg?.attachments?.length) return;

    const source = envelope.envelope;
    const sender: MessageSender = {
      id: source.sourceUuid || source.sourceNumber || "unknown",
      name: source.sourceName,
      phone: source.sourceNumber,
    };

    // Access control
    if (dataMsg.groupInfo) {
      if (this.config.groupPolicy === "disabled") return;
      if (this.config.groupPolicy === "allowlist" &&
          !this.config.groupAllowFrom.includes(dataMsg.groupInfo.groupId)) return;
    } else {
      if (this.config.dmPolicy === "allowlist" &&
          !this.config.allowFrom.includes(sender.id) &&
          !this.config.allowFrom.includes(sender.phone || "")) return;
    }

    log.info(`Passed access control, dispatching to ${this.handlers.length} handler(s)`);

    // Include quoted text for context if this is a reply
    let text = dataMsg.message || "";
    if (dataMsg.quote?.text) {
      text = `[replying to: "${dataMsg.quote.text}"] ${text}`;
    }

    const msg: InboundMessage = {
      id: `${source.timestamp}`,
      from: sender,
      text,
      timestamp: new Date(source.timestamp),
      chatType: dataMsg.groupInfo ? "group" : "dm",
      groupId: dataMsg.groupInfo?.groupId,
      groupName: dataMsg.groupInfo?.groupName,
      mentions: dataMsg.mentions,
      quotedAuthorUuid: dataMsg.quote?.authorUuid,
      attachments: dataMsg.attachments?.map((a: SignalAttachment) => ({
        id: a.id,
        contentType: a.contentType,
        filename: a.filename,
        size: a.size || 0,
      })),
    };

    recordEvent({
      type: "chat_message",
      direction: "in",
      chat: msg.chatType,
      from: sender.name || sender.id,
      fromId: sender.id,
      text,
      groupId: msg.groupId,
      groupName: msg.groupName,
      hasAttachments: (msg.attachments?.length ?? 0) > 0,
    });

    for (const handler of this.handlers) {
      try {
        await handler(msg);
      } catch (err) {
        log.error(`Handler error: ${err}`);
      }
    }
  }
}

// Self-register as the built-in "signal" chat adapter factory. Selected
// by config.adapters.chat = { adapter: "signal", params: {...} }.
export const signalChatAdapterFactory: ChatAdapterFactory = {
  name: "signal",
  create: (params) => new SignalBridge(params as unknown as SignalConfig),
};
registerChatAdapter(signalChatAdapterFactory);

// --- Signal Envelope Types ---

interface SignalEnvelope {
  envelope: {
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    timestamp: number;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId: string; groupName?: string };
      attachments?: SignalAttachment[];
      mentions?: Array<{ start: number; length: number; uuid: string }>;
    };
  };
}

interface SignalAttachment {
  id: string;
  contentType: string;
  filename?: string;
  size?: number;
}
