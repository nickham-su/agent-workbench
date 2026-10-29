import type { GitTarget, WorkspaceGitStatusRequest, WorkspaceGitStatusResponse } from "@agent-workbench/shared";
import type { ToolCall, ToolCallEnvelope, WorkspaceToolEvent } from "./host";

export type ToolRuntimeContext = {
  workspaceId: string;
  toolId: string;
  host: {
    call: (toToolId: string, call: ToolCall) => void;
    setToolDot: (toolId: string, dot: boolean) => void;
  };
  getCurrentTarget: () => GitTarget | null;
  getVisible: () => boolean;
  refreshView?: () => void | Promise<void>;
  onWorkspaceGitStatus?: (status: WorkspaceGitStatusResponse) => void;
  onBackgroundError?: (error: unknown) => void;
  api?: {
    getWorkspaceGitStatus?: (params: WorkspaceGitStatusRequest) => Promise<WorkspaceGitStatusResponse>;
  };
};

export type ToolRuntime = {
  start: () => void;
  dispose: () => void;
  refresh?: () => Promise<void>;
  onRepoChange: (nextTarget: GitTarget | null) => void;
  onVisibilityChange: (visible: boolean) => void;
  onCall: (envelope: ToolCallEnvelope) => void;
  onEvent?: (event: WorkspaceToolEvent) => void;
};
