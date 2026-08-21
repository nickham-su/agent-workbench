import type { AgentControlResult, AgentSessionRunState } from "@agent-workbench/shared";
import type { AgentApiRunCompleteRequest, AgentApiRunStateRequest } from "@agent-workbench/shared/internal-contracts/agent-api";

export type AgentRuntimeRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

export type RuntimeControlPort = {
  enqueueRun(run: AgentRuntimeRun): void | Promise<void>;
  cancelSession(sessionId: string): void | Promise<void>;
};

export type WorkspaceRunContext = {
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

export type WorkspaceRunContextReader = {
  get(workspaceId: string): WorkspaceRunContext | null;
};

export type ActiveSubtaskChildQuery = {
  listByParentRun(params: { workspaceId: string; sessionId: string; runId: string }): string[];
};

export type PromptStaticCacheInvalidator = {
  clear(runId: string): void;
};

export type RunCompletedEventPublisher = {
  publishRunCompleted(event: {
    eventId: string;
    occurredAt: number;
    workspaceId: string;
    sessionId: string;
    runId: string;
    finalStatus: "completed" | "failed" | "cancelled";
  }): void;
};

/**
 * P3's sole activation transaction capability. It deliberately represents
 * lifecycle outcomes rather than exposing Store or AppContext operations.
 */
export type AtomicLifecyclePersistence = {
  activateUserRun(input: UserRunActivationInput): UserRunActivationResult;
  failRunAfterEnqueueFailureIfCurrent(input: EnqueueFailureInput): EnqueueFailureSettlement;
  getCancelSessionSnapshot(sessionId: string): CancelSessionSnapshot | null;
  cancelSessions(input: CancelSessionsInput): CancelSessionsResult;
  updateRunStateFromWorker(input: AgentApiRunStateRequest): void;
  completeRunFromWorker(input: AgentApiRunCompleteRequest): boolean;
  listRecoverableRunCandidates(): RecoveryCandidate[];
  isRecoverableRunCandidate(candidate: RecoveryCandidate): boolean;
  failNonTerminalContextItemsForRecovery(input: RecoveryCandidate & { updatedAt: number }): number;
  failRunRecordForRecovery(input: RecoveryCandidate & { updatedAt: number }): number;
  reclaimRunStateForRecovery(input: RecoveryCandidate & { updatedAt: number }): number;
  appendRecoveryFailureNotice(input: RecoveryCandidate & { text: string; createdAt: number }): void;
  listInFlightSessionsWithoutActiveRunId(): RecoveryDirtySession[];
  reclaimDirtyRunStateForRecovery(input: RecoveryDirtySession & { updatedAt: number }): number;
};

export type RecoveryCandidate = { workspaceId: string; sessionId: string; runId: string; triggerItemId: number | null };
export type RecoveryDirtySession = { workspaceId: string; sessionId: string };

export type CancelSessionSnapshot = {
  sessionId: string;
  workspaceId: string;
  session: AgentControlResult["session"];
  runState: Pick<AgentSessionRunState, "status" | "activeRunId">;
};

export type CancelSessionsInput = {
  workspaceId: string;
  rootSessionId: string;
  updatedAt: number;
  listActiveChildSessionIds(params: { workspaceId: string; sessionId: string; runId: string }): string[];
};

export type CancelSessionsResult = {
  rootSessionId: string;
  runtimeCancelSessionIds: string[];
  cancelledRunIds: string[];
};

export type CancelSessionCascadeResult = {
  result: AgentControlResult;
  runtimeCancelSessionIds: string[];
};

export type UserRunActivationInput = {
  workspaceId: string;
  sessionId: string;
  clientRequestId: string;
  text: string;
  runId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: "zh-CN" | "en-US" | null;
  createdAt: number;
};

export type UserRunActivationResult =
  | {
      kind: "deduplicated";
      messageItemId: number;
      runId: string;
    }
  | {
      kind: "session-running";
    }
  | {
      kind: "activated";
      messageItemId: number;
      runId: string;
    };

export type EnqueueFailureInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  updatedAt: number;
};

export type EnqueueFailureSettlement =
  | "failed-and-idled"
  | "run-failed-state-not-current"
  | "already-terminal"
  | "missing-or-mismatch";

export type StartUserRunCommand = {
  workspaceId: string;
  sessionId: string;
  clientRequestId: string;
  text: string;
  inputText: string;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: "zh-CN" | "en-US" | null;
  runtime: RuntimeControlPort;
};

export type LifecycleClock = {
  nowMs(): number;
};

export type LifecycleIdGenerator = {
  newId(prefix: string): string;
};

export type TriggerInputReader = {
  getUserText(itemId: number): string | null;
};

export type LifecycleLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
  debug?(bindings: Record<string, unknown>, message: string): void;
};

export type RunLifecycleApplicationDependencies = {
  workspaceRunContextReader: WorkspaceRunContextReader;
  runStateReader: { get(sessionId: string): AgentSessionRunState };
  activeSubtaskChildQuery: ActiveSubtaskChildQuery;
  promptStaticCacheInvalidator: PromptStaticCacheInvalidator;
  runCompletedEventPublisher: RunCompletedEventPublisher;
  persistence: AtomicLifecyclePersistence;
  triggerInputReader: TriggerInputReader;
  isContextAppendConflict(error: unknown): boolean;
  clock: LifecycleClock;
  ids: LifecycleIdGenerator;
  logger: LifecycleLogger;
};

export type CancelSessionCommand = { sessionId: string; workspaceId: string; runtime: RuntimeControlPort };

/**
 * `beforeFinalCheck` is a controlled test/timing hook for exercising the
 * recovery fence. It is not a general-purpose business extension point;
 * production startup wiring must not provide it.
 */
export type RecoverRunsOnStartupCommand = {
  runtime: RuntimeControlPort;
  beforeFinalCheck?: (candidate: RecoveryCandidate) => void | Promise<void>;
};
