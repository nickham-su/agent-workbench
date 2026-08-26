import { HttpError } from "../../../app/errors.js";
import type { AgentCancelSessionRequest } from "@agent-workbench/shared";
import type { AgentApiRunCompleteRequest, AgentApiRunStateRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import type {
  CancelSessionCascadeResult,
  CancelSessionCommand,
  RecoverRunsOnStartupCommand,
  EnqueueFailureSettlement,
  RunLifecycleApplicationDependencies,
  StartUserRunCommand
} from "./run-lifecycle-ports.js";

/**
 * Single application boundary for run start, worker writeback, cancel and
 * recovery use-cases. P3 owns user activation/runtime enqueue; P4 owns
 * worker writeback and DB-first cancellation; P5 owns startup recovery.
 */
export class RunLifecycleApplication {
  constructor(private readonly dependencies: RunLifecycleApplicationDependencies) {}

  async startUserRun(command: StartUserRunCommand) {
    const createdAt = this.dependencies.clock.nowMs();
    const committer = this.dependencies.attachmentCommitter;
    const images = command.images ?? [];
    const removeFinals = async () => {
      if (!committer) return;
      await Promise.all(images.map(async (image) => {
        await committer.removeFinal({ workspaceId: command.workspaceId, image }).catch(() => undefined);
      }));
    };
    const removeTemps = async () => {
      if (!committer) return;
      await Promise.all(images.map(async (image) => {
        await committer.removeTemp({ tempId: image.tempId }).catch(() => undefined);
      }));
    };
    let activation;
    try {
      if (images.length > 0) {
        if (!committer) throw new Error("agent attachment committer is not configured");
        for (const image of images) {
          await committer.commit({ workspaceId: command.workspaceId, image });
        }
      }
      activation = this.dependencies.persistence.activateUserRun({
        workspaceId: command.workspaceId,
        sessionId: command.sessionId,
        clientRequestId: command.clientRequestId,
        text: command.text,
        images,
        runId: this.dependencies.ids.newId("run"),
        agentId: command.agentId,
        providerId: command.providerId,
        modelId: command.modelId,
        uiLocale: command.uiLocale,
        createdAt
      });
    } catch (error) {
      await removeFinals();
      await removeTemps();
      throw error;
    }

    if (activation.kind === "deduplicated") {
      await removeFinals();
      await removeTemps();
      return {
        sessionId: command.sessionId,
        messageItemId: activation.messageItemId,
        runId: activation.runId,
        deduplicated: true
      };
    }
    if (activation.kind === "session-running") {
      await removeFinals();
      await removeTemps();
      throw new HttpError(409, "session is running");
    }

    const runContext = this.dependencies.workspaceRunContextReader.get(command.workspaceId);
    if (!runContext) throw new HttpError(404, "workspace not found");

    try {
      await command.runtime.enqueueRun({
        workspaceId: command.workspaceId,
        sessionId: command.sessionId,
        runId: activation.runId,
        inputText: command.inputText,
        ...runContext
      });
    } catch (error) {
      this.failRunAfterEnqueueFailure({
        workspaceId: command.workspaceId,
        sessionId: command.sessionId,
        runId: activation.runId,
        updatedAt: this.dependencies.clock.nowMs()
      });
      throw error;
    }

    return {
      sessionId: command.sessionId,
      messageItemId: activation.messageItemId,
      runId: activation.runId,
      deduplicated: false
    };
  }

  failRunAfterEnqueueFailure(params: { workspaceId: string; sessionId: string; runId: string; updatedAt?: number }): EnqueueFailureSettlement {
    const settlement = this.dependencies.persistence.failRunAfterEnqueueFailureIfCurrent({
      ...params,
      updatedAt: params.updatedAt ?? this.dependencies.clock.nowMs()
    });
    if (settlement === "failed-and-idled" || settlement === "run-failed-state-not-current") {
      this.dependencies.promptStaticCacheInvalidator.clear(params.runId);
    }
    return settlement;
  }

  updateRunStateFromWorker(params: AgentApiRunStateRequest) {
    this.dependencies.persistence.updateRunStateFromWorker({
      ...params,
      updatedAt: params.updatedAt ?? this.dependencies.clock.nowMs()
    });
  }

  completeRunFromWorker(params: AgentApiRunCompleteRequest) {
    const updatedAt = params.updatedAt ?? this.dependencies.clock.nowMs();
    const completed = this.dependencies.persistence.completeRunFromWorker({ ...params, updatedAt });
    if (!completed) return;

    this.dependencies.promptStaticCacheInvalidator.clear(params.runId);
    this.dependencies.runCompletedEventPublisher.publishRunCompleted({
      eventId: this.dependencies.ids.newId("evt"),
      occurredAt: updatedAt,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      finalStatus: params.status
    });
  }

  cancelSessionCascade(sessionId: string, body: AgentCancelSessionRequest): CancelSessionCascadeResult {
    const root = this.dependencies.persistence.getCancelSessionSnapshot(sessionId);
    if (!root) throw new HttpError(404, "session not found");
    if (root.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const result = this.dependencies.persistence.cancelSessions({
      workspaceId: root.workspaceId,
      rootSessionId: root.sessionId,
      updatedAt: this.dependencies.clock.nowMs(),
      listActiveChildSessionIds: (params) => this.dependencies.activeSubtaskChildQuery.listByParentRun(params)
    });
    for (const runId of result.cancelledRunIds) this.dependencies.promptStaticCacheInvalidator.clear(runId);
    return {
      result: { ok: true, session: root.session, runState: this.dependencies.runStateReader.get(result.rootSessionId) },
      runtimeCancelSessionIds: result.runtimeCancelSessionIds
    };
  }

  async cancelSession(command: CancelSessionCommand) {
    const result = this.cancelSessionCascade(command.sessionId, { workspaceId: command.workspaceId });
    const settled = await Promise.allSettled(result.runtimeCancelSessionIds.map((sessionId) => command.runtime.cancelSession(sessionId)));
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      if (!outcome || outcome.status !== "rejected") continue;
      this.dependencies.logger.warn(
        { err: outcome.reason, rootSessionId: command.sessionId, targetSessionId: result.runtimeCancelSessionIds[index] },
        "agent cancel runtime session failed"
      );
    }
    return result.result;
  }

  async recoverRunsOnStartup(command: RecoverRunsOnStartupCommand) {
    for (const candidate of this.dependencies.persistence.listRecoverableRunCandidates()) {
      if (!this.dependencies.persistence.isRecoverableRunCandidate(candidate)) continue;
      const runContext = this.dependencies.workspaceRunContextReader.get(candidate.workspaceId);
      if (!runContext) continue;
      const inputText = candidate.triggerItemId == null
        ? ""
        : this.dependencies.triggerInputReader.getUserText(candidate.triggerItemId) ?? "";

      await command.beforeFinalCheck?.(candidate);
      if (!this.dependencies.persistence.isRecoverableRunCandidate(candidate)) continue;
      try {
        await command.runtime.enqueueRun({
          workspaceId: candidate.workspaceId,
          sessionId: candidate.sessionId,
          runId: candidate.runId,
          inputText,
          ...runContext
        });
      } catch (err) {
        this.dependencies.logger.warn(
          { err, sessionId: candidate.sessionId, runId: candidate.runId },
          "startup recovery mode=recover: enqueue run failed"
        );
      }
    }
  }

  failRunsOnStartup() {
    const updatedAt = this.dependencies.clock.nowMs();
    try {
      const candidates = this.dependencies.persistence.listRecoverableRunCandidates();
      for (const candidate of candidates) {
        let contextItemChanges = 0;
        let runRecordChanges = 0;
        let runStateChanges = 0;
        try {
          contextItemChanges = this.dependencies.persistence.failNonTerminalContextItemsForRecovery({ ...candidate, updatedAt });
        } catch (err) {
          this.dependencies.logger.warn({ err, runId: candidate.runId }, "fail context items failed on startup recovery");
        }
        try {
          runRecordChanges = this.dependencies.persistence.failRunRecordForRecovery({ ...candidate, updatedAt });
          if (runRecordChanges === 0) {
            this.dependencies.logger.debug?.({ runId: candidate.runId }, "startup recovery: skip failing run record (already terminal or missing)");
          }
        } catch (err) {
          this.dependencies.logger.warn({ err, runId: candidate.runId }, "fail run record failed on startup recovery");
        }
        try {
          runStateChanges = this.dependencies.persistence.reclaimRunStateForRecovery({ ...candidate, updatedAt });
          if (runStateChanges === 0) {
            this.dependencies.logger.warn(candidate, "startup recovery: skip resetting run-state (active run changed or already idle)");
          }
        } catch (err) {
          this.dependencies.logger.warn({ err, ...candidate }, "set run-state idle failed on startup recovery");
        }
        if (runStateChanges > 0 && (contextItemChanges > 0 || runRecordChanges > 0)) {
          const text = runRecordChanges > 0
            ? "[run] marked failed on server restart (startup recovery mode: fail)"
            : "[run] cleaned up inflight context on server restart (startup recovery mode: fail)";
          try {
            this.dependencies.persistence.appendRecoveryFailureNotice({ ...candidate, text, createdAt: updatedAt });
          } catch (err) {
            if (!this.dependencies.isContextAppendConflict(err)) {
              this.dependencies.logger.warn({ err, sessionId: candidate.sessionId, runId: candidate.runId }, "append startup termination notice failed");
            }
          }
        }
      }

      const dirtySessions = this.dependencies.persistence.listInFlightSessionsWithoutActiveRunId();
      for (const session of dirtySessions) {
        try {
          const changes = this.dependencies.persistence.reclaimDirtyRunStateForRecovery({ ...session, updatedAt });
          if (changes > 0) this.dependencies.logger.warn(session, "startup recovery: reset in-flight session without active runId to idle");
        } catch (err) {
          this.dependencies.logger.warn({ err, ...session }, "startup recovery: reset in-flight session without active runId failed");
        }
      }
      if (candidates.length > 0 || dirtySessions.length > 0) {
        this.dependencies.logger.warn(
          { runs: candidates.length, sessionsWithoutActiveRunId: dirtySessions.length },
          "startup recovery mode=fail: terminated inflight state"
        );
      }
    } catch (err) {
      this.dependencies.logger.error({ err }, "startup recovery mode=fail: unexpected error");
    }
  }
}
