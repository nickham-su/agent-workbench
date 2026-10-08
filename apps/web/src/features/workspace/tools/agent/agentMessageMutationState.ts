import { ref } from "vue";
import { createAgentMessageMutationGuard } from "./agentMessageMutationGuard";

/** AgentClientPane 使用的响应式 Session 级 Fork/Revert 互斥状态。 */
export function createAgentMessageMutationState() {
  const guard = createAgentMessageMutationGuard();
  const pendingSessionIds = ref(new Set<string>());

  function setPending(sessionId: string, pending: boolean) {
    const next = new Set(pendingSessionIds.value);
    if (pending) next.add(sessionId);
    else next.delete(sessionId);
    pendingSessionIds.value = next;
  }

  return {
    pendingSessionIds,
    begin(sessionId: string) {
      if (!guard.begin(sessionId)) return false;
      setPending(sessionId, true);
      return true;
    },
    end(sessionId: string) {
      guard.end(sessionId);
      setPending(sessionId, false);
    },
    isPending(sessionId: string) {
      return pendingSessionIds.value.has(sessionId);
    },
    clear() {
      guard.clear();
      pendingSessionIds.value = new Set();
    },
  };
}
