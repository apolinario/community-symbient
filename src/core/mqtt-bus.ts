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

  clientFor(moduleName: string): MessageClient {
    if (!this.queues.has(moduleName)) {
      this.queues.set(moduleName, []);
    }

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

      receive: (timeoutMs?: number) => {
        return new Promise<ModuleMessage | null>((resolve) => {
          const queue = this.queues.get(moduleName) || [];
          if (queue.length > 0) {
            resolve(queue.shift()!);
            return;
          }

          // Wait for a message
          let timer: ReturnType<typeof setTimeout> | undefined;

          const waiter = (msg: ModuleMessage) => {
            if (timer) clearTimeout(timer);
            resolve(msg);
          };

          if (!this.waiters.has(moduleName)) {
            this.waiters.set(moduleName, []);
          }
          this.waiters.get(moduleName)!.push(waiter);

          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              const ws = this.waiters.get(moduleName);
              if (ws) {
                const idx = ws.indexOf(waiter);
                if (idx !== -1) ws.splice(idx, 1);
              }
              resolve(null);
            }, timeoutMs);
          }
        });
      },

      pending: () => {
        return (this.queues.get(moduleName) || []).length;
      },
    };
  }

  /**
   * Returns a promise that resolves when ANY message arrives for this module.
   * Used by the orchestrator to interrupt sleep and wake modules instantly.
   * Does NOT consume the message — it stays in the queue for receive().
   */
  waitForMessage(moduleName: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.queues.has(moduleName)) {
        this.queues.set(moduleName, []);
      }
      // If there's already a message waiting, resolve immediately
      const queue = this.queues.get(moduleName)!;
      if (queue.length > 0) {
        resolve();
        return;
      }
      // Otherwise, set up a one-shot notification
      if (!this.waiters.has(moduleName)) {
        this.waiters.set(moduleName, []);
      }
      // We push a special waiter that resolves void and puts the message back
      this.waiters.get(moduleName)!.push((msg) => {
        // Put the message back so receive() can get it
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
