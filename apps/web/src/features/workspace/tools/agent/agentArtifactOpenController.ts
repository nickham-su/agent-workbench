import type {
  AgentArtifactRequestScope,
  AgentArtifactRequest,
} from "./agentArtifactRequestGuard";

export type AgentArtifactRequestGuard = {
  begin(): AgentArtifactRequest;
  isCurrent(scope: AgentArtifactRequestScope): boolean;
};

/**
 * 卡片实际使用的 artifact 请求接线：只有发起请求时的卡片 scope 仍有效，才允许
 * 成功结果打开编辑器或将异常呈现给用户。scope 已变更/已卸载时，包括普通异常在内
 * 的所有晚到结果均静默丢弃。
 */
export async function runAgentArtifactOpenRequest<T>(input: {
  guard: AgentArtifactRequestGuard;
  fetchArtifact: (request: AgentArtifactRequest) => Promise<T>;
  onArtifact: (artifact: T) => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  const request = input.guard.begin();
  try {
    const artifact = await input.fetchArtifact(request);
    if (!input.guard.isCurrent(request.scope)) return false;
    await input.onArtifact(artifact);
    return true;
  } catch (error) {
    if (input.guard.isCurrent(request.scope)) input.onError(error);
    return false;
  }
}
