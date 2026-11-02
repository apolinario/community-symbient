/**
 * Core types for the symbient framework — the contract between the
 * orchestrator, modules, memory, messaging, chat adapters, and the
 * deployment config.
 */

// --- Module System ---

export interface ModuleConfig {
  name: string;
  description?: string;
  /** Cycle interval in ms. If 0, module runs on message trigger only. */
  intervalMs: number;
  /**
   * Optional cron expression (5-field, e.g. "0 12 * * *"). When set, the
   * orchestrator schedules each cycle for the cron's next-fire time instead
   * of waiting `intervalMs`. If the symbient is down at the scheduled time, the
   * tick is missed — no catch-up. Use this for capabilities that need to
   * fire at specific clock times (daily-at-noon, weekdays-at-9am) rather
   * than every-N-minutes. `intervalMs` is still required as a hard upper
   * bound: if the cron parser fails or the next run is more than
   * `intervalMs` ahead, the module falls back to interval cadence.
   */
  cron?: string;
  /** Whether the module starts active or waits for activation. */
  startActive: boolean;
  /** LLM model to use for this module's reasoning. */
  model?: string;
  /**
   * Per-module LLM endpoint override, merged over the deployment's
   * `config.llm` — lets one module escalate to a bigger or hosted model
   * (e.g. magi deliberating on a frontier API while everything else runs
   * local). `model` above is shorthand for `llm: { model }`.
   */
  llm?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
  };
  /** If set, this module runs after the named module completes instead of on a timer. */
  follows?: string;
  /**
   * If true, the module fires its first cycle right at startup instead of
   * waiting `intervalMs`. Default: true for high-frequency modules (≤60s)
   * since they'd run almost immediately anyway, false for slower ones.
   * Set explicitly to opt a slow module into immediate first-run.
   */
  runImmediately?: boolean;
}

export type ModuleFunction = (ctx: ModuleContext) => Promise<void>;

export interface ModuleContext {
  config: ModuleConfig;
  memory: MemoryAccess;
  messages: MessageClient;
  llm: LLMClient;
  /** Pi SDK model for creating Agents with tool calling. */
  model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
  /** Pi Agent tools available to all modules. */
  tools: import("@mariozechner/pi-agent-core").AgentTool[];
  /** API key for LLM provider. */
  apiKey: string;
  /** Default log channel (info level). Surfaces in dashboard SSE + stdout. */
  log: (msg: string) => void;
  /** Verbose channel for full context dumps and prompt bodies. Suppressed
   *  unless LOG_LEVEL=debug. Use for content the operator only wants when
   *  actively debugging — never the default cycle line. */
  logDebug: (msg: string) => void;
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

/**
 * Read + write surface for the symbient's markdown memory. Modules and
 * extensions get this interface via `ModuleContext.memory`. The split
 * between read-only and write-only consumers wasn't load-bearing and
 * added intersection ceremony at the most-imported seam — re-split if a
 * pure read-only consumer ever appears.
 */
export interface MemoryAccess {
  /**
   * Absolute path to the workspace root. Exposed so extensions and helpers
   * can locate files outside the curated read API (e.g. `readdir` on a
   * deployment-specific directory) without falling back to `process.cwd()`.
   */
  readonly workspacePath: string;

  // --- Reads ---
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
  /** Read a person's file (convention: workspace/people/<slug>.md). */
  readPerson(name: string): Promise<string | null>;
  /**
   * Find a person by name. `phone` is consulted only by transports that
   * have one (Signal); for transports without a phone field, leave it
   * undefined and rely on name + the deployment's nickname/alias resolver.
   */
  findPerson(name: string, phone?: string): Promise<{ slug: string; content: string } | null>;
  /** Find a person by a chat identifier (signal-uuid, phone, …) stored in their frontmatter. */
  findPersonById(id: string): Promise<{ slug: string; name: string } | null>;
  /** Assemble generic context: SOUL + MEMORY + optional person profile. */
  assembleContext(personName?: string, phone?: string): Promise<string>;
  /**
   * Conversation variant — augments the base context with relevance-ranked
   * memory chunks for the given message (currently routes through the
   * search backend declared in `services.search`).
   */
  assembleConversationContext(message: string, personName?: string, phone?: string): Promise<string>;

  // --- Writes ---
  /** Append an entry to today's daily log. */
  appendLog(entry: string): Promise<void>;
  /** Write/overwrite a file relative to workspace root. */
  writeFile(relPath: string, content: string): Promise<void>;
  /** Append to a file relative to workspace root. */
  appendFile(relPath: string, content: string): Promise<void>;
}

/** @deprecated alias for `MemoryAccess`. Kept while callers migrate. */
export type MemoryReader = MemoryAccess;
/** @deprecated alias for `MemoryAccess`. Kept while callers migrate. */
export type MemoryWriter = MemoryAccess;

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

// --- Chat messages (transport-agnostic) ---

/**
 * Sender of an inbound chat message. `id` is the transport's stable
 * identifier (Signal UUID, Matrix MXID, Discord snowflake, …). `phone`
 * is populated only by transports that have one — leave undefined
 * elsewhere.
 */
export interface MessageSender {
  id: string;
  name?: string;
  phone?: string;
}

export interface InboundMessage {
  id: string;
  from: MessageSender;
  text: string;
  timestamp: Date;
  chatType: "dm" | "group";
  groupId?: string;
  groupName?: string;
  attachments?: Attachment[];
  mentions?: Mention[];
  /** Sender id of the quoted/replied-to message, if any. */
  quotedAuthorUuid?: string;
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
  /** Sender id of the mentioned participant. */
  uuid: string;
}

export interface OutboundMessage {
  to: string;
  text: string;
  groupId?: string;
  attachments?: string[];
  /** When set, the send becomes a quote-reply to the message identified
   *  by these three fields. Adapters that don't support quoting should
   *  ignore them silently. For Signal: `quoteTimestamp` is the integer
   *  timestamp of the original message (used as Signal's message id).
   *  `quoteAuthorUuid` is the original sender's UUID. `quoteText` is
   *  the original body the recipient client uses to render the quote
   *  preview (Signal won't show the quote preview without it). */
  quoteTimestamp?: string;
  quoteAuthorUuid?: string;
  quoteText?: string;
}

// --- Symbient Config ---

export interface AdapterSelection {
  /** Factory name (references a registered adapter in src/core/adapter-registry.ts). */
  adapter: string;
  /** Params passed to the factory's create() method. */
  params?: Record<string, unknown>;
}

export interface SymbientConfig {
  name: string;
  workspacePath: string;
  /**
   * Workspace-level controls. `writablePaths` extends the default sandbox
   * (MEMORY.md, people/) with deployment-specific writable areas. Entries
   * ending with `/` are directory prefixes; entries without are exact file
   * matches. All paths are relative to the workspace root.
   */
  workspace?: {
    writablePaths?: string[];
  };
  /**
   * Limits applied by the `create_module` self-modification tool. Optional —
   * defaults are 20 modules total, 1 creation per week, and a 5-minute
   * minimum cycle interval.
   */
  moduleManagement?: {
    maxModules?: number;
    creationsPerWeek?: number;
    minIntervalMs?: number;
  };
  /**
   * Scheduling defaults. When a scheduled item has no `target` field of
   * its own, the schedule-checker fires the action at this module name.
   * Omit to fall back to whichever module the deployment registered with
   * `role: "scheduled-action-default"`, then `role: "chat-handler"`.
   */
  scheduling?: {
    defaultTarget?: string;
  };
  mqtt: {
    brokerUrl: string;
    port: number;
  };
  llm: {
    /**
     * Provider identifier. With no `baseUrl`, a provider the Pi SDK knows
     * ("anthropic", "openai", ...) resolves `model` from the SDK registry
     * and speaks that provider's native API. With a `baseUrl` (or an
     * unknown provider/model), the framework speaks OpenAI-completions to
     * it — llama.cpp, LM Studio, Ollama, and vLLM all expose that shape.
     */
    provider: "anthropic" | "openai" | "ollama" | (string & {});
    model: string;
    apiKey?: string;
    /** Env var holding the API key, e.g. "ANTHROPIC_API_KEY". */
    apiKeyEnv?: string;
    baseUrl?: string;
    /** Context window / completion cap for compat endpoints the SDK can't introspect. */
    contextWindow?: number;
    maxTokens?: number;
    /**
     * Optional smaller/faster model for minor tasks (time parsing,
     * temporal rewrites, image descriptions). If omitted, the main
     * `model` is used. Same provider unless `tinyBaseUrl` is set.
     */
    tinyModel?: string;
    tinyBaseUrl?: string;
  };
  /**
   * Arbitrary deployment-specific external services, keyed by name. The
   * framework stores this as-is; deployment tools / extensions read
   * whichever keys they need (e.g. `services.whisper.url` for voice
   * transcription, `services.searxng.url` for web search,
   * `services.tts.url` for radio broadcast, `services.image_gen.url`
   * for image generation, etc.).
   *
   * Framework-recognised keys:
   *   - `services.search.backend` — optional, one of `"qmd-http" | "local-bm25"`.
   *     Defaults to `qmd-http` when `url` is set, `local-bm25` otherwise.
   *   - `services.search.url` — used by the `qmd-http` backend. HTTP endpoint
   *     that accepts the qmd-shaped POST
   *     `/query {searches:[{type:"vec"|"lex",query}], collections, limit}`.
   *   - `services.searxng.url` — optional; enables `web_search` tool.
   *   - `services.whisper.url` — optional; enables voice-message transcription.
   *   - `services.tts.url` — optional; enables voice tools. Any endpoint
   *     speaking the OpenAI `/v1/audio/speech` shape works (local Qwen3-TTS,
   *     hosted OpenAI, a compat proxy). `services.tts.model` overrides the
   *     model name sent (default "qwen3-tts"); `services.tts.apiKeyEnv`
   *     names an env var to send as a Bearer token for hosted endpoints.
   *
   * All other keys are deployment-defined.
   */
  services?: Record<string, { url: string } & Record<string, unknown>>;
  /** Per-module overrides (intervalMs, startActive, etc.). */
  modules: Record<string, Partial<ModuleConfig>>;
  /** Declarative adapter selection. Omit to disable that surface. */
  adapters?: {
    /** Pick a chat transport. Set to null for a headless deployment. */
    chat?: AdapterSelection | null;
    /** Pick a directory (member/booking source). Set to null to skip. */
    directory?: AdapterSelection | null;
  };
  /**
   * Which built-in modules to enable. Omit to enable all built-ins.
   * A minimal deployment without a member directory would list just the
   * framework infrastructure modules (qmd-index, module-sync,
   * schedule-checker, watch-evaluator, conversation).
   */
  enabled_modules?: string[];
  /**
   * External MCP servers to connect at startup. Their tools are auto-
   * discovered and made available to agent modules. Omit for none.
   */
  mcp_servers?: Array<{ name: string; url: string }>;
}
