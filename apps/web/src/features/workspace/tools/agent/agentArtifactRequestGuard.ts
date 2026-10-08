export type AgentArtifactRequestScope = {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  generation: number;
};

export type AgentArtifactRequest = {
  scope: AgentArtifactRequestScope;
  signal: AbortSignal;
  finish: () => void;
};

/** 卡片卸载或 props scope 变化后，晚到 artifact 响应不可再打开宿主编辑器。 */
export function createAgentArtifactRequestGuard(initial: Omit<AgentArtifactRequestScope, "generation">) {
  let disposed = false;
  let generation = 0;
  let scope: AgentArtifactRequestScope = { ...initial, generation };
  const controllers = new Set<AbortController>();

  function abortAll() {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  function sameScope(left: AgentArtifactRequestScope, right: AgentArtifactRequestScope) {
    return (
      left.workspaceId === right.workspaceId &&
      left.sessionId === right.sessionId &&
      left.executionId === right.executionId &&
      left.generation === right.generation
    );
  }

  return {
    begin(): AgentArtifactRequest {
      const controller = new AbortController();
      controllers.add(controller);
      return { scope, signal: controller.signal, finish: () => controllers.delete(controller) };
    },
    isCurrent(request: AgentArtifactRequestScope) {
      return !disposed && sameScope(scope, request);
    },
    update(next: Omit<AgentArtifactRequestScope, "generation">) {
      if (
        next.workspaceId === scope.workspaceId &&
        next.sessionId === scope.sessionId &&
        next.executionId === scope.executionId
      )
        return;
      abortAll();
      generation += 1;
      scope = { ...next, generation };
    },
    dispose() {
      disposed = true;
      generation += 1;
      abortAll();
    },
  };
}
