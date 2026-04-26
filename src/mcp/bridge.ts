/**
 * MCP Bridge — connects to MCP servers via mcporter and exposes their
 * tools as Pi AgentTools. Auto-discovers all tools from each server.
 *
 * Module configs can reference MCP tools as:
 *   "radio"           → all tools from the "radio" MCP server
 *   "radio.get_status" → just that one tool
 *   "search_memory"   → local tool (not an MCP reference)
 */

import { createRuntime, type Runtime, type ServerToolInfo } from "mcporter";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export interface MCPServerConfig {
  name: string;
  url: string;
}

let runtime: Runtime | null = null;
const serverNames = new Set<string>();
let _servers: MCPServerConfig[] = [];
let _onReconnect: ((tools: AgentTool[]) => void) | null = null;

/** Set a callback that fires when MCP reconnects with fresh tools. */
export function onMCPReconnect(cb: (tools: AgentTool[]) => void) {
  _onReconnect = cb;
}

/** Reconnect to all MCP servers — closes existing connections, re-discovers tools. */
export async function reconnectMCP(): Promise<AgentTool[]> {
  console.log("[mcp] Reconnecting...");
  await closeMCP();
  const tools = await initMCP(_servers);
  if (_onReconnect) _onReconnect(tools);
  return tools;
}

/** Connect to all configured MCP servers and discover their tools. */
export async function initMCP(servers: MCPServerConfig[]): Promise<AgentTool[]> {
  _servers = servers;
  runtime = await createRuntime({
    servers: servers.map((s) => ({
      name: s.name,
      command: { kind: "http" as const, url: new URL(s.url) },
    })),
    clientInfo: { name: "symbient", version: "0.1" },
  });

  const allTools: AgentTool[] = [];

  for (const server of servers) {
    serverNames.add(server.name);
    // Retry up to 3 times with 5s delay for remote servers that may be slow to start
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const mcpTools = await runtime.listTools(server.name, { includeSchema: true });
        for (const tool of mcpTools) {
          allTools.push(mcpToolToAgentTool(server.name, tool));
        }
        console.log(`MCP [${server.name}]: ${mcpTools.length} tools discovered`);
        break;
      } catch (err) {
        if (attempt < 2) {
          console.log(`MCP [${server.name}]: attempt ${attempt + 1} failed, retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          console.error(`MCP [${server.name}]: failed to connect after 3 attempts — ${err}`);
        }
      }
    }
  }

  return allTools;
}

/** Check if a name refers to an MCP server (for tool filtering). */
export function isMCPServer(name: string): boolean {
  return serverNames.has(name);
}

/** Convert an MCP tool into a Pi AgentTool. Named as "server.toolname". */
function mcpToolToAgentTool(serverName: string, tool: ServerToolInfo): AgentTool {
  const qualifiedName = `${serverName}.${tool.name}`;

  // Convert MCP JSON Schema to TypeBox parameters
  const schema = tool.inputSchema as any;
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);

  const typeboxProps: Record<string, any> = {};
  for (const [key, prop] of Object.entries(properties) as [string, any][]) {
    let tbType = jsonSchemaToTypebox(prop);
    if (!required.has(key)) {
      tbType = Type.Optional(tbType);
    }
    typeboxProps[key] = tbType;
  }

  const parameters = Type.Object(typeboxProps);

  return {
    name: qualifiedName,
    description: tool.description || tool.name,
    label: tool.name,
    parameters,
    execute: async (_id, params) => {
      // Try once; on failure, attempt to reconnect and retry once. The
      // outer `for` shape is intentional — we want exactly two attempts
      // with a reconnect between them.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!runtime) throw new Error("MCP not initialized");
          const argsRecord = params as Record<string, unknown> | undefined;
          const args = argsRecord && Object.keys(argsRecord).length > 0 ? argsRecord : undefined;
          const result = await runtime.callTool(serverName, tool.name, { args });
          const content = (result as { content?: Array<{ text?: string }> })?.content;
          if (Array.isArray(content)) {
            const text = content.map((c) => c.text || "").join("\n");
            return { content: [{ type: "text", text }], details: {} };
          }
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          if (attempt === 0) {
            console.log(`[mcp] ${serverName}.${tool.name} failed, reconnecting...`);
            try {
              await reconnectMCP();
            } catch (reconnectErr) {
              console.error(`[mcp] reconnect failed: ${(reconnectErr as Error).message}`);
            }
            continue;
          }
          // Surface the failure to the agent: the AgentTool result shape
          // supports `isError`, which the agent can reason about instead
          // of treating the error message as a successful response.
          return {
            content: [{ type: "text", text: `MCP error (${serverName}.${tool.name}): ${(err as Error).message}` }],
            details: {},
            isError: true,
          };
        }
      }
      return {
        content: [{ type: "text", text: `MCP error: ${serverName}.${tool.name} unreachable after retry` }],
        details: {},
        isError: true,
      };
    },
  };
}

/** Best-effort JSON Schema → TypeBox conversion for MCP tool parameters. */
function jsonSchemaToTypebox(prop: any): any {
  const desc = prop.description ? { description: prop.description } : {};

  switch (prop.type) {
    case "string":
      if (prop.enum) return Type.Union(prop.enum.map((v: string) => Type.Literal(v)), desc);
      return Type.String(desc);
    case "number":
    case "integer":
      return Type.Number(desc);
    case "boolean":
      return Type.Boolean(desc);
    case "array":
      return Type.Array(prop.items ? jsonSchemaToTypebox(prop.items) : Type.Any(), desc);
    case "object":
      return Type.Any(desc);
    default:
      return Type.Any(desc);
  }
}

/** Direct call to an MCP tool — for local tools that need to invoke MCP internally. */
export async function callMCPTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
  if (!runtime) throw new Error("MCP not initialized");
  const cleanArgs = Object.keys(args).length > 0 ? args : undefined;
  const result = await runtime.callTool(serverName, toolName, { args: cleanArgs });
  const content = (result as any)?.content;
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || "").join("\n");
  }
  return JSON.stringify(result);
}

export async function closeMCP(): Promise<void> {
  if (runtime) {
    await runtime.close().catch(() => {});
    runtime = null;
  }
}
