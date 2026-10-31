import { AgentMcpToolNameSchema } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { Value } from "@sinclair/typebox/value";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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

const TOOL_LIST_TTL_MS = 10 * 60_000;
const TOOL_LIST_RETRY_DELAY_MS = 5_000;

type ToolCache = {
  revision: number;
  fetchedAt: number;
  definitions: McpToolDefinition[];
};

type ConnectedServer = {
  id: string;
  signature: string;
  client: Client;
  revision: number;
  cache: ToolCache | null;
  refresh: { revision: number; promise: Promise<void> } | null;
  retryAfter: number;
  closed: boolean;
};

type ToolTarget = {
  server: ConnectedServer;
  toolName: string;
};

type McpManagerOptions = {
  nowMs?: () => number;
  /** A connected client factory; tests never launch real MCP processes or networks. */
  connectClient?: (config: McpServerConfig) => Promise<Client>;
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
  private readonly connected = new Map<string, ConnectedServer>();
  private readonly toolTargets = new Map<string, ToolTarget>();
  // Remember provenance for this Worker lifetime: old model requests can outlive
  // cache invalidation/removal. Once ambiguous, a name must never be reassigned.
  private readonly observedSources = new Map<string, { serverId: string; toolName: string }>();
  private readonly conflictingNames = new Set<string>();
  private settingsSync: Promise<void> = Promise.resolve();
  private readonly nowMs: () => number;

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly logger: Pick<Console, "warn" | "error" | "info">,
    private readonly options: McpManagerOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  private observeSource(name: string, serverId: string, toolName: string) {
    const observed = this.observedSources.get(name);
    if (!observed) {
      this.observedSources.set(name, { serverId, toolName });
    } else if (observed.serverId !== serverId || observed.toolName !== toolName) {
      if (!this.conflictingNames.has(name)) {
        this.logger.warn(`[agent-worker] conflicting mcp tool name; blocked(${name})`);
      }
      this.conflictingNames.add(name);
      this.toolTargets.delete(name);
    }
  }

  private assertUnambiguous(toolName: string) {
    if (this.conflictingNames.has(toolName)) throw new Error(`conflicting mcp tool name: ${toolName}`);
  }

  private clearTargets(entry: ConnectedServer) {
    for (const [name, target] of this.toolTargets) {
      if (target.server === entry) this.toolTargets.delete(name);
    }
  }

  private invalidate(entry: ConnectedServer) {
    entry.revision++;
    entry.cache = null;
    entry.refresh = null;
    entry.retryAfter = 0;
    this.clearTargets(entry);
  }

  private retire(entry: ConnectedServer) {
    entry.closed = true;
    this.invalidate(entry);
    if (this.connected.get(entry.id) === entry) this.connected.delete(entry.id);
  }

  private isCurrent(entry: ConnectedServer) {
    return !entry.closed && this.connected.get(entry.id) === entry;
  }

  private async closeServer(entry: ConnectedServer) {
    this.retire(entry);
    try {
      await entry.client.close();
    } catch {
      // SDK errors can contain URLs, headers or process arguments.
      this.logger.warn(`[agent-worker] close mcp client failed(${entry.id})`);
    }
  }

  private async connectWithTimeout(connect: () => Promise<void>, timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("mcp connect timeout")), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async openClient(config: McpServerConfig): Promise<Client> {
    if (this.options.connectClient) return this.options.connectClient(config);
    const timeout = config.timeout ?? 30_000;
    const client = new Client({ name: "agent-workbench", version: "0.0.0" });
    try {
      if (config.type === "local") {
        const [command, ...args] = config.command;
        if (!command) throw new Error("mcp local command missing");
        const transport = new StdioClientTransport({ command, args, env: toEnvRecord(config.environment) });
        await this.connectWithTimeout(() => client.connect(transport), timeout);
      } else {
        const candidates = [
          new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          }),
          new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          }),
        ];
        let connected = false;
        for (const transport of candidates) {
          try {
            await this.connectWithTimeout(() => client.connect(transport), timeout);
            connected = true;
            break;
          } catch { /* Preserve the existing Streamable HTTP -> SSE fallback. */ }
        }
        if (!connected) throw new Error("mcp connect failed");
      }
      return client;
    } catch {
      await client.close().catch(() => undefined);
      throw new Error("mcp connect failed");
    }
  }

  private async connectServer(serverId: string, config: McpServerConfig) {
    const signature = JSON.stringify(config);
    const existing = this.connected.get(serverId);
    if (existing && existing.signature === signature) return existing;
    if (existing) await this.closeServer(existing);

    const client = await this.openClient(config);
    const entry: ConnectedServer = {
      id: serverId, signature, client, revision: 0, cache: null,
      refresh: null, retryAfter: 0, closed: false,
    };
    // Notifications only invalidate: no unsolicited discovery or automatic refresh.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.invalidate(entry));
    client.onclose = () => this.retire(entry);
    // Request errors (including HTTP 503) can be reported without a disconnect.
    // Only onclose proves the connection is gone; clearing the cache here would
    // erase stale data and turn a failed discovery into an invalidation retry loop.
    client.onerror = () => {};
    this.connected.set(serverId, entry);
    return entry;
  }

  async syncSettings() {
    // Serialize configuration reads and connection changes as one operation. An old
    // fetch/close must never publish over a newer configuration or connection.
    const sync = this.settingsSync.then(async () => {
      const settings = await this.apiClient.getAgentMcpSettings();
      const next = new Map<string, McpServerConfig>();
      for (const server of settings.servers) {
        if (!server.enabled) continue;
        const config = toMcpConfig(server.config);
        if (config) next.set(server.id, config);
      }
      for (const entry of this.connected.values()) {
        if (!next.has(entry.id)) await this.closeServer(entry);
      }
      for (const [serverId, config] of next) {
        try {
          await this.connectServer(serverId, config);
        } catch {
          this.logger.warn(`[agent-worker] connect mcp server failed(${serverId})`);
        }
      }
    });
    this.settingsSync = sync.catch(() => undefined);
    return sync;
  }

  private refreshTools(entry: ConnectedServer): Promise<void> {
    if (entry.refresh?.revision === entry.revision) return entry.refresh.promise;
    const revision = entry.revision;
    const refresh = { revision, promise: Promise.resolve() };
    refresh.promise = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(entry) || entry.revision !== revision) return;
        const response = await entry.client.listTools();
        if (!this.isCurrent(entry) || entry.revision !== revision) return;
        const definitions: McpToolDefinition[] = [];
        const targets = new Map<string, string>();
        for (const tool of response.tools) {
          const name = toMcpToolName(entry.id, tool.name);
          if (!name) continue;
          this.observeSource(name, entry.id, tool.name);
          definitions.push({
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: structuredClone(
              tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
                ? tool.inputSchema as Record<string, unknown> : { type: "object", properties: {} },
            ),
          });
          targets.set(name, tool.name);
        }
        // Publish a new snapshot and routing map together; never mutate an old request.
        this.clearTargets(entry);
        entry.cache = { revision, fetchedAt: this.nowMs(), definitions };
        entry.retryAfter = 0;
        for (const [name, toolName] of targets) {
          if (!this.conflictingNames.has(name)) this.toolTargets.set(name, { server: entry, toolName });
        }
      } catch {
        if (this.isCurrent(entry) && entry.revision === revision && entry.cache) {
          entry.retryAfter = this.nowMs() + TOOL_LIST_RETRY_DELAY_MS;
          this.logger.warn(`[agent-worker] refresh mcp tools failed(${entry.id}); using cached tools`);
        }
        throw new Error("mcp tool discovery failed");
      } finally {
        if (entry.refresh === refresh) entry.refresh = null;
      }
    });
    entry.refresh = refresh;
    return refresh.promise;
  }

  private async getTools(entry: ConnectedServer): Promise<ToolCache> {
    // One invalidated successful result may be followed by one new discovery.
    // A continuously changing server must fail this request, not spin indefinitely.
    for (let attempt = 0; attempt < 2 && this.isCurrent(entry); attempt++) {
      const cache = entry.cache;
      if (cache) {
        if (this.nowMs() - cache.fetchedAt >= TOOL_LIST_TTL_MS && this.nowMs() >= entry.retryAfter) {
          // Stale data has no age limit. One background refresh, no background timer.
          void this.refreshTools(entry).catch(() => undefined);
        }
        return cache;
      }
      await this.refreshTools(entry);
      if (this.isCurrent(entry) && entry.cache) return entry.cache;
    }
    throw new Error("mcp tools changed or became unavailable during discovery");
  }

  async listTools(allowedServerIds: string[]) {
    await this.syncSettings();
    const allowed = new Set(allowedServerIds);
    const definitions: McpToolDefinition[] = [];
    // Snapshot entries: a concurrent settings update must not append new connections
    // to this request's iterator while it is waiting on discovery.
    for (const entry of [...this.connected.values()]) {
      if (!allowed.has(entry.id)) continue;
      const revision = entry.revision;
      try {
        const cache = await this.getTools(entry);
        // Never consume a hard-invalidated snapshot, even if a notification races
        // the promise continuation. No unbounded retry after getTools' two attempts.
        if (this.isCurrent(entry) && entry.revision === cache.revision) {
          definitions.push(...structuredClone(cache.definitions));
        }
      } catch {
        this.logger.warn(`[agent-worker] list mcp tools failed(${entry.id})`);
        if (this.isCurrent(entry) && entry.revision === revision && !entry.cache) {
          await this.closeServer(entry);
        }
      }
    }
    // A later server in this same batch can conflict with an earlier definition.
    return definitions.filter((tool) => !this.conflictingNames.has(tool.name));
  }

  async callTool(toolName: string, args: Record<string, unknown>, options?: {
    signal?: AbortSignal;
    allowedServerIds: readonly string[];
  }) {
    const allowed = new Set(options?.allowedServerIds ?? []);
    if (allowed.size === 0) throw new Error("mcp tool not authorized");
    this.assertUnambiguous(toolName);
    // Keep configuration revocation checks live; cached discovery is not authorization.
    await this.syncSettings();
    this.assertUnambiguous(toolName);
    let entry = this.toolTargets.get(toolName)?.server;
    if (entry && !allowed.has(entry.id)) throw new Error("mcp tool not authorized");
    if (!entry) {
      // Canonical names can have ambiguous sanitized prefixes. Resolve only a
      // unique owning server; never rediscover all servers or guess across them.
      const candidates = [...this.connected.values()].filter((server) =>
        allowed.has(server.id) && toolName.startsWith(`mcp_${sanitizeSegment(server.id)}_`),
      );
      if (candidates.length === 1) entry = candidates[0];
    }
    if (!entry) throw new Error(`unknown mcp tool: ${toolName}`);
    const revision = entry.revision;
    try {
      await this.getTools(entry);
    } catch {
      this.logger.warn(`[agent-worker] list mcp tools failed(${entry.id})`);
      if (this.isCurrent(entry) && entry.revision === revision && !entry.cache) {
        await this.closeServer(entry);
      }
      throw new Error(`unknown mcp tool: ${toolName}`);
    }
    this.assertUnambiguous(toolName);
    const target = this.toolTargets.get(toolName);
    if (!target || target.server !== entry || !allowed.has(entry.id) || !this.isCurrent(entry)) {
      throw new Error(`unknown mcp tool: ${toolName}`);
    }
    // Only metadata discovery is retried/refreshed. Tool execution may have effects.
    const result = await entry.client.callTool({ name: target.toolName, arguments: args });
    return { serverId: entry.id, toolName: target.toolName, text: toMcpTextResult(result), raw: result };
  }
}

export function toMcpToolNameForTest(serverId: string, toolName: string) {
  return toMcpToolName(serverId, toolName);
}
