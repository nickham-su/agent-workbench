export class ApiConflictError extends Error {}

type AppendEventParams = {
  workspaceId: string;
  sessionId: string;
  type: string;
  payload: unknown;
  correlationId?: string | null;
  causationId?: string | null;
  createdAt?: number;
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

export class AgentApiClient {
  constructor(
    private readonly params: {
      apiOrigin: string;
      internalToken: string;
    }
  ) {}

  async appendTimelineEvent(input: AppendEventParams) {
    const response = await fetch(`${this.params.apiOrigin}/api/internal/agent/append-timeline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": this.params.internalToken
      },
      body: JSON.stringify(input)
    });

    if (response.status === 409) {
      throw new ApiConflictError("append timeline conflict");
    }
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`append timeline failed: ${response.status} ${txt}`);
    }
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
}
