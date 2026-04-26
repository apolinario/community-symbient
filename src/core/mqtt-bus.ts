/**
 * MQTT message bus for inter-module communication.
 *
 * Each module gets its own topic: symbient/{agentName}/{moduleName}
 * Messages are point-to-point (sender publishes to receiver's topic).
 * Following CMA's pattern but using the mqtt npm package.
 */

import mqtt from "mqtt";
import type { MessageClient, ModuleMessage } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("mqtt");

export class MQTTBus {
  private client: mqtt.MqttClient | null = null;
  private queues = new Map<string, ModuleMessage[]>();
  private waiters = new Map<string, Array<(msg: ModuleMessage) => void>>();
  private prefix: string;

  constructor(
    private brokerUrl: string,
    private agentName: string,
  ) {
    this.prefix = `symbient/${agentName}`;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: `symbient-${this.agentName}-${Date.now()}`,
        clean: true,
      });

      this.client.on("connect", () => {
        log.info(`Connected to ${this.brokerUrl}`);
        // Subscribe to all module topics under this agent
        this.client!.subscribe(`${this.prefix}/#`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.client.on("message", (topic, payload) => {
        const parts = topic.split("/");
        const targetModule = parts[parts.length - 1];
        let msg: ModuleMessage;
        try {
          msg = JSON.parse(payload.toString());
        } catch {
          return; // silently drop malformed messages
        }
        msg.timestamp = new Date(msg.timestamp);

        const queue = this.queues.get(targetModule);
        if (queue) queue.push(msg);
        else this.queues.set(targetModule, [msg]);

        // Wake up any waiter
        const waiters = this.waiters.get(targetModule);
        if (waiters && waiters.length > 0) {
          const waiter = waiters.shift()!;
          const q = this.queues.get(targetModule)!;
          waiter(q.shift()!);
        }
      });

      this.client.on("error", (err) => {
        log.error(`Error: ${err.message}`);
      });
    });
  }

  /**
   * Ensure the per-module queue + waiter list exist. Both `clientFor`
   * and `waitForMessage` need a queue to push into; calling this once
   * up-front keeps the initialisation in a named place rather than
   * scattered get-or-set logic across the public methods.
   */
  private ensureModuleSlots(moduleName: string): { queue: ModuleMessage[]; waiters: Array<(msg: ModuleMessage) => void> } {
    let queue = this.queues.get(moduleName);
    if (!queue) {
      queue = [];
      this.queues.set(moduleName, queue);
    }
    let waiters = this.waiters.get(moduleName);
    if (!waiters) {
      waiters = [];
      this.waiters.set(moduleName, waiters);
    }
    return { queue, waiters };
  }

  private removeWaiter(moduleName: string, waiter: (msg: ModuleMessage) => void): void {
    const ws = this.waiters.get(moduleName);
    if (!ws) return;
    const idx = ws.indexOf(waiter);
    if (idx !== -1) ws.splice(idx, 1);
  }

  /**
   * Take the next queued message or block until one arrives. Extracted
   * out of the receive() closure so the timer/waiter wiring isn't
   * three-deep inside an arrow.
   */
  private awaitMessage(
    moduleName: string,
    queue: ModuleMessage[],
    waiters: Array<(msg: ModuleMessage) => void>,
    timeoutMs?: number,
  ): Promise<ModuleMessage | null> {
    return new Promise<ModuleMessage | null>((resolve) => {
      if (queue.length > 0) {
        resolve(queue.shift()!);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (msg: ModuleMessage) => {
        if (timer) clearTimeout(timer);
        resolve(msg);
      };
      waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.removeWaiter(moduleName, waiter);
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  clientFor(moduleName: string): MessageClient {
    // Slots are created up-front and never removed for the lifetime of this
    // client — closure can capture the arrays directly.
    const { queue, waiters } = this.ensureModuleSlots(moduleName);

    return {
      send: async (targetModule: string, content: string) => {
        const msg = {
          from: moduleName,
          content,
          timestamp: new Date().toISOString(),
        };
        const topic = `${this.prefix}/${targetModule}`;
        this.client?.publish(topic, JSON.stringify(msg), { qos: 2 });
      },

      receive: (timeoutMs?: number) => this.awaitMessage(moduleName, queue, waiters, timeoutMs),

      pending: () => queue.length,
    };
  }

  /**
   * Returns a promise that resolves when ANY message arrives for this module.
   * Used by the orchestrator to interrupt sleep and wake modules instantly.
   * Does NOT consume the message — it stays in the queue for receive().
   */
  waitForMessage(moduleName: string): Promise<void> {
    const { queue, waiters } = this.ensureModuleSlots(moduleName);
    return new Promise((resolve) => {
      // If a message is already queued, return immediately.
      if (queue.length > 0) {
        resolve();
        return;
      }
      // Otherwise install a one-shot waiter that re-queues the message
      // (so the next `receive()` can consume it) and resolves void.
      waiters.push((msg) => {
        queue.push(msg);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.end(false, () => resolve());
      } else {
        resolve();
      }
    });
  }
}
