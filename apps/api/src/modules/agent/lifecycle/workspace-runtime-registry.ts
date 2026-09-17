import type { AgentRuntimePort } from "../agent.runtime-port.js";
import type { SessionRuntimeHandoffCoordinatorPort } from "./run-lifecycle-ports.js";

/**
 * Workspace 删除路由与 Agent 模块的极窄运行时桥接。
 * Agent 模块在启动后注册唯一运行时和 handoff 协调器。删除需要两者来保证
 * DB-first cancel 与 runtime drain 不会和同 Session 的 enqueue 发生网络重排。
 */
export type WorkspaceRuntimeRegistration = {
  runtime: Pick<AgentRuntimePort, "cancelSessionAndWait">;
  handoffCoordinator: SessionRuntimeHandoffCoordinatorPort;
};

let registration: WorkspaceRuntimeRegistration | null = null;

export function registerWorkspaceRuntime(next: WorkspaceRuntimeRegistration) {
  registration = next;
}

export function unregisterWorkspaceRuntime(next: WorkspaceRuntimeRegistration) {
  if (registration === next) registration = null;
}

export function getWorkspaceRuntime() {
  return registration;
}
