import type { InjectionKey, ComputedRef } from "vue";
import { inject } from "vue";
import type { GitStatusResponse, GitTarget, WorkspaceDetail } from "@agent-workbench/shared";

export type WorkspaceRepoInfo = WorkspaceDetail["repos"][number];

export type WorkspaceContext = {
  repos: ComputedRef<WorkspaceDetail["repos"]>;
  currentRepo: ComputedRef<WorkspaceRepoInfo | null>;
  currentTarget: ComputedRef<GitTarget | null>;
  setCurrentRepo: (dirName: string) => void;
  statusByDirName: Record<string, GitStatusResponse | null>;
};

export const workspaceContextKey: InjectionKey<WorkspaceContext> = Symbol("agent-workbench.workspace.context");

export function useWorkspaceContext() {
  const ctx = inject(workspaceContextKey, null);
  if (!ctx) throw new Error("WorkspaceContext 未提供：请确认组件处于 WorkspaceLayout 作用域内");
  return ctx;
}
