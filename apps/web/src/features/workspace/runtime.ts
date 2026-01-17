import type { GitTarget } from "@agent-workbench/shared";
import type { ToolCall, ToolCallEnvelope } from "./host";

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
  api?: {
    getGitStatus?: (params: { target: GitTarget }) => Promise<unknown>;
  };
};

export type ToolRuntime = {
  start: () => void;
  dispose: () => void;
  onRepoChange: (nextTarget: GitTarget | null) => void;
  onVisibilityChange: (visible: boolean) => void;
  onCall: (envelope: ToolCallEnvelope) => void;
};
