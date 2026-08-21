import type {
  AgentContextItemRecord,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentUiLocale,
} from "@agent-workbench/shared";
import type {
  AgentApiSubtaskPreforkPlanRequest,
  AgentApiSubtaskPreforkPlanResponse,
  AgentApiSubtaskResultRequest,
  AgentApiSubtaskResultResponse,
  AgentApiSubtaskStartRequest,
  AgentApiSubtaskStartResponse,
  AgentApiSubtaskStatusRequest,
  AgentApiSubtaskStatusResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";

export type SubtaskRunRecord = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerItemId: number;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: AgentUiLocale | null;
  subtaskDepth: number | null;
  parentRunId: string | null;
  parentToolItemId: number | null;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

/** The only Subtask capability consumed by Run Lifecycle. */
export type ActiveSubtaskChildQuery = {
  listByParentRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }): string[];
};

export type SubtaskParentAnchor = {
  parentSession: AgentSessionRecord;
  parentRun: SubtaskRunRecord;
  parentUiLocale: AgentUiLocale | null;
  anchor: AgentContextItemRecord;
};

export type SubtaskParentAnchorReader = {
  resolve(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
  }): SubtaskParentAnchor;
};

export type SubtaskLineagePersistence = {
  findChildByParentTool(input: {
    workspaceId: string;
    parentRunId: string;
    parentToolItemId: number;
  }): SubtaskRunRecord | null;
  isParentToolUniqueConflict(error: unknown): boolean;
};

export type SubtaskSessionMaterializer = {
  resolveForStart(input: {
    workspaceId: string;
    parentSessionId: string;
    parentToolItemId: number;
    session: AgentApiSubtaskStartRequest["session"];
    subtaskTitleBase: string;
    forkBoundaryItemId: number | null;
    shouldUsePreforkSummary: boolean;
  }): Promise<{ session: AgentSessionRecord; createdSessionId: string | null }>;
  resolveForkBoundary(input: {
    workspaceId: string;
    sessionId: string;
    anchor: AgentContextItemRecord;
  }): number | null;
};

export type SubtaskExecutionProfile = {
  agentId: string;
  agentName: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
};

export type SubtaskExecutionProfileReader = {
  resolve(input: {
    workspaceId: string;
    requestedAgentId: string;
  }): SubtaskExecutionProfile;
  findAgentName(agentId: string): string | null;
  getMaxDepth(): number;
};

export type SubtaskWorkspaceReader = {
  get(workspaceId: string): { path: string } | null;
};

export type ParentRunStateReader = {
  get(
    workspaceId: string,
    sessionId: string,
  ): Pick<AgentSessionRunState, "status" | "lastResponseTotalTokens">;
};

export type SubtaskChildActivationInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  parentRunId: string;
  parentToolItemId: number;
  subtaskDepth: number;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: AgentUiLocale | null;
  createdAt: number;
  seedItems: Array<
    | { kind: "system"; text: string; attachToRun: false }
    | { kind: "user"; text: string; attachToRun: true }
  >;
};

export type SubtaskChildActivationResult =
  { kind: "activated"; promptItemId: number } | { kind: "session-running" };

/** Implemented by Lifecycle-owned SQLite persistence; never enqueues runtime work. */
export type SubtaskChildRunActivator = {
  activate(input: SubtaskChildActivationInput): SubtaskChildActivationResult;
};

/** Owns ownership-fenced durable run and visible-item reads for P4 queries. */
export type SubtaskRunQuery = {
  findSession(sessionId: string): AgentSessionRecord | null;
  findRunInSession(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }): SubtaskRunRecord | null;
  listVisibleItemsByRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }): AgentContextItemRecord[];
};

/** P3 owns the invocation condition; P4 only refines adapter naming/export boundaries. */
export type SubtaskLocalCompensationPersistence = {
  deleteNewSessionIfStillEmpty(input: {
    workspaceId: string;
    sessionId: string;
  }): boolean;
};

export type SubtaskOrphanCandidate = {
  workspaceId: string;
  sessionId: string;
  createdAt: number;
  forkedFromSessionId: string | null;
  forkedFromItemId: number | null;
};

/** P5 owns the orphan startup policy and invocation. */
export type SubtaskOrphanPersistence = {
  listSuspects(input: { olderThan: number }): SubtaskOrphanCandidate[];
  deleteSuspectIfStillEligible(input: {
    workspaceId: string;
    sessionId: string;
    olderThan: number;
  }): boolean;
};

export type CleanupSubtaskOrphansOnStartupCommand = {
  /** Test-only time override; production callers use the injected clock. */
  now?: number;
};

export type CleanupSubtaskOrphansOnStartupResult = {
  scanned: number;
  retained: number;
  deleted: number;
  skippedAfterRecheck: number;
  failed: number;
};

export type SubtaskClock = { nowMs(): number };
export type SubtaskIdGenerator = { newId(prefix: string): string };
export type SubtaskLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
};

export type SubtaskForkGuardTextReader = {
  get(uiLocale: AgentUiLocale | null): string;
};

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
  getPreforkPlan(
    request: AgentApiSubtaskPreforkPlanRequest,
  ): AgentApiSubtaskPreforkPlanResponse;
  startSubtask(
    request: AgentApiSubtaskStartRequest,
  ): Promise<AgentApiSubtaskStartResponse>;
  getResult(request: AgentApiSubtaskResultRequest): AgentApiSubtaskResultResponse;
  getStatus(request: AgentApiSubtaskStatusRequest): AgentApiSubtaskStatusResponse;
  cleanupOrphansOnStartup(
    command?: CleanupSubtaskOrphansOnStartupCommand,
  ): CleanupSubtaskOrphansOnStartupResult;
};
