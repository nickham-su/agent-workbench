import type { AgentCompactSessionRequest, AgentCompactSessionResponse, AgentMessageSessionRunState } from "@agent-workbench/shared";
import type { AgentSessionRecord } from "@agent-workbench/shared/internal-contracts/agent-api-session";

export type ManualCompactionRunState = { status: string };
export type ManualCompactionProfile = { agentId: string; providerId: string; modelId: string };

export type ManualCompactionRuntime = {
  enqueueRun(run: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    workspacePath: string;
    workspaceRepoDirNames: string[];
    runKind: "manual_compaction";
  }): void | Promise<void>;
};

export type ManualCompactionApplicationDependencies = {
  sessions: {
    get(sessionId: string): AgentSessionRecord | null;
  };
  isWorkerEnabled(): boolean;
  findDedup(params: { workspaceId: string; sessionId: string; clientRequestId: string }): { runId: string } | null;
  getRunState(workspaceId: string, sessionId: string): ManualCompactionRunState;
  getControlRunState(sessionId: string): AgentMessageSessionRunState;
  resolveProfile(params: { workspaceId: string; sessionId: string; requestedAgentId?: string }): ManualCompactionProfile;
  getWorkspaceRunContext(workspaceId: string): { workspacePath: string; workspaceRepoDirNames: string[] } | null;
  activate(params: {
    workspaceId: string;
    sessionId: string;
    triggerMessageId: string;
    clientRequestId: string;
    runId: string;
    profile: ManualCompactionProfile;
    uiLocale: "zh-CN" | "en-US" | null;
    createdAt: number;
  }): void;
  enqueueActivatedRunOrReconcile(params: {
    runtime: Pick<ManualCompactionRuntime, "enqueueRun">;
    run: {
      workspaceId: string; sessionId: string; runId: string;
      workspacePath: string; workspaceRepoDirNames: string[];
      runKind: "manual_compaction";
    };
  }): Promise<void>;
  clock: { nowMs(): number };
  ids: { newRunId(): string };
};

export type ScheduleManualCompactionCommand = {
  sessionId: string;
  body: AgentCompactSessionRequest;
  runtime: ManualCompactionRuntime;
};
