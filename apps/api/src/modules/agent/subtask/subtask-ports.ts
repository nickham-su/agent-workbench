import type { AgentUiLocale } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type {
  AgentApiSubtaskPreforkPlanRequest,
  AgentApiSubtaskPreforkPlanResponse,
  AgentApiSubtaskResultRequest,
  AgentApiSubtaskResultResponse,
  AgentApiSubtaskStartRequest,
  AgentApiSubtaskStartResponse,
  AgentApiSubtaskStatusRequest,
  AgentApiSubtaskStatusResponse
} from "@agent-workbench/shared/internal-contracts/agent-api";

export type SubtaskRunRecord = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerMessageId: string | null;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: AgentUiLocale | null;
  subtaskDepth: number | null;
  parentRunId: string | null;
  parentToolExecutionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

export type SubtaskSession = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  headMessageId: string | null;
  forkedFromSessionId: string | null;
  forkedFromMessageId: string | null;
  revision: number;
};

/** The only Subtask capability consumed by Run Lifecycle. */
export type ActiveSubtaskChildQuery = {
  listByParentRun(input: { workspaceId: string; sessionId: string; runId: string }): string[];
};

export type SubtaskParentAnchor = {
  parentSession: SubtaskSession;
  parentRun: SubtaskRunRecord;
  parentUiLocale: AgentUiLocale | null;
  anchor: {
    toolExecutionId: string;
    assistantMessageId: string;
  };
};

export type SubtaskParentAnchorReader = {
  resolve(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolExecutionId: string;
  }): SubtaskParentAnchor;
};

export type SubtaskLineagePersistence = {
  findChildByParentToolExecution(input: {
    workspaceId: string;
    parentRunId: string;
    parentToolExecutionId: string;
  }): SubtaskRunRecord | null;
};

export type SubtaskSessionMaterializer = {
  resolveForStart(input: {
    workspaceId: string;
    parentSessionId: string;
    parentToolExecutionId: string;
    session: AgentApiSubtaskStartRequest["session"];
    subtaskTitleBase: string;
    forkBoundaryMessageId: string | null;
    shouldUsePreforkSummary: boolean;
  }): Promise<{ session: SubtaskSession; createdSessionId: string | null }>;
  resolveForkBoundary(input: {
    workspaceId: string;
    sessionId: string;
    assistantMessageId: string;
  }): string | null;
};

export type SubtaskExecutionProfile = {
  agentId: string;
  agentName: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
};

export type SubtaskExecutionProfileReader = {
  resolve(input: { workspaceId: string; requestedAgentId: string }): SubtaskExecutionProfile;
  findAgentName(agentId: string): string | null;
  getMaxDepth(): number;
};

export type SubtaskWorkspaceReader = { get(workspaceId: string): { path: string } | null };
export type ParentRunStateReader = {
  get(workspaceId: string, sessionId: string): { status: "idle" | "running"; lastResponseTotalTokens: number | null };
};

export type SubtaskChildActivationInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  parentRunId: string;
  parentToolExecutionId: string;
  subtaskDepth: number;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: AgentUiLocale | null;
  createdAt: number;
  systemTexts: string[];
  prompt: string;
};
export type SubtaskChildActivationResult =
  | { kind: "activated"; promptMessageId: string }
  | { kind: "session-running" }
  | { kind: "parent-not-active" };
export type SubtaskChildRunActivator = { activate(input: SubtaskChildActivationInput): SubtaskChildActivationResult };

/** Owns ownership-fenced durable run and Message reads for subtask result/status. */
export type SubtaskRunMessageText = {
  type: "assistant" | "system";
  text: string;
};
export type SubtaskRunQuery = {
  findSession(sessionId: string): SubtaskSession | null;
  findRunInSession(input: { workspaceId: string; sessionId: string; runId: string }): SubtaskRunRecord | null;
  listMessageTextsByRun(input: { workspaceId: string; sessionId: string; runId: string }): SubtaskRunMessageText[];
};

export type SubtaskLocalCompensationPersistence = {
  deleteCreatedSessionIfStillSafe(input: {
    workspaceId: string;
    createdSessionId: string;
    expectedParentSessionId: string;
    expectedForkedFromSessionId: string | null;
    expectedForkedFromMessageId: string | null;
  }): boolean;
};
export type SubtaskOrphanCandidate = {
  workspaceId: string;
  sessionId: string;
  createdAt: number;
  forkedFromSessionId: string | null;
  forkedFromMessageId: string | null;
};
export type SubtaskOrphanPersistence = {
  listSuspects(input: { olderThan: number }): SubtaskOrphanCandidate[];
  deleteSuspectIfStillEligible(input: { workspaceId: string; sessionId: string; olderThan: number }): boolean;
};
export type CleanupSubtaskOrphansOnStartupCommand = { now?: number };
export type CleanupSubtaskOrphansOnStartupResult = { scanned: number; retained: number; deleted: number; skippedAfterRecheck: number; failed: number };
export type SubtaskClock = { nowMs(): number };
export type SubtaskIdGenerator = { newId(prefix: string): string };
export type SubtaskLogger = { warn(bindings: Record<string, unknown>, message: string): void; error(bindings: Record<string, unknown>, message: string): void };
export type SubtaskForkGuardTextReader = { get(uiLocale: AgentUiLocale | null): string };

export type SubtaskApplicationDependencies = {
  parentAnchorReader: SubtaskParentAnchorReader;
  lineagePersistence: SubtaskLineagePersistence;
  sessionMaterializer: SubtaskSessionMaterializer;
  executionProfileReader: SubtaskExecutionProfileReader;
  workspaceReader: SubtaskWorkspaceReader;
  parentRunStateReader: ParentRunStateReader;
  childRunActivator: SubtaskChildRunActivator;
  runQuery: SubtaskRunQuery;
  localCompensationPersistence: SubtaskLocalCompensationPersistence;
  orphanPersistence: SubtaskOrphanPersistence;
  clock: SubtaskClock;
  ids: SubtaskIdGenerator;
  logger: SubtaskLogger;
  forkGuardTextReader: SubtaskForkGuardTextReader;
};

export type SubtaskApplicationPort = {
  getPreforkPlan(request: AgentApiSubtaskPreforkPlanRequest): AgentApiSubtaskPreforkPlanResponse;
  startSubtask(request: AgentApiSubtaskStartRequest): Promise<AgentApiSubtaskStartResponse>;
  getResult(request: AgentApiSubtaskResultRequest): AgentApiSubtaskResultResponse;
  getStatus(request: AgentApiSubtaskStatusRequest): AgentApiSubtaskStatusResponse;
  cleanupOrphansOnStartup(command?: CleanupSubtaskOrphansOnStartupCommand): CleanupSubtaskOrphansOnStartupResult;
};
