/**
 * OutputChannel — pluggable broadcast/announce destination.
 *
 * For Feÿ this is the FM radio (via the Radio MCP server). Other
 * deployments might have:
 *   - Discord voice channel TTS
 *   - Web speaker (playing audio in a browser tab)
 *   - A PA system via another MCP server
 *   - Nothing at all (text-only deployments skip this whole layer)
 *
 * Channels are declared in config.yaml; deployments can add custom ones
 * in workspace/extensions/adapters/*.js. The `radio_broadcast` tool
 * dispatches via a registered OutputChannel rather than calling Radio MCP
 * directly, so a deployment that wants a Discord voice broadcast instead
 * of FM radio just swaps the adapter.
 */

export interface BroadcastRequest {
  message: string;
  /** Optional voice/persona hint. Channel-specific interpretation. */
  voice?: string;
  /** Any extra metadata the channel can use (priority, delay, etc.). */
  metadata?: Record<string, unknown>;
}

export interface OutputChannel {
  readonly name: string;

  /** Send a broadcast message. Returns a short human status for the tool result. */
  broadcast(req: BroadcastRequest): Promise<{ ok: boolean; status: string }>;
}

export interface OutputChannelFactory {
  name: string;
  create(params: Record<string, unknown>): OutputChannel | Promise<OutputChannel>;
}
