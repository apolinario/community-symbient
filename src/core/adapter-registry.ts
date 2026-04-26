/**
 * Adapter Registry — factories for chat, sensor, and directory adapters.
 * Built-in factories (src/adapters/*) self-register at import; deployments
 * add more via workspace/extensions/adapters/*.js (loaded by extension-
 * loader at startup).
 *
 * The deployment config references each adapter by `adapter: <name>`, and
 * src/index.ts instantiates via the factory with the config's params. This
 * is what keeps `src/` free of deployment-specific imports — the framework
 * knows factories by name, not by concrete class.
 */

import type { ChatAdapterFactory } from "../adapters/chat/types.js";
import type { SensorFactory } from "../adapters/sensor/types.js";
import type { DirectoryFactory } from "../adapters/directory/types.js";

const chatFactories = new Map<string, ChatAdapterFactory>();
const sensorFactories = new Map<string, SensorFactory>();
const directoryFactories = new Map<string, DirectoryFactory>();

export function registerChatAdapter(factory: ChatAdapterFactory): void {
  chatFactories.set(factory.name, factory);
}
export function getChatAdapter(name: string): ChatAdapterFactory | undefined {
  return chatFactories.get(name);
}
export function listChatAdapters(): string[] {
  return [...chatFactories.keys()];
}

export function registerSensor(factory: SensorFactory): void {
  sensorFactories.set(factory.name, factory);
}
export function getSensor(name: string): SensorFactory | undefined {
  return sensorFactories.get(name);
}
export function listSensors(): string[] {
  return [...sensorFactories.keys()];
}

export function registerDirectory(factory: DirectoryFactory): void {
  directoryFactories.set(factory.name, factory);
}
export function getDirectory(name: string): DirectoryFactory | undefined {
  return directoryFactories.get(name);
}
export function listDirectories(): string[] {
  return [...directoryFactories.keys()];
}
