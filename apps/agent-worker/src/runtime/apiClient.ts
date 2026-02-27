export class ApiConflictError extends Error {}

type PromptTextPart = {
  type: "text";
  text: string;
};

type PromptToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: "bash" | "read" | "write";
  input: Record<string, unknown>;
};

type PromptToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: "bash" | "read" | "write";
  output: unknown;
};

type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | PromptTextPart[] }
  | { role: "assistant"; content: string | Array<PromptTextPart | PromptToolCallPart> }
  | { role: "tool"; content: PromptToolResultPart[] };

export type ExecutionProfile = {
  resolved: {
    runId: string;
    sessionId: string;
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  };
  agent: {
    id: string;
    name: string;
    prompt: string;
    tools: Array<"bash" | "read" | "write">;
    permissions: {
      allowRead: boolean;
      allowWrite: boolean;
      allowBash: boolean;
    };
    defaultModel: { providerId: string; modelId: string } | null;
  };
  provider: {
    id: string;
    name: string;
    npm: "@ai-sdk/openai" | "@ai-sdk/anthropic";
    options: {
      baseURL: string;
      apiKey: string;
    };
  };
  model: {
    id: string;
    providerModelId?: string;
    name: string;
    options?: Record<string, unknown>;
  };
};

export type PromptContext = {
  headItemId: number | null;
  system: string;
  messages: PromptMessage[];
  tools: Array<{
    name: "bash" | "read" | "write";
    description: string;
    inputSchema: Record<string, unknown>;
    requiresApproval: boolean;
  }>;
  pendingTools: Array<{
    itemId: number;
    status: "queued" | "running" | "awaiting_permission" | "streaming" | "completed" | "failed" | "denied" | "cancelled";
    toolName: "bash" | "read" | "write";
    toolCallId?: string;
    args: Record<string, unknown>;
    approved?: boolean;
  }>;
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
      throw new Error(`request failed: ${response.status} ${txt}`);
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
    status: "streaming" | "queued" | "running" | "awaiting_permission" | "completed" | "failed" | "denied" | "cancelled";
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
    status?: "streaming" | "queued" | "running" | "awaiting_permission" | "completed" | "failed" | "denied" | "cancelled";
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
    status: "idle" | "running" | "waiting_permission";
    activeRunId: string | null;
    activeAssistantItemId: number | null;
    waitingToolItemId: number | null;
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
}
