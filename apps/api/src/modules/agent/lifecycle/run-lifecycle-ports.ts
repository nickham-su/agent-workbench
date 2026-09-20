import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentMessageControlResult, AgentMessageSessionRunState } from "@agent-workbench/shared";
import type { AgentRunExecutionPhase, AgentRunKind, AgentTerminalResultCode, AgentTerminalRunStatus } from "@agent-workbench/shared";
import type { ActiveSubtaskChildQuery } from "../subtask/subtask-ports.js";

export type AgentRuntimeRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  runKind?: AgentRunKind;
  inputText?: string;
  resumeAssistantMessageId?: string | null;
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

export type RuntimeControlPort = {
  enqueueRun(run: AgentRuntimeRun): void | Promise<void>;
  cancelSession(sessionId: string): void | Promise<void>;
  /** 删除工作区时使用的窄 drain 能力；普通用户取消不需要等待。 */
  cancelSessionAndWait?(input: {
    sessionId: string;
    timeoutMs: number;
  }): Promise<boolean>;
};

export type WorkspaceRunContext = {
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

export type WorkspaceRunContextReader = {
  get(workspaceId: string): WorkspaceRunContext | null;
};

export type { ActiveSubtaskChildQuery } from "../subtask/subtask-ports.js";

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
  listActiveSessionIdsForCancel(input: CancelSessionsInput): string[];
  activateUserRun(input: UserRunActivationInput): UserRunActivationResult;
  canEnqueueUserRunIfCurrent(input: { workspaceId: string; sessionId: string; runId: string }): boolean;
  failRunAfterEnqueueFailureIfCurrent(input: EnqueueFailureInput): EnqueueFailureSettlement;
  getCancelSessionSnapshot(sessionId: string): CancelSessionSnapshot | null;
  cancelSessions(input: CancelSessionsInput): CancelSessionsResult;
  markRunWorkInProgress(input: TerminalControlInput): "updated" | "already_in_progress";
  persistRunTerminalIntent(input: TerminalIntentControlInput): "updated" | "already_persisted";
  convergeRunTerminal(input: TerminalControlInput): { kind: "transitioned" | "already_converged"; finalStatus: AgentTerminalRunStatus };
  listWorkspaceRunningRunCandidates(workspaceId: string): WorkspaceRunningRunCandidate[];
  listRecoverableRunCandidates(): RecoveryCandidate[];
  isRecoverableRunCandidate(candidate: RecoveryCandidate): boolean;
};

export type TerminalControlInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  updatedAt: number;
};

export type TerminalIntentControlInput = TerminalControlInput & {
  status: AgentTerminalRunStatus;
  code: AgentTerminalResultCode;
  detail: null;
};

export type WorkspaceRunningRunCandidate = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  executionPhase: AgentRunExecutionPhase;
};

export type RecoveryCandidate = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  runKind: AgentRunKind;
  triggerMessageId: string | null;
  executionPhase: AgentRunExecutionPhase;
};

export type CancelSessionSnapshot = {
  sessionId: string;
  workspaceId: string;
  session: AgentMessageControlResult["session"];
  runState: Pick<AgentMessageSessionRunState, "status" | "activeRunId">;
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
  terminalIntents?: Array<{ workspaceId: string; sessionId: string; runId: string }>;
};

export type CancelSessionCascadeResult = {
  result: AgentMessageControlResult;
  runtimeCancelSessionIds: string[];
};

export type UserRunActivationInput = {
  workspaceId: string;
  sessionId: string;
  clientRequestId: string;
  text: string;
  images: UserRunImageInput[];
  runId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: "zh-CN" | "en-US" | null;
  createdAt: number;
};

export type UserRunImageInput = {
  attachmentId: string;
  storageKey: string;
  tempId: string;
  filename: string;
  mediaType: AgentImageMediaType;
  byteSize: number;
  position: number;
};

export type UserRunActivationResult =
  | {
      kind: "deduplicated";
      messageId: string;
      runId: string;
    }
  | {
      kind: "session-running";
    }
  | {
      kind: "activated";
      messageId: string;
      runId: string;
    };

export type EnqueueFailureInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  updatedAt: number;
};

export type EnqueueFailureSettlement =
  | "intent-persisted"
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
  images?: UserRunImageInput[];
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
  getUserText(messageId: string): string | null;
};

export type LifecycleLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
  debug?(bindings: Record<string, unknown>, message: string): void;
};

export type SessionRuntimeHandoffCoordinatorPort = {
  runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  runExclusiveMany<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T>;
};

export type RunLifecycleApplicationDependencies = {
  workspaceRunContextReader: WorkspaceRunContextReader;
  runStateReader: { get(sessionId: string): AgentMessageSessionRunState };
  activeSubtaskChildQuery: ActiveSubtaskChildQuery;
  promptStaticCacheInvalidator: PromptStaticCacheInvalidator;
  runCompletedEventPublisher: RunCompletedEventPublisher;
  persistence: AtomicLifecyclePersistence;
  attachmentCommitter?: {
    commit(input: { workspaceId: string; image: UserRunImageInput }): Promise<void>;
    removeTemp(input: Pick<UserRunImageInput, "tempId">): Promise<void>;
    removeFinal(input: { workspaceId: string; image: Pick<UserRunImageInput, "attachmentId"> }): Promise<void>;
  };
  triggerInputReader: TriggerInputReader;
  isContextAppendConflict(error: unknown): boolean;
  runtimeHandoffCoordinator: SessionRuntimeHandoffCoordinatorPort;
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
