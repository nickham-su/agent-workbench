import type { WebPendingAgentRunKind } from "./agentPendingRunRegistry.js";

export type PendingRunRegistrar = {
  register(input: { workspaceId: string; sessionId: string; runKind: WebPendingAgentRunKind; runId: string }): void;
};

/** 所有返回 runId 的发送入口必须在此明确绑定持久化 runKind。 */
export function registerPendingAgentRun(
  registrar: PendingRunRegistrar,
  input: { workspaceId: string; sessionId: string; runId: string; runKind: WebPendingAgentRunKind },
) {
  registrar.register(input);
}
