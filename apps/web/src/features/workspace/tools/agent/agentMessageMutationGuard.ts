/** Fork/Revert 的最小前端互斥：同一 Session 的结构 mutation 只允许一个在途请求。 */
export function createAgentMessageMutationGuard() {
  const pending = new Set<string>();

  return {
    begin(sessionId: string) {
      if (pending.has(sessionId)) return false;
      pending.add(sessionId);
      return true;
    },
    end(sessionId: string) {
      pending.delete(sessionId);
    },
    isPending(sessionId: string) {
      return pending.has(sessionId);
    },
    clear() {
      pending.clear();
    },
  };
}
