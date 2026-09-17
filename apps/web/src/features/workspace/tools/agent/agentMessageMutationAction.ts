import type { createAgentMessageMutationState } from "./agentMessageMutationState";

type AgentMessageMutationState = ReturnType<typeof createAgentMessageMutationState>;

/**
 * Fork/Revert 共用的 Session 结构 mutation 编排。无论请求或结构 snapshot 最终失败，
 * finally 都必须释放响应式 pending 状态，避免控件永久 disabled。
 */
export async function runAgentSessionMessageMutation(input: {
  state: AgentMessageMutationState;
  sessionId: string;
  mutate: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  if (!input.state.begin(input.sessionId)) return false;
  try {
    await input.mutate();
    return true;
  } catch (error) {
    input.onError(error);
    return false;
  } finally {
    input.state.end(input.sessionId);
  }
}
