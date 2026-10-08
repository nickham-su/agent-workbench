import type { WebPendingAgentRunKind } from "./agentPendingRunRegistry.js";

export type PendingRunRegistrar = {
  register(input: { workspaceId: string; sessionId: string; runKind: WebPendingAgentRunKind; runId: string }): void;
};

export type RunStatePollHint = {
  bumpPollHint(sessionId: string, opts: { immediate: true; warmup: true }): void;
};

/** 所有返回 runId 的发送入口必须在此明确绑定持久化 runKind。 */
export function registerPendingAgentRun(
  registrar: PendingRunRegistrar,
  input: { workspaceId: string; sessionId: string; runId: string; runKind: WebPendingAgentRunKind },
  runStatePollHint?: RunStatePollHint,
) {
  registrar.register(input);
  runStatePollHint?.bumpPollHint(input.sessionId, { immediate: true, warmup: true });
}
