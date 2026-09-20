import type { AgentRunStatusResponse } from "@agent-workbench/shared";
import {
  type PendingRunPollCoordinator,
  type SessionStorageLike,
  type WebPendingAgentRunKind,
  createAgentPendingRunRegistry,
  pollPendingAgentRuns,
  subscribePendingRunScope,
} from "./agentPendingRunRegistry.js";

export type PendingRunScope = {
  workspaceId: string;
  sessionId: string;
};

const RUNNING_POLL_INTERVAL_MS = 1_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * 管理单个 Pane 的 pending Run 恢复生命周期。registry 和轮询协调器保持独立：
 * 前者是 sessionStorage 的持久记录，后者负责同标签页多 Pane 去重。
 */
export function createAgentPendingRunController(params: {
  registry: ReturnType<typeof createAgentPendingRunRegistry>;
  fetchRun: (input: PendingRunScope & { runId: string }) => Promise<AgentRunStatusResponse>;
  onTerminal: (run: AgentRunStatusResponse) => void;
  onStale: () => void;
  coordinator?: PendingRunPollCoordinator;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}) {
  const now = params.now ?? (() => Date.now());
  const setTimer = params.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = params.clearTimer ?? ((timer) => clearTimeout(timer));
  let scope: PendingRunScope | null = null;
  let generation = 0;
  let timer: TimerHandle | null = null;
  let polling = false;
  let pollRequested = false;
  let unsubscribeScope: (() => void) | null = null;

  function isCurrent(expectedScope: PendingRunScope, expectedGeneration: number) {
    return scope?.workspaceId === expectedScope.workspaceId
      && scope.sessionId === expectedScope.sessionId
      && generation === expectedGeneration;
  }

  function clearScheduledPoll() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    clearScheduledPoll();
    if (!scope) return;
    const records = params.registry.list(scope.workspaceId, scope.sessionId);
    if (records.length === 0) return;
    const currentTime = now();
    const nextAttemptAt = Math.min(...records.map((item) => item.nextAttemptAt ?? currentTime + RUNNING_POLL_INTERVAL_MS));
    const expectedScope = scope;
    const expectedGeneration = generation;
    timer = setTimer(() => {
      timer = null;
      if (isCurrent(expectedScope, expectedGeneration)) void pollNow();
    }, Math.max(0, nextAttemptAt - currentTime));
  }

  function requestPoll() {
    if (!scope) return;
    if (polling) {
      pollRequested = true;
      return;
    }
    void pollNow();
  }

  async function pollNow() {
    if (!scope || polling) return;
    const expectedScope = scope;
    const expectedGeneration = generation;
    polling = true;
    try {
      await pollPendingAgentRuns({
        registry: params.registry,
        workspaceId: expectedScope.workspaceId,
        sessionId: expectedScope.sessionId,
        fetchRun: (runId) => params.fetchRun({ ...expectedScope, runId }),
        onTerminal: (run) => {
          if (!isCurrent(expectedScope, expectedGeneration)) return false;
          params.onTerminal(run);
          return true;
        },
        onStale: () => {
          if (!isCurrent(expectedScope, expectedGeneration)) return false;
          params.onStale();
          return true;
        },
        coordinator: params.coordinator,
        now,
      });
    } finally {
      polling = false;
      // 旧 scope 在途时切换到新 scope，或旧 registry 晚登记时，必须优先补跑当前 scope。
      if (scope && pollRequested) {
        pollRequested = false;
        void pollNow();
      } else if (isCurrent(expectedScope, expectedGeneration)) {
        schedule();
      }
    }
  }

  return {
    start(nextScope: PendingRunScope) {
      generation += 1;
      scope = nextScope;
      unsubscribeScope?.();
      unsubscribeScope = subscribePendingRunScope(nextScope.workspaceId, nextScope.sessionId, requestPoll);
      clearScheduledPoll();
      requestPoll();
    },
    stop() {
      generation += 1;
      scope = null;
      pollRequested = false;
      unsubscribeScope?.();
      unsubscribeScope = null;
      clearScheduledPoll();
    },
    register(input: PendingRunScope & { runKind: WebPendingAgentRunKind; runId: string }) {
      params.registry.register(input);
    },
    pollNow,
    isPolling: () => polling,
  };
}

export type AgentPendingRunRegistry = ReturnType<typeof createAgentPendingRunRegistry>;
export type AgentPendingRunStorage = SessionStorageLike;
