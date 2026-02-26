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
}
