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

/** Connect to all configured MCP servers and discover their tools. */
export async function initMCP(servers: MCPServerConfig[]): Promise<AgentTool[]> {
  runtime = await createRuntime({
    servers: servers.map((s) => ({
      name: s.name,
      command: { kind: "http" as const, url: new URL(s.url.endsWith("/sse") ? s.url : `${s.url}/sse`) },
    })),
    clientInfo: { name: "feyblet", version: "0.1" },
  });

  const allTools: AgentTool[] = [];

  for (const server of servers) {
    serverNames.add(server.name);
    try {
      const mcpTools = await runtime.listTools(server.name, { includeSchema: true });
      for (const tool of mcpTools) {
        allTools.push(mcpToolToAgentTool(server.name, tool));
      }
      console.log(`MCP [${server.name}]: ${mcpTools.length} tools discovered`);
    } catch (err) {
      console.error(`MCP [${server.name}]: failed to connect — ${err}`);
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
      try {
        if (!runtime) throw new Error("MCP not initialized");
        const result = await runtime.callTool(serverName, tool.name, { args: params });
        const content = (result as any)?.content;
        if (Array.isArray(content)) {
          const text = content.map((c: any) => c.text || "").join("\n");
          return { content: [{ type: "text", text }], details: {} };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `MCP error (${serverName}.${tool.name}): ${err}` }], details: {} };
      }
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
  const result = await runtime.callTool(serverName, toolName, { args });
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
