import type { InjectionKey } from "vue";
import { inject } from "vue";

export type DockArea = "leftTop" | "leftBottom" | "rightTop";

export type WorkspaceToolCommandMap = {
  refresh?: () => void | Promise<void>;
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

  registerToolCommands: (toolId: string, commands: WorkspaceToolCommandMap) => () => void;
  emitToolEvent: (toolId: string, event: WorkspaceToolEvent) => void;
  drainToolEvents: (toolId: string) => WorkspaceToolEvent[];
};

export const workspaceHostKey: InjectionKey<WorkspaceHostApi> = Symbol("agent-workbench.workspace.host");

export function useWorkspaceHost() {
  const api = inject(workspaceHostKey, null);
  if (!api) throw new Error("WorkspaceHostApi 未提供：请确认组件处于 WorkspaceLayout 作用域内");
  return api;
}

export function useWorkspaceToolEvents(toolId: string) {
  const host = useWorkspaceHost();
  return {
    drain: () => host.drainToolEvents(toolId)
  };
}
