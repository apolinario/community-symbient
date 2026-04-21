/**
 * Core types for Feyblet's concurrent modular architecture.
 * Inspired by CMA (Concurrent Modular Agent) paper, adapted for
 * a community symbient running on Pi SDK with Markdown-based memory.
 */

// --- Module System ---

export interface ModuleConfig {
  name: string;
  description?: string;
  /** Cycle interval in ms. If 0, module runs on message trigger only. */
  intervalMs: number;
  /** Whether the module starts active or waits for activation. */
  startActive: boolean;
  /** LLM model to use for this module's reasoning. */
  model?: string;
  /** If set, this module runs after the named module completes instead of on a timer. */
  follows?: string;
}

export type ModuleFunction = (ctx: ModuleContext) => Promise<void>;

export interface ModuleContext {
  config: ModuleConfig;
  memory: MemoryReader & MemoryWriter;
  messages: MessageClient;
  llm: LLMClient;
  /** Pi SDK model for creating Agents with tool calling */
  model: any;
  /** Pi Agent tools available to all modules */
  tools: any[];
  /** API key for LLM provider */
  apiKey: string;
  log: (msg: string) => void;
  signal: AbortSignal;
}

export interface ModuleHandle {
  config: ModuleConfig;
  active: boolean;
  lastRun?: Date;
  activate: () => void;
  deactivate: () => void;
}

// --- Memory ---

export interface MemoryReader {
  /** Read a file relative to the workspace root. */
  readFile(relPath: string): Promise<string | null>;
  /** Read today's daily log. */
  readTodayLog(): Promise<string | null>;
  /** Read yesterday's daily log. */
  readYesterdayLog(): Promise<string | null>;
  /** Read SOUL.md. */
  readSoul(): Promise<string | null>;
  /** Read MEMORY.md (curated long-term knowledge). */
  readMemory(): Promise<string | null>;
  /** Read a person's file. */
  readPerson(name: string): Promise<string | null>;
  /** Find a person by name/phone with fuzzy matching. */
  findPerson(name: string, phone?: string): Promise<{ slug: string; content: string } | null>;
  /** Read a skill's full content by name. */
  readSkill(name: string): Promise<string | null>;
  /** Search memory (when search backend is available). */
  search?(query: string, maxResults?: number): Promise<SearchResult[]>;
  /** Assemble full context for an LLM call (SOUL + MEMORY + logs + person + bookings + skill descriptions). */
  assembleContext(personName?: string, senderPhone?: string): Promise<string>;
  /** Assemble context for conversation using qmd search for relevant memory. */
  assembleConversationContext(message: string, personName?: string, senderPhone?: string): Promise<string>;
}

export interface MemoryWriter {
  /** Append an entry to today's daily log. */
  appendLog(entry: string): Promise<void>;
  /** Write/overwrite a file relative to workspace root. */
  writeFile(relPath: string, content: string): Promise<void>;
  /** Append to a file relative to workspace root. */
  appendFile(relPath: string, content: string): Promise<void>;
}

export interface SearchResult {
  text: string;
  path: string;
  score: number;
  lines?: [number, number];
}

// --- Messaging (MQTT-based inter-module communication) ---

export interface MessageClient {
  /** Send a message to another module. */
  send(targetModule: string, content: string): Promise<void>;
  /** Receive the next message (blocks until available or timeout). */
  receive(timeoutMs?: number): Promise<ModuleMessage | null>;
  /** Check how many messages are queued. */
  pending(): number;
}

export interface ModuleMessage {
  from: string;
  content: string;
  timestamp: Date;
}

// --- LLM ---

/** Simple text completion interface for modules that don't need tools */
export interface LLMClient {
  complete(opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

// --- Signal Bridge ---

export interface SignalConfig {
  account: string;
  httpHost: string;
  httpPort: number;
  dmPolicy: "open" | "allowlist";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  groupAllowFrom: string[];
}

export interface InboundMessage {
  id: string;
  from: SignalSender;
  text: string;
  timestamp: Date;
  chatType: "dm" | "group";
  groupId?: string;
  groupName?: string;
  attachments?: Attachment[];
  mentions?: Mention[];
  quotedAuthorUuid?: string;
}

export interface SignalSender {
  id: string;
  name?: string;
  phone?: string;
}

export interface Attachment {
  id: string;
  contentType: string;
  filename?: string;
  size: number;
  localPath?: string;
}

export interface Mention {
  start: number;
  length: number;
  uuid: string;
}

export interface OutboundMessage {
  to: string;
  text: string;
  groupId?: string;
  attachments?: string[];
}

// --- Feyblet Config ---

export interface FeybletConfig {
  name: string;
  workspacePath: string;
  signal: SignalConfig;
  mqtt: {
    brokerUrl: string;
    port: number;
  };
  llm: {
    provider: "anthropic" | "openai" | "ollama";
    model: string;
    tinyModel?: string;
    tinyBaseUrl?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  modules: Record<string, Partial<ModuleConfig>>;
}
