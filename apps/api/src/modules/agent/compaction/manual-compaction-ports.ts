import type { AgentCompactSessionRequest, AgentCompactSessionResponse, AgentSessionRecord } from "@agent-workbench/shared";

export type ManualCompactionRunState = { status: string };
export type ManualCompactionProfile = { agentId: string; providerId: string; modelId: string };

export type ManualCompactionRuntime = {
  enqueueRun(run: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    workspacePath: string;
    workspaceRepoDirNames: string[];
    inputText: "__awb_compact__";
  }): void | Promise<void>;
};

export type ManualCompactionApplicationDependencies = {
  reconcilePendingForSessionBestEffort(params: { workspaceId: string; sessionId: string }): Promise<boolean>;
  sessions: {
    get(sessionId: string): AgentSessionRecord | null;
    getVisibleItems(workspaceId: string, sessionId: string): Array<{ kind: string; boundaryReason: string | null }>;
  };
  isWorkerEnabled(): boolean;
  findDedup(params: { workspaceId: string; sessionId: string; clientRequestId: string }): { runId: string } | null;
  getRunState(workspaceId: string, sessionId: string): ManualCompactionRunState;
  getControlRunState(sessionId: string): AgentCompactSessionResponse["runState"];
  resolveProfile(params: { workspaceId: string; requestedAgentId?: string }): ManualCompactionProfile;
  getWorkspaceRunContext(workspaceId: string): { workspacePath: string; workspaceRepoDirNames: string[] } | null;
  activate(params: {
    workspaceId: string;
    sessionId: string;
    triggerItemId: number;
    clientRequestId: string;
    runId: string;
    profile: ManualCompactionProfile;
    uiLocale: "zh-CN" | "en-US" | null;
    createdAt: number;
  }): void;
  failAfterEnqueueFailure(params: { workspaceId: string; sessionId: string; runId: string; updatedAt: number }): void;
  clock: { nowMs(): number };
  ids: { newRunId(): string };
};

export type ScheduleManualCompactionCommand = {
  sessionId: string;
  body: AgentCompactSessionRequest;
  runtime: ManualCompactionRuntime;
};
