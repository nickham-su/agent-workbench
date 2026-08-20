import type {
  PluginRuntimeSnapshotsResponse,
  PluginToolRpcExecuteRequest,
  PluginToolRpcExecuteResponse,
  PluginToolRpcListRequest,
  PluginToolRpcListResponse
} from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  AgentApiEndpoints,
  type AgentApiExecutionProfileRequest,
  type AgentApiExecutionProfileResponse,
  AgentApiExecutionProfileResponseSchema,
  type AgentApiMessagesContextRequest,
  type AgentApiMessagesContextResponse,
  AgentApiMessagesContextResponseSchema,
  type AgentApiPromptContextRequest,
  type AgentApiPromptContextResponse,
  AgentApiPromptContextResponseSchema,
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

const SENSITIVE_RESPONSE_DIAGNOSTIC_PATH_SEGMENTS = new Set([
  "apikey",
  "args",
  "authorization",
  "content",
  "input",
  "messages",
  "output",
  "prompt",
  "result",
  "runid",
  "secret",
  "sessionid",
  "token"
]);

function formatSafeResponseSchemaErrorPath(path: string) {
  const normalized = String(path || "/");
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~").replace(/[-_]/g, "").toLowerCase());
  if (normalized.length > 128 || segments.some((segment) => SENSITIVE_RESPONSE_DIAGNOSTIC_PATH_SEGMENTS.has(segment))) {
    return "<redacted>";
  }
  return normalized;
}

export type MessagesContext = AgentApiMessagesContextResponse;
export type ExecutionProfile = AgentApiExecutionProfileResponse;

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

export type PromptContext = AgentApiPromptContextResponse;

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
        .map((error) => `path=${formatSafeResponseSchemaErrorPath(error.path)} type=${error.type}`)
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
    return res;
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

  async getExecutionProfile(input: AgentApiExecutionProfileRequest) {
    return this.request<AgentApiExecutionProfileResponse>(AgentApiEndpoints.getExecutionProfile.path, {
      method: AgentApiEndpoints.getExecutionProfile.method,
      body: input,
      responseSchema: AgentApiExecutionProfileResponseSchema,
      responseEndpoint: AgentApiEndpoints.getExecutionProfile.path
    });
  }

  async getPromptContext(input: AgentApiPromptContextRequest) {
    return this.request<AgentApiPromptContextResponse>(AgentApiEndpoints.getPromptContext.path, {
      method: AgentApiEndpoints.getPromptContext.method,
      body: input,
      responseSchema: AgentApiPromptContextResponseSchema,
      responseEndpoint: AgentApiEndpoints.getPromptContext.path
    });
  }

  async getMessagesContext(input: AgentApiMessagesContextRequest) {
    return this.request<AgentApiMessagesContextResponse>(AgentApiEndpoints.getMessagesContext.path, {
      method: AgentApiEndpoints.getMessagesContext.method,
      body: input,
      responseSchema: AgentApiMessagesContextResponseSchema,
      responseEndpoint: AgentApiEndpoints.getMessagesContext.path
    });
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
