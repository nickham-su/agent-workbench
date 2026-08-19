import { AgentMcpToolNameSchema } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentApiClient } from "./apiClient.js";

type LocalConfig = {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  timeout?: number;
};

type RemoteConfig = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
};

type McpServerConfig = LocalConfig | RemoteConfig;

type ConnectedServer = {
  id: string;
  config: McpServerConfig;
  signature: string;
  client: Client;
};

type ToolTarget = {
  serverId: string;
  toolName: string;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

function sanitizeSegment(raw: string) {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toMcpToolName(serverId: string, toolName: string) {
  const name = `mcp_${sanitizeSegment(serverId)}_${sanitizeSegment(toolName)}`;
  return Value.Check(AgentMcpToolNameSchema, name) ? name : null;
}

function normalizeContentItem(item: unknown) {
  const obj = item as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "text") {
    return typeof obj.text === "string" ? obj.text : "";
  }
  if (type === "resource") {
    const resource = (obj.resource ?? null) as Record<string, unknown> | null;
    if (resource && typeof resource.text === "string") {
      return resource.text;
    }
  }
  if (type) return `[${type}]`;
  return "";
}

function toMcpTextResult(result: unknown) {
  const obj = result as Record<string, unknown>;
  const rawItems = Array.isArray(obj.content) ? obj.content : [];
  const text = rawItems
    .map((item) => normalizeContentItem(item))
    .filter((item) => item.length > 0)
    .join("\n\n");
  return text || JSON.stringify(result);
}

function toMcpConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  const timeout = Number.isFinite(Number(obj.timeout)) ? Math.max(1, Math.floor(Number(obj.timeout))) : undefined;
  if (type === "local") {
    const command = Array.isArray(obj.command)
      ? obj.command.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0)
      : [];
    if (command.length === 0) return null;
    const environment =
      obj.environment && typeof obj.environment === "object" && !Array.isArray(obj.environment)
        ? (obj.environment as Record<string, string>)
        : undefined;
    return {
      type: "local",
      command,
      ...(environment ? { environment } : {}),
      ...(timeout ? { timeout } : {})
    };
  }
  if (type === "remote") {
    const url = typeof obj.url === "string" ? obj.url.trim() : "";
    if (!url) return null;
    const headers =
      obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)
        ? (obj.headers as Record<string, string>)
        : undefined;
    return {
      type: "remote",
      url,
      ...(headers ? { headers } : {}),
      ...(timeout ? { timeout } : {})
    };
  }
  return null;
}

function toEnvRecord(extra: Record<string, string> | undefined) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  if (!extra) return out;
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value;
  }
  return out;
}

export class McpManager {
  private loadedAt = 0;
  private readonly connected = new Map<string, ConnectedServer>();
  private readonly toolTargets = new Map<string, ToolTarget>();

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly logger: Pick<Console, "warn" | "error" | "info">
  ) {}

  private async fetchSettings() {
    const payload = await this.apiClient.getAgentMcpSettings();
    return payload;
  }

  private async closeServer(serverId: string) {
    const current = this.connected.get(serverId);
    if (!current) return;
    this.connected.delete(serverId);
    try {
      await current.client.close();
    } catch (err) {
      this.logger.warn(`[agent-worker] close mcp client failed(${serverId}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async connectServer(serverId: string, config: McpServerConfig) {
    const signature = JSON.stringify(config);
    const existing = this.connected.get(serverId);
    if (existing && existing.signature === signature) {
      return existing;
    }
    if (existing) {
      await this.closeServer(serverId);
    }

    const timeout = config.timeout ?? 30_000;
    const client = new Client({ name: "agent-workbench", version: "0.0.0" });

    if (config.type === "local") {
      const [command, ...args] = config.command;
      if (!command) throw new Error(`mcp local command missing: ${serverId}`);
      const transport = new StdioClientTransport({
        command,
        args,
        env: toEnvRecord(config.environment)
      });
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`mcp connect timeout: ${serverId}`)), timeout))
      ]);
    } else {
      const candidates = [
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined
        }),
        new SSEClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined
        })
      ];
      let lastError: unknown = null;
      for (const transport of candidates) {
        try {
          await Promise.race([
            client.connect(transport),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`mcp connect timeout: ${serverId}`)), timeout))
          ]);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
    }

    const connected: ConnectedServer = {
      id: serverId,
      config,
      signature,
      client
    };
    this.connected.set(serverId, connected);
    return connected;
  }

  async syncSettings() {
    const settings = await this.fetchSettings();

    const next = new Map<string, McpServerConfig>();
    for (const server of settings.servers) {
      if (!server.enabled) continue;
      const config = toMcpConfig(server.config);
      if (!config) continue;
      next.set(server.id, config);
    }

    for (const serverId of this.connected.keys()) {
      if (next.has(serverId)) continue;
      await this.closeServer(serverId);
    }

    for (const [serverId, config] of next.entries()) {
      try {
        await this.connectServer(serverId, config);
      } catch (err) {
        this.logger.warn(
          `[agent-worker] connect mcp server failed(${serverId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this.loadedAt = settings.updatedAt;
  }

  async listTools(allowedServerIds: string[]) {
    await this.syncSettings();
    const allowed = new Set(allowedServerIds);
    const definitions: McpToolDefinition[] = [];

    for (const [serverId, entry] of this.connected.entries()) {
      if (!allowed.has(serverId)) continue;
      try {
        const response = await entry.client.listTools();
        for (const tool of response.tools) {
          const name = toMcpToolName(serverId, tool.name);
          if (!name) continue;
          this.toolTargets.set(name, {
            serverId,
            toolName: tool.name
          });
          definitions.push({
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema:
              tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
                ? (tool.inputSchema as Record<string, unknown>)
                : { type: "object", properties: {} }
          });
        }
      } catch (err) {
        this.logger.warn(
          `[agent-worker] list mcp tools failed(${serverId}): ${err instanceof Error ? err.message : String(err)}`
        );
        await this.closeServer(serverId);
      }
    }

    return definitions;
  }

  async callTool(toolName: string, args: Record<string, unknown>, _options?: {
    signal?: AbortSignal;
  }) {
    // TODO(plugin-phase2): 当前 MCP SDK client.callTool 未见显式 AbortSignal 接口；先保留参数与注释，
    // 使执行链路具备取消协作扩展点，待上游 SDK 或本地封装支持后继续透传。
    let target = this.toolTargets.get(toolName);
    if (!target) {
      await this.syncSettings();
      for (const [serverId, entry] of this.connected.entries()) {
        try {
          const response = await entry.client.listTools();
          for (const tool of response.tools) {
            const name = toMcpToolName(serverId, tool.name);
            if (!name) continue;
            this.toolTargets.set(name, {
              serverId,
              toolName: tool.name
            });
          }
        } catch (err) {
          this.logger.warn(
            `[agent-worker] list mcp tools failed(${serverId}): ${err instanceof Error ? err.message : String(err)}`
          );
          await this.closeServer(serverId);
        }
      }
      target = this.toolTargets.get(toolName);
    }
    if (!target) {
      throw new Error(`unknown mcp tool: ${toolName}`);
    }
    const server = this.connected.get(target.serverId);
    if (!server) {
      throw new Error(`mcp server unavailable: ${target.serverId}`);
    }
    const result = await server.client.callTool({
      name: target.toolName,
      arguments: args
    });
    return {
      serverId: target.serverId,
      toolName: target.toolName,
      text: toMcpTextResult(result),
      raw: result
    };
  }
}

export function toMcpToolNameForTest(serverId: string, toolName: string) {
  return toMcpToolName(serverId, toolName);
}
