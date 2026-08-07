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
  constructor(
    private readonly params: {
      apiOrigin: string;
      internalToken: string;
    }
  ) {}

  private async request<T>(path: string, options: { method: "POST" | "PATCH"; body: unknown; conflictAsError?: boolean }) {
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
    return (await response.json()) as T;
  }

  async createContextItem(input: {
    workspaceId: string;
    sessionId: string;
    runId: string | null;
    turnId: string | null;
    step: number | null;
    prevId: number | null;
    kind: "user" | "assistant" | "tool" | "system";
    status: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
    output: unknown;
    createdAt?: number;
  }) {
    const res = await this.request<{ ok: true; item: { id: number } }>("/api/internal/agent/context-items", {
      method: "POST",
      body: input,
      conflictAsError: true
    });
    return res.item;
  }

  async updateContextItem(input: {
    itemId: number;
    status?: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
    output?: unknown;
    updatedAt?: number;
  }) {
    const res = await this.request<{ ok: true; item: { id: number } }>(`/api/internal/agent/context-items/${input.itemId}`, {
      method: "PATCH",
      body: {
        status: input.status,
        output: input.output,
        updatedAt: input.updatedAt
      }
    });
    return res.item;
  }

  async updateRunState(input: {
    workspaceId: string;
    sessionId: string;
    status: "idle" | "running";
    activeRunId: string | null;
    activeAssistantItemId: number | null;
    lastResponseTotalTokens?: number | null;
    runNoticeText?: string | null;
    updatedAt?: number;
  }) {
    await this.request<{ ok: true }>("/api/internal/agent/run-state", {
      method: "POST",
      body: input
    });
  }

  async completeRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    status: "completed" | "failed" | "cancelled";
    updatedAt?: number;
  }) {
    await this.request<{ ok: true }>("/api/internal/agent/run-complete", {
      method: "POST",
      body: input
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

  async compactContext(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    expectedHeadItemId: number | null;
    summaryText: string;
  }) {
    return this.request<{ compacted: boolean; summaryItemId: number | null; archivedCount: number }>(
      "/api/internal/agent/context/compact",
      {
        method: "POST",
        body: input,
        conflictAsError: true
      }
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

  async getSubtaskPreforkPlan(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
    agentId: string;
    thresholdPct?: number;
  }) {
    return this.request<{
      shouldPrefork: boolean;
      thresholdPct: number;
      parentLastResponseTotalTokens: number | null;
      childContextWindowTokens: number;
      thresholdTokens: number;
    }>("/api/internal/agent/subtask/prefork-plan", {
      method: "POST",
      body: input
    });
  }

  async startSubtaskRun(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
    description: string;
    prompt: string;
    agentId: string;
    session: { mode: "new" | "existing" | "fork"; sessionId?: string };
    preforkSummaryText?: string;
    preforkMeta?: {
      thresholdPct: number;
      parentLastResponseTotalTokens: number;
      childContextWindowTokens: number;
    };
  }) {
    return this.request<{ sessionId: string; runId: string; workspacePath: string; agentName: string }>("/api/internal/agent/subtask/start", {
      method: "POST",
      body: input
    });
  }

  async getSubtaskResult(input: { workspaceId: string; sessionId: string; runId: string }) {
    return this.request<{ resultText: string }>("/api/internal/agent/subtask/result", {
      method: "POST",
      body: input
    });
  }

  async getSubtaskStatus(input: { workspaceId: string; sessionId: string; runId: string }) {
    return this.request<{ status: "running" | "completed" | "failed" | "cancelled" }>(
      "/api/internal/agent/subtask/status",
      {
        method: "POST",
        body: input
      }
    );
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
