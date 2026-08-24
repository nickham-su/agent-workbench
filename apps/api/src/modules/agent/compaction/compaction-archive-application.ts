import { HttpError } from "../../../app/errors.js";
import type {
  AgentApiCompactContextRequest,
  AgentApiCompactContextResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type {
  ClearSessionCommand,
  CompactionArchiveApplicationDependencies,
  CompactionArchiveApplicationPort,
} from "./compaction-archive-ports.js";

/**
 * Owns Worker compact apply, clear, and their per-session archive-reconcile
 * preflight. Filesystem operations and the SQLite summary/archive transaction
 * remain narrow injected capabilities.
 */
export class CompactionArchiveApplication implements CompactionArchiveApplicationPort {
  constructor(private readonly dependencies: CompactionArchiveApplicationDependencies) {}

  reconcilePendingForSessionBestEffort(params: { workspaceId: string; sessionId: string }) {
    return this.dependencies.archiveStorage.reconcilePendingBestEffort(params);
  }

  async applyWorkerCompaction(
    request: AgentApiCompactContextRequest,
  ): Promise<AgentApiCompactContextResponse> {
    await this.reconcilePendingForSessionBestEffort({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
    });
    const session = this.dependencies.sessionQuery.get(request.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== request.workspaceId) {
      throw new HttpError(400, "workspaceId mismatch");
    }
    const run = this.dependencies.sessionQuery.getRun(request.runId);
    if (!run || run.workspaceId !== request.workspaceId || run.sessionId !== request.sessionId) {
      throw new HttpError(404, "run not found");
    }
    if (session.headItemId !== request.expectedHeadItemId) {
      throw new HttpError(409, "session head conflict");
    }

    const summaryText = String(request.summaryText || "").trim();
    if (!summaryText) {
      throw new HttpError(400, "summaryText is required", "AGENT_COMPACTION_SUMMARY_REQUIRED");
    }

    const visible = this.dependencies.sessionQuery.getVisibleItems(request.workspaceId, request.sessionId);
    if (visible.length === 0 || visible.some((item) => !this.dependencies.isArchivableItem(item))) {
      return { compacted: false, summaryItemId: null, archivedCount: 0 };
    }

    const summaryCreatedAt = this.dependencies.clock.nowMs();
    const snapshots = await this.dependencies.archiveStorage.appendLines({
      operation: "compaction",
      workspaceId: request.workspaceId,
      sessionId: session.id,
      lines: visible
        .map((item) => this.dependencies.buildArchiveLine(item))
        .filter((line): line is string => line != null),
    });
    const archiveAt = this.dependencies.clock.nowMs();

    let applied: { summaryItemId: number; archivedCount: number };
    try {
      applied = this.dependencies.persistence.appendSummaryAndArchiveItems({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        runId: request.runId,
        expectedHeadItemId: request.expectedHeadItemId,
        summaryText,
        boundaryReason: "compaction",
        summaryCreatedAt,
        archiveItemIds: visible.map((item) => item.id),
        archiveAt,
      });
    } catch (error) {
      await this.compensateAfterPersistenceFailure({
        operation: "compaction",
        workspaceId: session.workspaceId,
        sessionId: session.id,
        runId: request.runId,
        snapshots,
        logMessage: "archive rollback had skipped files after compaction db failure",
      });
      if (this.dependencies.isConflict(error)) throw this.dependencies.toConflictHttpError(error);
      throw error;
    }

    // This post-commit write intentionally remains outside the persistence catch:
    // its failure must not roll archive bytes back or create a pending sidecar.
    this.dependencies.runState.clearLastResponseTokensIfActiveRun({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      runId: request.runId,
      updatedAt: archiveAt,
      appliedItemId: this.dependencies.sessionQuery.getLatestItemId(request.workspaceId, request.sessionId),
    });

    return { compacted: true, ...applied };
  }

  async clearSession(command: ClearSessionCommand) {
    await this.reconcilePendingForSessionBestEffort({
      workspaceId: command.workspaceId,
      sessionId: command.sessionId,
    });
    const session = this.dependencies.sessionQuery.get(command.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.kind === "subtask") {
      throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
    }
    if (session.workspaceId !== command.workspaceId) {
      throw new HttpError(400, "workspaceId mismatch");
    }

    const initialRunState = this.dependencies.runState.get(session.workspaceId, session.id);
    if (initialRunState.status !== "idle") {
      throw new HttpError(409, "session is running", "AGENT_CLEAR_NOT_IDLE");
    }

    const visible = this.dependencies.sessionQuery.getVisibleItems(session.workspaceId, session.id);
    if (visible.length === 0) {
      throw new HttpError(400, "no context to clear", "AGENT_CLEAR_EMPTY");
    }
    if (visible.length === 1 && this.dependencies.isBoundaryMarkerItem(visible[0]!)) {
      throw new HttpError(400, "clear not needed", "AGENT_CLEAR_NOT_NEEDED");
    }
    if (visible.some((item) => !this.dependencies.isArchivableItem(item))) {
      throw new HttpError(409, "session has non-terminal items", "AGENT_CLEAR_NOT_IDLE");
    }

    const summaryCreatedAt = this.dependencies.clock.nowMs();
    const snapshots = await this.dependencies.archiveStorage.appendLines({
      operation: "clear",
      workspaceId: session.workspaceId,
      sessionId: session.id,
      lines: visible
        .map((item) => this.dependencies.buildArchiveLine(item))
        .filter((line): line is string => line != null),
    });
    const archiveAt = this.dependencies.clock.nowMs();

    try {
      this.dependencies.persistence.appendSummaryAndArchiveItems({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        runId: null,
        expectedHeadItemId: session.headItemId,
        summaryText: this.dependencies.buildClearSummaryText({
          uiLocale: command.uiLocale ?? null,
          reason: command.reason,
        }),
        boundaryReason: "clear",
        summaryCreatedAt,
        archiveItemIds: visible.map((item) => item.id),
        archiveAt,
      });
      // Unlike compact token cleanup, this is deliberately in the catch scope.
      this.dependencies.runState.setIdle({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: archiveAt,
        appliedItemId: this.dependencies.sessionQuery.getLatestItemId(session.workspaceId, session.id),
      });
    } catch (error) {
      await this.compensateAfterPersistenceFailure({
        operation: "clear",
        workspaceId: session.workspaceId,
        sessionId: session.id,
        runId: initialRunState.activeRunId ?? undefined,
        snapshots,
        logMessage: "archive rollback had skipped files after clear db failure",
      });
      if (this.dependencies.isConflict(error)) throw this.dependencies.toConflictHttpError(error);
      throw error;
    }

    const updated = this.dependencies.sessionQuery.get(session.id);
    if (!updated) throw new HttpError(500, "session not found after clear");
    return {
      ok: true,
      session: updated,
      runState: this.dependencies.runState.getControlResult(updated.id),
    };
  }

  private async compensateAfterPersistenceFailure(params: {
    operation: "compaction" | "clear";
    workspaceId: string;
    sessionId: string;
    runId?: string;
    snapshots: Parameters<CompactionArchiveApplicationDependencies["archiveStorage"]["rollbackBestEffort"]>[0];
    logMessage: string;
  }) {
    const rollback = await this.dependencies.archiveStorage.rollbackBestEffort(params.snapshots);
    if (rollback.skipped === 0) return;

    await this.dependencies.archiveStorage.writePendingBestEffort({
      operation: params.operation,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.runId ? { runId: params.runId } : {}),
      snapshots: rollback.skippedSnapshots,
    });
    this.dependencies.logger.warn(
      {
        sessionId: params.sessionId,
        ...(params.runId ? { runId: params.runId } : {}),
        revertedFiles: rollback.reverted,
        skippedFiles: rollback.skipped,
      },
      params.logMessage,
    );
  }
}
