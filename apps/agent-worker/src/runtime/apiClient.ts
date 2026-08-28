import type {
  PluginRuntimeSnapshotsResponse,
  PluginToolRpcExecuteRequest,
  PluginToolRpcExecuteResponse,
  PluginToolRpcListRequest,
  PluginToolRpcListResponse,
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
  type AgentApiRunStateRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";

export class ApiConflictError extends Error {}

type InternalRpcMethod = "POST" | "PATCH";

export type AgentApiClientPolicyName =
  "controlRead" | "controlWrite" | "subtaskStart" | "runComplete" | "excluded";

export type AgentApiClientPolicy = {
  name: AgentApiClientPolicyName;
  maxRetries: number;
  timeoutMs: number | null;
};

type InternalRpcRetryReason =
  "timeout" | "network" | "http_502" | "http_503" | "http_504";

const RETRY_DELAY_MS = 300;
const INTERNAL_RPC_ERROR_BODY_MAX_BYTES = 4 * 1024;
const INTERNAL_RPC_ERROR_CODE_MAX_CHARS = 128;
const INTERNAL_RPC_ERROR_MESSAGE_MAX_CHARS = 512;
const INTERNAL_RPC_ERROR_MESSAGE_UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const INTERNAL_RPC_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const EXCLUDED_POLICY: AgentApiClientPolicy = {
  name: "excluded",
  timeoutMs: null,
  maxRetries: 0,
};

type InternalRpcSafeErrorDetails = {
  method: InternalRpcMethod;
  endpoint: string;
};

type InternalRpcSafeBusinessErrorDetails = {
  apiCode?: string;
  safeMessage?: string;
};

export class InternalRpcTimeoutError extends Error {
  readonly code = "AGENT_INTERNAL_RPC_TIMEOUT";
  readonly method: InternalRpcMethod;
  readonly endpoint: string;
  readonly timeoutMs: number;

  constructor(details: InternalRpcSafeErrorDetails & { timeoutMs: number }) {
    super(
      `internal rpc timeout: ${details.method} ${details.endpoint} timeoutMs=${details.timeoutMs}`,
    );
    this.name = "InternalRpcTimeoutError";
    this.method = details.method;
    this.endpoint = details.endpoint;
    this.timeoutMs = details.timeoutMs;
  }
}

export class InternalRpcHttpError extends Error {
  readonly code = "AGENT_INTERNAL_RPC_HTTP_ERROR";
  readonly method: InternalRpcMethod;
  readonly endpoint: string;
  readonly status: number;
  readonly apiCode?: string;
  readonly safeMessage?: string;

  constructor(details: InternalRpcSafeErrorDetails & { status: number } & InternalRpcSafeBusinessErrorDetails) {
    const diagnostics = [
      details.apiCode ? `code=${details.apiCode}` : "",
      details.safeMessage ? `message=${details.safeMessage}` : "",
    ].filter(Boolean);
    super(
      `internal rpc failed: ${details.method} ${details.endpoint} status=${details.status}${diagnostics.length ? ` ${diagnostics.join(" ")}` : ""}`,
    );
    this.name = "InternalRpcHttpError";
    this.method = details.method;
    this.endpoint = details.endpoint;
    this.status = details.status;
    this.apiCode = details.apiCode;
    this.safeMessage = details.safeMessage;
  }
}

export class InternalRpcNetworkError extends Error {
  readonly code = "AGENT_INTERNAL_RPC_NETWORK_ERROR";
  readonly method: InternalRpcMethod;
  readonly endpoint: string;

  constructor(details: InternalRpcSafeErrorDetails) {
    super(
      `internal rpc network failure: ${details.method} ${details.endpoint}`,
    );
    this.name = "InternalRpcNetworkError";
    this.method = details.method;
    this.endpoint = details.endpoint;
  }
}

export class InternalRpcInvalidResponseError extends Error {
  readonly code = "AGENT_INTERNAL_RPC_INVALID_RESPONSE";
  readonly method: InternalRpcMethod;
  readonly endpoint: string;
  readonly stage: "body-or-json" | "schema";

  constructor(
    details: InternalRpcSafeErrorDetails & { stage: "body-or-json" | "schema" },
  ) {
    super(
      `internal rpc invalid response: ${details.method} ${details.endpoint} stage=${details.stage}`,
    );
    this.name = "InternalRpcInvalidResponseError";
    this.method = details.method;
    this.endpoint = details.endpoint;
    this.stage = details.stage;
  }
}

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
  "token",
]);

function formatSafeResponseSchemaErrorPath(path: string) {
  const normalized = String(path || "/");
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/~1/g, "/")
        .replace(/~0/g, "~")
        .replace(/[-_]/g, "")
        .toLowerCase(),
    );
  if (
    normalized.length > 128 ||
    segments.some((segment) =>
      SENSITIVE_RESPONSE_DIAGNOSTIC_PATH_SEGMENTS.has(segment),
    )
  ) {
    return "<redacted>";
  }
  return normalized;
}

function normalizeSafeErrorCode(raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > INTERNAL_RPC_ERROR_CODE_MAX_CHARS) return undefined;
  return INTERNAL_RPC_ERROR_CODE_PATTERN.test(value) ? value : undefined;
}

function normalizeSafeErrorMessage(raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const value = raw
    .replace(INTERNAL_RPC_ERROR_MESSAGE_UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return undefined;
  return value.slice(0, INTERNAL_RPC_ERROR_MESSAGE_MAX_CHARS);
}

async function readSafeBusinessErrorDetails(response: Response): Promise<InternalRpcSafeBusinessErrorDetails> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > INTERNAL_RPC_ERROR_BODY_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {};
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > INTERNAL_RPC_ERROR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {};
      }
      chunks.push(value);
    }
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const body = parsed as Record<string, unknown>;
  const apiCode = normalizeSafeErrorCode(body.code);
  const safeMessage = normalizeSafeErrorMessage(body.message);
  return {
    ...(apiCode ? { apiCode } : {}),
    ...(safeMessage ? { safeMessage } : {}),
  };
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
      internalRpcTimeoutMs: number;
      completeRunTimeoutMs: number;
      logger?: Pick<Console, "warn">;
      /** @internal Test-only seam for retry delay verification. */
      sleepFn?: (ms: number) => Promise<void>;
    },
  ) {
    this.params.responseValidation ??= "strict";
    this.logger = this.params.logger ?? console;
  }

  static readonly publicMethodPolicies = {
    createContextItem: "controlWrite",
    updateContextItem: "controlWrite",
    updateRunState: "controlWrite",
    completeRun: "runComplete",
    getExecutionProfile: "controlRead",
    getPromptContext: "controlRead",
    getMessagesContext: "controlRead",
    compactContext: "controlWrite",
    archiveSearch: "excluded",
    archiveRead: "excluded",
    getSubtaskPreforkPlan: "controlRead",
    startSubtaskRun: "subtaskStart",
    getSubtaskResult: "controlRead",
    getSubtaskStatus: "controlRead",
    getAgentMcpSettings: "controlRead",
    getPluginRuntimeSnapshots: "controlRead",
    listPluginTools: "controlRead",
    executePluginTool: "excluded",
    prepareGitEnvForBash: "excluded",
    cleanupGitEnvLease: "excluded",
  } as const satisfies Record<string, AgentApiClientPolicyName>;

  private resolvePolicy(name: AgentApiClientPolicyName): AgentApiClientPolicy {
    switch (name) {
      case "controlRead":
        return {
          name,
          timeoutMs: this.params.internalRpcTimeoutMs,
          maxRetries: 1,
        };
      case "controlWrite":
        return {
          name,
          timeoutMs: this.params.internalRpcTimeoutMs,
          maxRetries: 0,
        };
      case "subtaskStart":
        return {
          name,
          timeoutMs: this.params.internalRpcTimeoutMs,
          maxRetries: 1,
        };
      case "runComplete":
        return {
          name,
          timeoutMs: this.params.completeRunTimeoutMs,
          maxRetries: 1,
        };
      case "excluded":
        return EXCLUDED_POLICY;
    }
  }

  private getRetryReason(error: unknown): InternalRpcRetryReason | null {
    if (error instanceof InternalRpcTimeoutError) return "timeout";
    if (error instanceof InternalRpcNetworkError) return "network";
    if (
      error instanceof InternalRpcHttpError &&
      [502, 503, 504].includes(error.status)
    ) {
      return `http_${error.status}` as InternalRpcRetryReason;
    }
    return null;
  }

  private logFailure(
    event: "timeout" | "retry" | "recovered" | "failed",
    details: {
      method: InternalRpcMethod;
      endpoint: string;
      policy: AgentApiClientPolicy;
      attempt: number;
      elapsedMs: number;
      reason?: InternalRpcRetryReason | null;
      status?: number;
    },
  ) {
    const fields = [
      `[agent-api] ${event}`,
      `endpoint=${details.endpoint}`,
      `method=${details.method}`,
      `policy=${details.policy.name}`,
      `attempt=${details.attempt}`,
      `elapsedMs=${details.elapsedMs}`,
    ];
    if (details.policy.timeoutMs != null)
      fields.push(`timeoutMs=${details.policy.timeoutMs}`);
    if (details.reason != null) fields.push(`reason=${details.reason}`);
    if (details.status != null) fields.push(`status=${details.status}`);
    if (details.policy.name === "excluded") return;
    this.logger.warn(fields.join(" "));
  }

  private async request<T>(
    path: string,
    options: {
      method: InternalRpcMethod;
      body: unknown;
      conflictAsError?: boolean;
      responseSchema?: TSchema;
      responseEndpoint?: string;
      policy: AgentApiClientPolicyName;
    },
  ) {
    const method = options.method;
    const endpoint = options.responseEndpoint || path;
    const policy = this.resolvePolicy(options.policy);
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
      try {
        const result = await this.executeAttempt<T>(
          path,
          options,
          method,
          endpoint,
          policy.timeoutMs,
        );
        if (attempt > 1) {
          this.logFailure("recovered", {
            method,
            endpoint,
            policy,
            attempt,
            elapsedMs: Date.now() - startedAt,
          });
        }
        return result;
      } catch (error) {
        const retryReason = this.getRetryReason(error);
        const status =
          error instanceof InternalRpcHttpError ? error.status : undefined;
        if (error instanceof InternalRpcTimeoutError) {
          this.logFailure("timeout", {
            method,
            endpoint,
            policy,
            attempt,
            elapsedMs: Date.now() - startedAt,
            reason: retryReason,
          });
        }
        if (retryReason != null && attempt <= policy.maxRetries) {
          this.logFailure("retry", {
            method,
            endpoint,
            policy,
            attempt: attempt + 1,
            elapsedMs: Date.now() - startedAt,
            reason: retryReason,
            status,
          });
          await (
            this.params.sleepFn ??
            ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(RETRY_DELAY_MS);
          continue;
        }
        this.logFailure("failed", {
          method,
          endpoint,
          policy,
          attempt,
          elapsedMs: Date.now() - startedAt,
          reason: retryReason,
          status,
        });
        throw error;
      }
    }
    throw new InternalRpcNetworkError({ method, endpoint });
  }

  private async executeAttempt<T>(
    path: string,
    options: {
      method: InternalRpcMethod;
      body: unknown;
      conflictAsError?: boolean;
      responseSchema?: TSchema;
      responseEndpoint?: string;
      policy: AgentApiClientPolicyName;
    },
    method: InternalRpcMethod,
    endpoint: string,
    timeoutMs: number | null,
  ) {
    const controller = timeoutMs == null ? null : new AbortController();
    let localTimedOut = false;
    let knownHttpStatus: number | null = null;
    let knownBusinessError: InternalRpcSafeBusinessErrorDetails = {};
    let receivedSuccessResponse = false;
    const timeout =
      timeoutMs == null
        ? null
        : setTimeout(() => {
            localTimedOut = true;
            controller?.abort();
          }, timeoutMs);

    try {
      const response = await fetch(`${this.params.apiOrigin}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-awb-agent-internal-token": this.params.internalToken,
        },
        body: JSON.stringify(options.body),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!response.ok) {
        knownHttpStatus = response.status;
        knownBusinessError = await readSafeBusinessErrorDetails(response);
        if (options.conflictAsError && knownHttpStatus === 409) {
          throw new ApiConflictError("context conflict");
        }
        throw new InternalRpcHttpError({
          method,
          endpoint,
          status: knownHttpStatus,
          ...knownBusinessError,
        });
      }

      receivedSuccessResponse = true;
      const parsed: unknown = await response.json();
      if (
        options.responseSchema &&
        !Value.Check(options.responseSchema, parsed)
      ) {
        const errors = [...Value.Errors(options.responseSchema, parsed)]
          .slice(0, 3)
          .map(
            (error) =>
              `path=${formatSafeResponseSchemaErrorPath(error.path)} type=${error.type}`,
          )
          .join("; ");
        if (this.params.responseValidation === "warn") {
          this.logger.warn(
            `[agent-api] response schema mismatch endpoint=${endpoint} method=${method}: ${errors}`,
          );
        } else {
          throw new InternalRpcInvalidResponseError({
            method,
            endpoint,
            stage: "schema",
          });
        }
      }
      return parsed as T;
    } catch (error) {
      if (knownHttpStatus != null) {
        if (options.conflictAsError && knownHttpStatus === 409) {
          throw new ApiConflictError("context conflict");
        }
        throw new InternalRpcHttpError({
          method,
          endpoint,
          status: knownHttpStatus,
          ...knownBusinessError,
        });
      }
      if (localTimedOut) {
        throw new InternalRpcTimeoutError({
          method,
          endpoint,
          timeoutMs: timeoutMs ?? 0,
        });
      }
      if (
        error instanceof ApiConflictError ||
        error instanceof InternalRpcHttpError ||
        error instanceof InternalRpcInvalidResponseError
      ) {
        throw error;
      }
      if (receivedSuccessResponse) {
        throw new InternalRpcInvalidResponseError({
          method,
          endpoint,
          stage: "body-or-json",
        });
      }
      throw new InternalRpcNetworkError({ method, endpoint });
    } finally {
      if (timeout != null) clearTimeout(timeout);
    }
  }

  async createContextItem(input: AgentApiCreateContextItemRequest) {
    const res = await this.request<AgentApiCreateContextItemResponse>(
      AgentApiEndpoints.createContextItem.path,
      {
        method: AgentApiEndpoints.createContextItem.method,
        body: input,
        conflictAsError: true,
        responseSchema: AgentApiCreateContextItemResponseSchema,
        responseEndpoint: AgentApiEndpoints.createContextItem.path,
        policy: AgentApiClient.publicMethodPolicies.createContextItem,
      },
    );
    return res;
  }

  async updateContextItem(
    input: AgentApiUpdateContextItemRequest & {
      itemId: number;
    },
  ) {
    const path = buildAgentApiContextItemPath(input.itemId);
    const res = await this.request<AgentApiUpdateContextItemResponse>(path, {
      method: AgentApiEndpoints.updateContextItem.method,
      body: {
        status: input.status,
        output: input.output,
        updatedAt: input.updatedAt,
      },
      responseSchema: AgentApiUpdateContextItemResponseSchema,
      responseEndpoint: AgentApiEndpoints.updateContextItem.routeTemplate,
      policy: AgentApiClient.publicMethodPolicies.updateContextItem,
    });
    return res.item;
  }

  async updateRunState(input: AgentApiRunStateRequest) {
    await this.request(AgentApiEndpoints.updateRunState.path, {
      method: AgentApiEndpoints.updateRunState.method,
      body: input,
      responseSchema: AgentApiRunStateResponseSchema,
      responseEndpoint: AgentApiEndpoints.updateRunState.path,
      policy: AgentApiClient.publicMethodPolicies.updateRunState,
    });
  }

  async completeRun(input: AgentApiRunCompleteRequest) {
    await this.request(AgentApiEndpoints.completeRun.path, {
      method: AgentApiEndpoints.completeRun.method,
      body: input,
      responseSchema: AgentApiRunCompleteResponseSchema,
      responseEndpoint: AgentApiEndpoints.completeRun.path,
      policy: AgentApiClient.publicMethodPolicies.completeRun,
    });
  }

  async getExecutionProfile(input: AgentApiExecutionProfileRequest) {
    return this.request<AgentApiExecutionProfileResponse>(
      AgentApiEndpoints.getExecutionProfile.path,
      {
        method: AgentApiEndpoints.getExecutionProfile.method,
        body: input,
        responseSchema: AgentApiExecutionProfileResponseSchema,
        responseEndpoint: AgentApiEndpoints.getExecutionProfile.path,
        policy: AgentApiClient.publicMethodPolicies.getExecutionProfile,
      },
    );
  }

  async getPromptContext(input: AgentApiPromptContextRequest) {
    return this.request<AgentApiPromptContextResponse>(
      AgentApiEndpoints.getPromptContext.path,
      {
        method: AgentApiEndpoints.getPromptContext.method,
        body: input,
        responseSchema: AgentApiPromptContextResponseSchema,
        responseEndpoint: AgentApiEndpoints.getPromptContext.path,
        policy: AgentApiClient.publicMethodPolicies.getPromptContext,
      },
    );
  }

  async getMessagesContext(input: AgentApiMessagesContextRequest) {
    return this.request<AgentApiMessagesContextResponse>(
      AgentApiEndpoints.getMessagesContext.path,
      {
        method: AgentApiEndpoints.getMessagesContext.method,
        body: input,
        responseSchema: AgentApiMessagesContextResponseSchema,
        responseEndpoint: AgentApiEndpoints.getMessagesContext.path,
        policy: AgentApiClient.publicMethodPolicies.getMessagesContext,
      },
    );
  }

  async compactContext(input: AgentApiCompactContextRequest) {
    return this.request<AgentApiCompactContextResponse>(
      AgentApiEndpoints.compactContext.path,
      {
        method: AgentApiEndpoints.compactContext.method,
        body: input,
        conflictAsError: true,
        responseSchema: AgentApiCompactContextResponseSchema,
        responseEndpoint: AgentApiEndpoints.compactContext.path,
        policy: AgentApiClient.publicMethodPolicies.compactContext,
      },
    );
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
    return await this.request<{ text: string; noArchive?: boolean }>(
      "/api/internal/agent/archive/search",
      {
        method: "POST",
        body: input,
        policy: AgentApiClient.publicMethodPolicies.archiveSearch,
      },
    );
  }

  async archiveRead(input: {
    workspaceId: string;
    sessionId: string;
    beforePos?: number;
    lineCount?: number;
    maxChars?: number;
  }) {
    return await this.request<{ text: string; noArchive?: boolean }>(
      "/api/internal/agent/archive/read",
      {
        method: "POST",
        body: input,
        policy: AgentApiClient.publicMethodPolicies.archiveRead,
      },
    );
  }

  async getSubtaskPreforkPlan(input: AgentApiSubtaskPreforkPlanRequest) {
    return this.request<AgentApiSubtaskPreforkPlanResponse>(
      AgentApiEndpoints.getSubtaskPreforkPlan.path,
      {
        method: AgentApiEndpoints.getSubtaskPreforkPlan.method,
        body: input,
        responseSchema: AgentApiSubtaskPreforkPlanResponseSchema,
        responseEndpoint: AgentApiEndpoints.getSubtaskPreforkPlan.path,
        policy: AgentApiClient.publicMethodPolicies.getSubtaskPreforkPlan,
      },
    );
  }

  async startSubtaskRun(input: AgentApiSubtaskStartRequest) {
    return this.request<AgentApiSubtaskStartResponse>(
      AgentApiEndpoints.startSubtask.path,
      {
        method: AgentApiEndpoints.startSubtask.method,
        body: input,
        responseSchema: AgentApiSubtaskStartResponseSchema,
        responseEndpoint: AgentApiEndpoints.startSubtask.path,
        policy: AgentApiClient.publicMethodPolicies.startSubtaskRun,
      },
    );
  }

  async getSubtaskResult(input: AgentApiSubtaskResultRequest) {
    return this.request<AgentApiSubtaskResultResponse>(
      AgentApiEndpoints.getSubtaskResult.path,
      {
        method: AgentApiEndpoints.getSubtaskResult.method,
        body: input,
        responseSchema: AgentApiSubtaskResultResponseSchema,
        responseEndpoint: AgentApiEndpoints.getSubtaskResult.path,
        policy: AgentApiClient.publicMethodPolicies.getSubtaskResult,
      },
    );
  }

  async getSubtaskStatus(input: AgentApiSubtaskStatusRequest) {
    return this.request<AgentApiSubtaskStatusResponse>(
      AgentApiEndpoints.getSubtaskStatus.path,
      {
        method: AgentApiEndpoints.getSubtaskStatus.method,
        body: input,
        responseSchema: AgentApiSubtaskStatusResponseSchema,
        responseEndpoint: AgentApiEndpoints.getSubtaskStatus.path,
        policy: AgentApiClient.publicMethodPolicies.getSubtaskStatus,
      },
    );
  }

  async getAgentMcpSettings() {
    return this.request<AgentMcpSettingsPayload>(
      "/api/internal/agent/mcp-settings",
      {
        method: "POST",
        body: {},
        policy: AgentApiClient.publicMethodPolicies.getAgentMcpSettings,
      },
    );
  }

  async getPluginRuntimeSnapshots() {
    return this.request<PluginRuntimeSnapshotsResponse>(
      "/api/internal/agent/plugins/runtime-snapshots",
      {
        method: "POST",
        body: {},
        policy: AgentApiClient.publicMethodPolicies.getPluginRuntimeSnapshots,
      },
    );
  }

  async listPluginTools(input: PluginToolRpcListRequest) {
    return this.request<PluginToolRpcListResponse>(
      "/api/internal/agent/plugins/tools/list",
      {
        method: "POST",
        body: input,
        policy: AgentApiClient.publicMethodPolicies.listPluginTools,
      },
    );
  }

  async executePluginTool(input: PluginToolRpcExecuteRequest) {
    return this.request<PluginToolRpcExecuteResponse>(
      "/api/internal/agent/plugins/tools/execute",
      {
        method: "POST",
        body: input,
        policy: AgentApiClient.publicMethodPolicies.executePluginTool,
      },
    );
  }

  async prepareGitEnvForBash(input: {
    workspaceId: string;
    cwd: string;
    purpose?: string;
    timeoutMs?: number;
  }) {
    return this.request<GitEnvPrepareResponse>(
      "/api/internal/git-env/prepare",
      {
        method: "POST",
        body: input,
        policy: AgentApiClient.publicMethodPolicies.prepareGitEnvForBash,
      },
    );
  }

  async cleanupGitEnvLease(input: { leaseId: string }) {
    return this.request<{ ok: true }>("/api/internal/git-env/cleanup", {
      method: "POST",
      body: input,
      policy: AgentApiClient.publicMethodPolicies.cleanupGitEnvLease,
    });
  }
}
