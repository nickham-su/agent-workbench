import type {
  AgentToolName,
  AgentUiLocale,
  PluginRuntimeSnapshotsResponse,
  PluginToolCanonicalName,
  PluginToolRpcExecuteRequest,
  PluginToolRpcExecuteResponse,
  PluginToolRpcListRequest,
  PluginToolRpcListResponse
} from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  AgentApiEndpoints,
  type AgentApiCreateContextItemResponse,
  AgentApiCreateContextItemResponseSchema,
  type AgentApiUpdateContextItemResponse,
  AgentApiUpdateContextItemResponseSchema,
  type AgentApiCompactContextRequest,
  type AgentApiCompactContextResponse,
  AgentApiCompactContextResponseSchema,
  AgentApiSubtaskPreforkPlanRequest,
  AgentApiSubtaskPreforkPlanResponse,
  AgentApiSubtaskPreforkPlanResponseSchema,
  AgentApiSubtaskStartRequest,
  AgentApiSubtaskStartResponse,
  AgentApiSubtaskStartResponseSchema,
  AgentApiSubtaskResultRequest,
  AgentApiSubtaskResultResponse,
  AgentApiSubtaskResultResponseSchema,
  AgentApiSubtaskStatusRequest,
  AgentApiSubtaskStatusResponse,
  AgentApiSubtaskStatusResponseSchema,
  AgentApiRunCompleteResponseSchema,
  AgentApiRunStateResponseSchema,
  buildAgentApiContextItemPath,
  type AgentApiCreateContextItemRequest,
  type AgentApiUpdateContextItemRequest,
  type AgentApiRunCompleteRequest,
  type AgentApiRunStateRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";

export class ApiConflictError extends Error {}

type PromptTextPart = {
  type: "text";
  text: string;
};

type PromptToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

type PromptToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
};

type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | PromptTextPart[] }
  | { role: "assistant"; content: string | Array<PromptTextPart | PromptToolCallPart> }
  | { role: "tool"; content: PromptToolResultPart[] };

export type MessagesContext = {
  headItemId: number | null;
  messages: PromptMessage[];
  system: string;
};

export type ExecutionProfile = {
  resolved: {
    runId: string;
    sessionId: string;
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  };
  runtime: {
    modelIdleTimeoutMs: number;
    modelTotalTimeoutMs: number;
    modelRequestMaxRetries: number;
    autoCompactThresholdPct: number;
    visionModel: { providerId: string; modelId: string } | null;
    compactionModel: { providerId: string; modelId: string } | null;
    updatedAt: number;
  };
  vision: {
    source: "runtime_vision" | "agent_default_fallback";
    provider: {
      id: string;
      name: string;
      npm: "@ai-sdk/openai" | "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic";
      options: {
        baseURL: string;
        apiKey: string;
        apiMode?: "responses" | "chatCompletions";
      };
    };
    model: {
      id: string;
      providerModelId?: string;
      name: string;
      contextWindowTokens: number;
      options?: Record<string, unknown>;
    };
  } | null;
  compaction: {
    source: "runtime_compaction";
    provider: {
      id: string;
      name: string;
      npm: "@ai-sdk/openai" | "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic";
      options: {
        baseURL: string;
        apiKey: string;
        apiMode?: "responses" | "chatCompletions";
      };
    };
    model: {
      id: string;
      providerModelId?: string;
      name: string;
      contextWindowTokens: number;
      options?: Record<string, unknown>;
    };
  } | null;
  agent: {
    id: string;
    name: string;
    summary: string;
    prompt: string;
    tools: AgentToolName[];
    mcpServers: string[];
    pluginTools: PluginToolCanonicalName[];
    defaultModel: { providerId: string; modelId: string } | null;
  };
  provider: {
    id: string;
    name: string;
    npm: "@ai-sdk/openai" | "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic";
    options: {
      baseURL: string;
      apiKey: string;
      apiMode?: "responses" | "chatCompletions";
    };
  };
  model: {
    id: string;
    providerModelId?: string;
    name: string;
    contextWindowTokens: number;
    options?: Record<string, unknown>;
  };
};

export type GitEnvPrepareResponse =
  | {
      ok: true;
      kind: "https" | "ssh" | "none";
      env: Record<string, string>;
      leaseId: string | null;
      expiresAt: string | null;
    }
  | {
      ok: false;
      errorCode: string;
      error: string;
    };

export type PromptContext = {
  headItemId: number | null;
  system: string;
  messages: PromptMessage[];
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  pendingTools: Array<{
    itemId: number;
    status: "queued" | "running" | "streaming" | "completed" | "failed" | "cancelled";
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
  }>;
  lastResponseTotalTokens: number | null;
  uiLocale: AgentUiLocale | null;
  externalSkillRoots: Array<{
    sourceType: "workspace" | "repo";
    repoId?: string;
    rootDir: string;
    rootPath: string;
  }>;
};

export type AgentMcpSettingsPayload = {
  servers: Array<{
    id: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  updatedAt: number;
};

export class AgentApiClient {
  private readonly logger: Pick<Console, "warn">;

  constructor(
    private readonly params: {
      apiOrigin: string;
      internalToken: string;
      responseValidation?: "strict" | "warn";
      logger?: Pick<Console, "warn">;
    }
  ) {
    this.params.responseValidation ??= "strict";
    this.logger = this.params.logger ?? console;
  }

  private async request<T>(
    path: string,
    options: {
      method: "POST" | "PATCH";
      body: unknown;
      conflictAsError?: boolean;
      responseSchema?: TSchema;
      responseEndpoint?: string;
    }
  ) {
    const response = await fetch(`${this.params.apiOrigin}${path}`, {
      method: options.method,
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": this.params.internalToken
      },
      body: JSON.stringify(options.body)
    });

    if (options.conflictAsError && response.status === 409) {
      throw new ApiConflictError("context conflict");
    }
    if (!response.ok) {
      const txt = await response.text();
      try {
        const parsed = txt ? (JSON.parse(txt) as { message?: unknown; code?: unknown }) : null;
        const message = typeof parsed?.message === "string" ? parsed.message : txt;
        const code = typeof parsed?.code === "string" ? parsed.code : "";
        throw new Error(`request failed: ${response.status} ${message}${code ? ` (${code})` : ""}`);
      } catch {
        throw new Error(`request failed: ${response.status} ${txt}`);
      }
    }
    const parsed: unknown = await response.json();
    if (options.responseSchema && !Value.Check(options.responseSchema, parsed)) {
      const errors = [...Value.Errors(options.responseSchema, parsed)]
        .slice(0, 3)
        .map((error) => `${error.path || "/"}: ${error.message}`)
        .join("; ");
      const endpoint = options.responseEndpoint || path;
      if (this.params.responseValidation === "warn") {
        this.logger.warn(
          `[agent-api] response schema mismatch endpoint=${endpoint} method=${options.method}: ${errors}`
        );
      } else {
        throw new Error(`response schema validation failed: ${options.method} ${endpoint}: ${errors}`);
      }
    }
    return parsed as T;
  }

  async createContextItem(input: AgentApiCreateContextItemRequest) {
    const res = await this.request<AgentApiCreateContextItemResponse>(AgentApiEndpoints.createContextItem.path, {
      method: AgentApiEndpoints.createContextItem.method,
      body: input,
      conflictAsError: true,
      responseSchema: AgentApiCreateContextItemResponseSchema,
      responseEndpoint: AgentApiEndpoints.createContextItem.path
    });
    return res.item;
  }

  async updateContextItem(input: AgentApiUpdateContextItemRequest & {
    itemId: number;
  }) {
    const path = buildAgentApiContextItemPath(input.itemId);
    const res = await this.request<AgentApiUpdateContextItemResponse>(path, {
      method: AgentApiEndpoints.updateContextItem.method,
      body: {
        status: input.status,
        output: input.output,
        updatedAt: input.updatedAt
      },
      responseSchema: AgentApiUpdateContextItemResponseSchema,
      responseEndpoint: path
    });
    return res.item;
  }

  async updateRunState(input: AgentApiRunStateRequest) {
    await this.request(AgentApiEndpoints.updateRunState.path, {
      method: AgentApiEndpoints.updateRunState.method,
      body: input,
      responseSchema: AgentApiRunStateResponseSchema,
      responseEndpoint: AgentApiEndpoints.updateRunState.path
    });
  }

  async completeRun(input: AgentApiRunCompleteRequest) {
    await this.request(AgentApiEndpoints.completeRun.path, {
      method: AgentApiEndpoints.completeRun.method,
      body: input,
      responseSchema: AgentApiRunCompleteResponseSchema,
      responseEndpoint: AgentApiEndpoints.completeRun.path
    });
  }

  async getExecutionProfile(input: { workspaceId: string; sessionId: string; runId: string }) {
    const response = await fetch(`${this.params.apiOrigin}/api/internal/agent/execution-profile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": this.params.internalToken
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`get execution profile failed: ${response.status} ${txt}`);
    }
    return (await response.json()) as ExecutionProfile;
  }

  async getPromptContext(input: { workspaceId: string; sessionId: string; runId: string }) {
    const response = await fetch(`${this.params.apiOrigin}/api/internal/agent/prompt-context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": this.params.internalToken
      },
      body: JSON.stringify(input)
    });
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`get prompt context failed: ${response.status} ${txt}`);
    }
    return (await response.json()) as PromptContext;
  }

  async getMessagesContext(input: {
    workspaceId: string;
    sessionId: string;
    appendMessage?: { role: "system" | "user"; content: string };
  }) {
    const response = await fetch(`${this.params.apiOrigin}/api/internal/agent/messages-context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": this.params.internalToken
      },
      body: JSON.stringify(input)
    });
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`get messages context failed: ${response.status} ${txt}`);
    }
    return (await response.json()) as MessagesContext;
  }

  async compactContext(input: AgentApiCompactContextRequest) {
    return this.request<AgentApiCompactContextResponse>(AgentApiEndpoints.compactContext.path, {
      method: AgentApiEndpoints.compactContext.method,
      body: input,
      conflictAsError: true,
      responseSchema: AgentApiCompactContextResponseSchema,
      responseEndpoint: AgentApiEndpoints.compactContext.path
    });
  }

  async archiveSearch(input: {
    workspaceId: string;
    sessionId: string;
    query: string;
    beforePos?: number;
    maxHits?: number;
    maxChars?: number;
    snippet?: boolean;
    regex?: boolean;
  }) {
    return await this.request<{ text: string; noArchive?: boolean }>("/api/internal/agent/archive/search", {
      method: "POST",
      body: input
    });
  }

  async archiveRead(input: {
    workspaceId: string;
    sessionId: string;
    beforePos?: number;
    lineCount?: number;
    maxChars?: number;
  }) {
    return await this.request<{ text: string; noArchive?: boolean }>("/api/internal/agent/archive/read", {
      method: "POST",
      body: input
    });
  }

  async getSubtaskPreforkPlan(input: AgentApiSubtaskPreforkPlanRequest) {
    return this.request<AgentApiSubtaskPreforkPlanResponse>(AgentApiEndpoints.getSubtaskPreforkPlan.path, {
      method: AgentApiEndpoints.getSubtaskPreforkPlan.method,
      body: input,
      responseSchema: AgentApiSubtaskPreforkPlanResponseSchema,
      responseEndpoint: AgentApiEndpoints.getSubtaskPreforkPlan.path
    });
  }

  async startSubtaskRun(input: AgentApiSubtaskStartRequest) {
    return this.request<AgentApiSubtaskStartResponse>(AgentApiEndpoints.startSubtask.path, {
      method: AgentApiEndpoints.startSubtask.method,
      body: input,
      responseSchema: AgentApiSubtaskStartResponseSchema,
      responseEndpoint: AgentApiEndpoints.startSubtask.path
    });
  }

  async getSubtaskResult(input: AgentApiSubtaskResultRequest) {
    return this.request<AgentApiSubtaskResultResponse>(AgentApiEndpoints.getSubtaskResult.path, {
      method: AgentApiEndpoints.getSubtaskResult.method,
      body: input,
      responseSchema: AgentApiSubtaskResultResponseSchema,
      responseEndpoint: AgentApiEndpoints.getSubtaskResult.path
    });
  }

  async getSubtaskStatus(input: AgentApiSubtaskStatusRequest) {
    return this.request<AgentApiSubtaskStatusResponse>(AgentApiEndpoints.getSubtaskStatus.path, {
      method: AgentApiEndpoints.getSubtaskStatus.method,
      body: input,
      responseSchema: AgentApiSubtaskStatusResponseSchema,
      responseEndpoint: AgentApiEndpoints.getSubtaskStatus.path
    });
  }

  async getAgentMcpSettings() {
    return this.request<AgentMcpSettingsPayload>("/api/internal/agent/mcp-settings", {
      method: "POST",
      body: {}
    });
  }

  async getPluginRuntimeSnapshots() {
    return this.request<PluginRuntimeSnapshotsResponse>("/api/internal/agent/plugins/runtime-snapshots", {
      method: "POST",
      body: {}
    });
  }

  async listPluginTools(input: PluginToolRpcListRequest) {
    return this.request<PluginToolRpcListResponse>("/api/internal/agent/plugins/tools/list", {
      method: "POST",
      body: input
    });
  }

  async executePluginTool(input: PluginToolRpcExecuteRequest) {
    return this.request<PluginToolRpcExecuteResponse>("/api/internal/agent/plugins/tools/execute", {
      method: "POST",
      body: input
    });
  }

  async prepareGitEnvForBash(input: { workspaceId: string; cwd: string; purpose?: string; timeoutMs?: number }) {
    return this.request<GitEnvPrepareResponse>("/api/internal/git-env/prepare", {
      method: "POST",
      body: input
    });
  }

  async cleanupGitEnvLease(input: { leaseId: string }) {
    return this.request<{ ok: true }>("/api/internal/git-env/cleanup", {
      method: "POST",
      body: input
    });
  }
}
