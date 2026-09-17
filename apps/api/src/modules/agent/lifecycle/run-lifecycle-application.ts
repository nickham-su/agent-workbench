import { HttpError } from "../../../app/errors.js";
import { AgentAttachmentCommitError } from "../attachments/agent-attachment-storage.js";
import { workspaceDeletingFence } from "./workspace-deleting-fence.js";
import type { AgentCancelSessionRequest } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentApiRunCompleteRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
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
  private readonly reconciliationTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconciliationAttempts = new Map<string, number>();
  private closed = false;

  constructor(private readonly dependencies: RunLifecycleApplicationDependencies) {}

  dispose() {
    this.closed = true;
    for (const timer of this.reconciliationTimers.values()) clearTimeout(timer);
    this.reconciliationTimers.clear();
    this.reconciliationAttempts.clear();
  }

  private isDefinitiveEnqueueFailure(error: unknown) {
    return error instanceof HttpError && error.code === "AGENT_WORKER_ENQUEUE_REJECTED";
  }

  private clearEnqueueReconciliation(runId: string) {
    const timer = this.reconciliationTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.reconciliationTimers.delete(runId);
    this.reconciliationAttempts.delete(runId);
  }

  private isWorkspaceDeletingError(error: unknown) {
    return error instanceof HttpError && error.code === "WORKSPACE_DELETING";
  }

  private async enqueueOnce(params: {
    runtime: Pick<StartUserRunCommand["runtime"], "enqueueRun">;
    run: import("./run-lifecycle-ports.js").AgentRuntimeRun;
  }) {
    await this.dependencies.runtimeHandoffCoordinator.runExclusive(
      params.run.sessionId,
      async () => {
        // The coordinator only serializes one bounded RPC handoff. Backoff is
        // scheduled outside it, so cancellation never waits behind retry sleep.
        workspaceDeletingFence.assertWritable(params.run.workspaceId);
        if (!this.dependencies.persistence.canEnqueueUserRunIfCurrent(params.run)) {
          throw new HttpError(409, "run is no longer active", "RUN_NOT_ACTIVE");
        }
        await params.runtime.enqueueRun(params.run);
      },
    );
  }

  private scheduleEnqueueReconciliation(params: {
    runtime: Pick<StartUserRunCommand["runtime"], "enqueueRun">;
    run: import("./run-lifecycle-ports.js").AgentRuntimeRun;
  }) {
    const { run } = params;
    if (this.closed) return;
    if (this.reconciliationTimers.has(run.runId)) return;
    const attempt = this.reconciliationAttempts.get(run.runId) ?? 0;
    const delayMs = Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(() => {
      this.reconciliationTimers.delete(run.runId);
      if (this.closed) return;
      void this.enqueueOnce(params)
        .then(() => {
          this.clearEnqueueReconciliation(run.runId);
        })
        .catch((error) => {
          if (this.closed) return;
          if (error instanceof HttpError && (error.code === "RUN_NOT_ACTIVE" || error.code === "WORKSPACE_DELETING")) {
            this.clearEnqueueReconciliation(run.runId);
            return;
          }
          if (this.isDefinitiveEnqueueFailure(error)) {
            this.clearEnqueueReconciliation(run.runId);
            const settlement = this.failRunAfterEnqueueFailure({
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              updatedAt: this.dependencies.clock.nowMs(),
            });
            this.dependencies.logger.warn(
              { err: error, runId: run.runId, sessionId: run.sessionId, settlement },
              "agent enqueue reconciliation permanently rejected",
            );
            return;
          }
          this.reconciliationAttempts.set(run.runId, attempt + 1);
          this.dependencies.logger.warn(
            { err: error, runId: run.runId, sessionId: run.sessionId, delayMs },
            "agent enqueue reconciliation will retry",
          );
          this.scheduleEnqueueReconciliation(params);
        });
    }, delayMs);
    timer.unref?.();
    this.reconciliationTimers.set(run.runId, timer);
  }

  /** Reuses the same fenced, idempotent runtime handoff for every activated Run kind. */
  async enqueueActivatedRunOrReconcile(params: {
    runtime: Pick<StartUserRunCommand["runtime"], "enqueueRun">;
    run: import("./run-lifecycle-ports.js").AgentRuntimeRun;
  }) {
    if (this.closed) throw new HttpError(503, "agent lifecycle is stopping", "AGENT_LIFECYCLE_STOPPING");
    await this.handoffOrSchedule(params);
  }

  private async handoffOrSchedule(params: {
    runtime: Pick<StartUserRunCommand["runtime"], "enqueueRun">;
    run: import("./run-lifecycle-ports.js").AgentRuntimeRun;
  }) {
    try {
      await this.enqueueOnce(params);
      this.clearEnqueueReconciliation(params.run.runId);
    } catch (error) {
      if (this.isWorkspaceDeletingError(error)) {
        // Deletion owns terminal convergence. This is deterministic: an RPC
        // could not have started because the fenced handoff checks first.
        this.clearEnqueueReconciliation(params.run.runId);
        throw error;
      }
      if (this.isDefinitiveEnqueueFailure(error)) {
        this.failRunAfterEnqueueFailure({
          workspaceId: params.run.workspaceId,
          sessionId: params.run.sessionId,
          runId: params.run.runId,
          updatedAt: this.dependencies.clock.nowMs(),
        });
        throw error;
      }
      // A timeout/connection error cannot prove the worker did not accept the
      // idempotent runId. Keep the durable run active and reconcile it.
      if (error instanceof HttpError && error.code === "RUN_NOT_ACTIVE") {
        throw error;
      }
      if (!this.closed) this.scheduleEnqueueReconciliation(params);
      throw new HttpError(503, "agent run enqueue status is unknown", "AGENT_WORKER_ENQUEUE_UNKNOWN");
    }
  }

  async startUserRun(command: StartUserRunCommand) {
    workspaceDeletingFence.assertWritable(command.workspaceId);
    const createdAt = this.dependencies.clock.nowMs();
    const committer = this.dependencies.attachmentCommitter;
    const images = command.images ?? [];
    const committedImages: typeof images = [];
    const removeFinals = async () => {
      if (!committer) return;
      await Promise.all(committedImages.map(async (image) => {
        await committer.removeFinal({ workspaceId: command.workspaceId, image }).catch(() => undefined);
      }));
    };
    const removeTemps = async () => {
      if (!committer) return;
      await Promise.all(images.map(async (image) => {
        await committer.removeTemp({ tempId: image.tempId }).catch(() => undefined);
      }));
    };
    const cleanupUnactivatedFiles = async () => {
      await removeFinals();
      await removeTemps();
    };
    const runId = this.dependencies.ids.newId("run");

    if (images.length > 0 && !committer) {
      throw new Error("agent attachment committer is not configured");
    }
    try {
      for (const image of images) {
        try {
          await committer!.commit({ workspaceId: command.workspaceId, image });
          committedImages.push(image);
        } catch (error) {
          // final 目录已失去可信性时，storage 已报告 cleanup pending；此处绝不能
          // 再通过逻辑 pathname 尝试清理，以免误删后来替换的文件。
          if (error instanceof AgentAttachmentCommitError && error.finalCreated && !error.cleanupPending) {
            committedImages.push(image);
          }
          throw error;
        }
      }
    } catch (error) {
      await cleanupUnactivatedFiles();
      throw error;
    }

    let activation;
    try {
      workspaceDeletingFence.assertWritable(command.workspaceId);
      activation = this.dependencies.persistence.activateUserRun({
        workspaceId: command.workspaceId,
        sessionId: command.sessionId,
        clientRequestId: command.clientRequestId,
        text: command.text,
        images,
        runId,
        agentId: command.agentId,
        providerId: command.providerId,
        modelId: command.modelId,
        uiLocale: command.uiLocale,
        createdAt
      });
    } catch (error) {
      await cleanupUnactivatedFiles();
      throw error;
    }

    if (activation.kind === "session-running") {
      await cleanupUnactivatedFiles();
      throw new HttpError(409, "session is running", "SESSION_RUNNING");
    }
    if (activation.kind === "deduplicated") {
      await cleanupUnactivatedFiles();
      return {
        sessionId: command.sessionId,
        messageId: activation.messageId,
        runId: activation.runId,
        deduplicated: true,
      };
    }

    const runContext = this.dependencies.workspaceRunContextReader.get(command.workspaceId);
    if (!runContext) throw new HttpError(404, "workspace not found");
    try {
      await this.enqueueActivatedRunOrReconcile({
        runtime: command.runtime,
        run: {
          workspaceId: command.workspaceId,
          sessionId: command.sessionId,
          runId: activation.runId,
          inputText: command.inputText,
          ...runContext,
        },
      });
    } catch (error) { throw error; }

    return {
      sessionId: command.sessionId,
      messageId: activation.messageId,
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
    const snapshot = this.dependencies.persistence.getCancelSessionSnapshot(command.sessionId);
    if (!snapshot) throw new HttpError(404, "session not found");
    if (snapshot.workspaceId !== command.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const cancelInput = {
      workspaceId: snapshot.workspaceId,
      rootSessionId: snapshot.sessionId,
      updatedAt: this.dependencies.clock.nowMs(),
      listActiveChildSessionIds: (params: { workspaceId: string; sessionId: string; runId: string }) =>
        this.dependencies.activeSubtaskChildQuery.listByParentRun(params),
    };
    const lockedSessionIds = this.dependencies.persistence.listActiveSessionIdsForCancel(cancelInput);
    return await this.dependencies.runtimeHandoffCoordinator.runExclusiveMany(
      [snapshot.sessionId, ...lockedSessionIds],
      async () => {
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
      },
    );
  }

  async recoverRunsOnStartup(command: RecoverRunsOnStartupCommand) {
    for (const candidate of this.dependencies.persistence.listRecoverableRunCandidates()) {
      // A durable Workspace deletion owns convergence for its Runs. It is not
      // a startup recovery failure: never prepare, enqueue or reconcile it.
      if (workspaceDeletingFence.isDeleting(candidate.workspaceId)) {
        this.dependencies.logger.debug?.(
          { workspaceId: candidate.workspaceId, sessionId: candidate.sessionId, runId: candidate.runId },
          "startup recovery skipped run in deleting workspace",
        );
        continue;
      }
      if (!this.dependencies.persistence.isRecoverableRunCandidate(candidate)) continue;
      const runContext = this.dependencies.workspaceRunContextReader.get(candidate.workspaceId);
      if (!runContext) continue;
      const inputText = candidate.runKind === "user" && candidate.triggerMessageId != null
        ? this.dependencies.triggerInputReader.getUserText(candidate.triggerMessageId) ?? ""
        : "";

      await command.beforeFinalCheck?.(candidate);
      let preparedRun;
      try {
        preparedRun = await this.dependencies.runtimeHandoffCoordinator.runExclusive(candidate.sessionId, async () => {
          // Recheck under the handoff lock. A deletion intent can be written
          // after the precheck while this candidate waits for its Session.
          workspaceDeletingFence.assertWritable(candidate.workspaceId);
          const preparation = this.dependencies.persistence.prepareRunForStartupRecovery({
            ...candidate,
            replacementMessageId: this.dependencies.ids.newId("msg"),
            updatedAt: this.dependencies.clock.nowMs(),
          });
          if (!preparation.prepared) return null;
          return {
            workspaceId: candidate.workspaceId,
            sessionId: candidate.sessionId,
            runId: candidate.runId,
            runKind: candidate.runKind,
            inputText,
            resumeAssistantMessageId: preparation.resumeAssistantMessageId,
            ...runContext,
          };
        });
      } catch (error) {
        if (!this.isWorkspaceDeletingError(error)) throw error;
        this.dependencies.logger.debug?.(
          { workspaceId: candidate.workspaceId, sessionId: candidate.sessionId, runId: candidate.runId },
          "startup recovery skipped run after deletion fence won",
        );
        continue;
      }
      if (!preparedRun) continue;
      // Do not retry the network request while holding the preparation lock.
      // The durable preparation is idempotent; the same runId is reconciled
      // after the critical section has released.
      try {
        await this.enqueueActivatedRunOrReconcile({ runtime: command.runtime, run: preparedRun });
      } catch (err) {
        if (this.isWorkspaceDeletingError(err)) {
          this.dependencies.logger.debug?.(
            { workspaceId: candidate.workspaceId, sessionId: candidate.sessionId, runId: candidate.runId },
            "startup recovery skipped run after deletion fence won during enqueue",
          );
          continue;
        }
        this.dependencies.logger.warn(
          { err, sessionId: candidate.sessionId, runId: candidate.runId },
          "startup recovery handoff was deferred or rejected",
        );
      }
    }
  }
}
