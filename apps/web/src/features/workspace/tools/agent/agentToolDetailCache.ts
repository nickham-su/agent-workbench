import type { AgentTimelineToolExecution, AgentToolExecution } from "@agent-workbench/shared";

export type AgentToolDetailRequestToken = {
  executionId: string;
  sequence: number;
  visibleRevision: number;
};

/**
 * Detail 是 timeline 高频状态的按需补充。timeline 只要提升某 execution revision，
 * 旧 detail 就不再可用；同 execution 的乱序响应由 sequence 拒绝。
 */
export function createAgentToolDetailCache() {
  let requestSequence = 0;
  const latestRequestByExecutionId = new Map<string, number>();
  let visibleByExecutionId = new Map<string, AgentTimelineToolExecution>();

  function visibleRevision(executionId: string) {
    return visibleByExecutionId.get(executionId)?.updatedRevision ?? null;
  }

  return {
    syncTimeline(executions: readonly AgentTimelineToolExecution[]) {
      const next = new Map(executions.map((execution) => [execution.id, execution]));
      const invalidated = new Set<string>();
      for (const [id, previous] of visibleByExecutionId) {
        const current = next.get(id);
        if (!current || current.updatedRevision > previous.updatedRevision) invalidated.add(id);
      }
      visibleByExecutionId = next;
      return invalidated;
    },
    markTimelineReset(executions: readonly AgentTimelineToolExecution[]) {
      latestRequestByExecutionId.clear();
      visibleByExecutionId = new Map(
        executions.map((execution) => [execution.id, execution]),
      );
    },
    begin(executionId: string): AgentToolDetailRequestToken | null {
      const revision = visibleRevision(executionId);
      if (revision === null) return null;
      const token = {
        executionId,
        sequence: ++requestSequence,
        visibleRevision: revision,
      };
      latestRequestByExecutionId.set(executionId, token.sequence);
      return token;
    },
    accepts(token: AgentToolDetailRequestToken, detail: AgentToolExecution) {
      return (
        latestRequestByExecutionId.get(token.executionId) === token.sequence &&
        visibleRevision(token.executionId) === token.visibleRevision &&
        detail.id === token.executionId &&
        detail.updatedRevision >= token.visibleRevision
      );
    },
    forget(executionId: string) {
      latestRequestByExecutionId.delete(executionId);
    },
    reset() {
      latestRequestByExecutionId.clear();
      visibleByExecutionId.clear();
    },
  };
}
