import type {
  AgentContextItemRecord,
  AgentControlResult,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentUiLocale,
} from "@agent-workbench/shared";
import type {
  AgentApiCompactContextRequest,
  AgentApiCompactContextResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ArchiveWriteSnapshot } from "../archive/archive-storage.js";

export type CompactionArchiveRunRecord = {
  runId: string;
  workspaceId: string;
  sessionId: string;
};

export type CompactionArchiveRunState = {
  status: string;
  activeRunId: string | null;
};

export type CompactionArchiveSessionQuery = {
  get(sessionId: string): AgentSessionRecord | null;
  getRun(runId: string): CompactionArchiveRunRecord | null;
  getVisibleItems(workspaceId: string, sessionId: string): AgentContextItemRecord[];
  getLatestItemId(workspaceId: string, sessionId: string): number;
};

/** Keeps the summary insertion, archive marking and head CAS inside one transaction. */
export type CompactionArchivePersistence = {
  appendSummaryAndArchiveItems(command: {
    workspaceId: string;
    sessionId: string;
    runId: string | null;
    expectedHeadItemId: number | null;
    summaryText: string;
    boundaryReason: "compaction" | "clear";
    summaryCreatedAt: number;
    archiveItemIds: number[];
    archiveAt: number;
  }): { summaryItemId: number; archivedCount: number };
};

export type CompactionArchiveStorage = {
  appendLines(params: {
    operation: "compaction" | "clear";
    workspaceId: string;
    sessionId: string;
    lines: string[];
  }): Promise<ArchiveWriteSnapshot[]>;
  rollbackBestEffort(snapshots: ArchiveWriteSnapshot[]): Promise<{
    reverted: number;
    skipped: number;
    skippedSnapshots: ArchiveWriteSnapshot[];
  }>;
  writePendingBestEffort(params: {
    operation: "compaction" | "clear";
    workspaceId: string;
    sessionId: string;
    runId?: string;
    snapshots: ArchiveWriteSnapshot[];
  }): Promise<void>;
  reconcilePendingBestEffort(params: { workspaceId: string; sessionId: string }): Promise<boolean>;
};

export type CompactionArchiveRunStatePort = {
  get(workspaceId: string, sessionId: string): CompactionArchiveRunState;
  clearLastResponseTokensIfActiveRun(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    updatedAt: number;
    appliedItemId: number;
  }): void;
  setIdle(params: {
    workspaceId: string;
    sessionId: string;
    updatedAt: number;
    appliedItemId: number;
  }): void;
  getControlResult(sessionId: string): AgentSessionRunState;
};

export type CompactionArchiveClock = {
  nowMs(): number;
};

export type CompactionArchiveLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

export type ClearSessionCommand = {
  sessionId: string;
  workspaceId: string;
  reason?: string;
  uiLocale?: AgentUiLocale | null;
};

export type CompactionArchiveApplicationDependencies = {
  sessionQuery: CompactionArchiveSessionQuery;
  persistence: CompactionArchivePersistence;
  archiveStorage: CompactionArchiveStorage;
  runState: CompactionArchiveRunStatePort;
  clock: CompactionArchiveClock;
  logger: CompactionArchiveLogger;
  isConflict(error: unknown): boolean;
  toConflictHttpError(error: unknown): Error;
  isArchivableItem(item: AgentContextItemRecord): boolean;
  isBoundaryMarkerItem(item: AgentContextItemRecord): boolean;
  buildArchiveLine(item: AgentContextItemRecord): string | null;
  buildClearSummaryText(input: { uiLocale: AgentUiLocale | null; reason?: string }): string;
};

export type CompactionArchiveApplicationPort = {
  applyWorkerCompaction(request: AgentApiCompactContextRequest): Promise<AgentApiCompactContextResponse>;
  clearSession(command: ClearSessionCommand): Promise<AgentControlResult>;
  reconcilePendingForSessionBestEffort(params: { workspaceId: string; sessionId: string }): Promise<boolean>;
};
