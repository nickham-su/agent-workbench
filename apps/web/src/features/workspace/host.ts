import type { InjectionKey } from "vue";
import { inject } from "vue";

export type DockArea = "leftTop" | "leftBottom" | "rightTop";

export type WorkspaceToolCommandMap = {
  refresh?: () => void | Promise<void>;
  goToPreviousDiff?: () => void | Promise<void>;
  goToNextDiff?: () => void | Promise<void>;
};

export type ToolCall = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ToolCallEnvelope = ToolCall & {
  fromToolId: string;
  toToolId: string;
  workspaceId: string;
  targetAtCall: { kind: "workspaceRepo"; workspaceId: string; dirName: string } | null;
  ts: number;
};

export type WorkspaceToolEvent = {
  type: string;
  payload?: unknown;
  sourceToolId?: string;
};

export type WorkspaceHostApi = {
  openTool: (toolId: string) => void;
  minimizeTool: (toolId: string) => void;
  toggleMinimize: (toolId: string) => void;

  callFrom: (fromToolId: string, toToolId: string, call: ToolCall) => void;
  setToolDot: (toolId: string, dot: boolean) => void;

  registerToolCommands: (toolId: string, commands: WorkspaceToolCommandMap) => () => void;
  emitToolEvent: (toolId: string, event: WorkspaceToolEvent) => void;
};

export type WorkspaceToolHostApi = {
  openTool: (toolId: string) => void;
  minimizeTool: (toolId: string) => void;
  toggleMinimize: (toolId: string) => void;
  call: (toToolId: string, call: ToolCall) => void;
  setToolDot: (toolId: string, dot: boolean) => void;
  registerToolCommands: (toolId: string, commands: WorkspaceToolCommandMap) => () => void;
  emitToolEvent: (toolId: string, event: WorkspaceToolEvent) => void;
};

export const workspaceHostKey: InjectionKey<WorkspaceHostApi> = Symbol("agent-workbench.workspace.host");

export function useWorkspaceHost(): WorkspaceHostApi;
export function useWorkspaceHost(toolId: string): WorkspaceToolHostApi;
export function useWorkspaceHost(toolId?: string): WorkspaceHostApi | WorkspaceToolHostApi {
  const api = inject(workspaceHostKey, null);
  if (!api) throw new Error("WorkspaceHostApi 未提供：请确认组件处于 WorkspaceLayout 作用域内");
  if (!toolId) return api;
  return {
    ...api,
    call: (toToolId: string, call: ToolCall) => api.callFrom(toolId, toToolId, call)
  };
}
