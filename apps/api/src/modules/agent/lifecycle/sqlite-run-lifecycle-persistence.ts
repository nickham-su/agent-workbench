import type { AgentResumeMessageQueueRequest } from "@agent-workbench/shared";
import { AgentQueueRecoveryStore } from "../message-queue/queue-recovery.store.js";
import { assertSessionQueueUnoccupied } from "../message-queue/message-queue.guard.js";
import { AgentMessageQueueStore, queueIdentity } from "../message-queue/message-queue.store.js";
import { randomUUID } from "node:crypto";
import { listCurrentRunScopesForStop, AgentRuntimeControlStore, assertSessionRuntimeUnblocked } from "../runtime-control/runtime-control.store.js";
import type { Db } from "../../../infra/db/db.js";
import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { assertSubtaskSessionVisibility } from "../session/session-visibility.js";
import { HttpError } from "../../../app/errors.js";
import { assertAgentImageByteSize } from "../attachments/agent-attachment-storage.js";
import { assertAgentAttachmentId, assertAgentAttachmentTempId, assertAgentAttachmentStorageKey } from "../attachments/agent-attachment-paths.js";
import {
  appendMessage,
  getMessageSessionHead,
  getMessageRunState,
  getPersistedRunTerminalIntent,
  getMessageSession,
  getMessageSessionById,
  convergeRunTerminal,
  markRunWorkInProgress,
  persistRunTerminalIntent,
  settleMessageRunIfCurrent,
  startMessageRun,
} from "../agent-message.store.js";
import type {
  SubtaskChildActivationInput,
  SubtaskChildActivationResult,
  SubtaskChildRunActivator,
} from "../subtask/subtask-ports.js";
import { toAutomaticSessionTitle } from "../session/session-title.js";
import {
  createMessageRunRecord,
  findMessageClientRequestDedup,
  getRunRecord,
  insertMessageClientRequestDedup,
  updateAutoMessageSessionTitle,
} from "../agent-message.store.js";
import type {
  AtomicLifecyclePersistence,
  CancelSessionSnapshot,
  CancelSessionsInput,
  CancelSessionsResult,
  EnqueueFailureInput,
  EnqueueFailureSettlement,
  UserRunActivationInput,
  UserRunActivationResult,
} from "./run-lifecycle-ports.js";

function toSessionTitleFromFirstMessage(text: string) {
  return toAutomaticSessionTitle(text, "新会话");
}

function validateUserRunImages(input: UserRunActivationInput, alreadyPublished = false) {
  const attachmentIds = new Set<string>();
  const storageKeys = new Set<string>();
  for (let index = 0; index < input.images.length; index += 1) {
    const image = input.images[index]!;
    if (image.position !== index) throw new Error("invalid agent image position");
    assertAgentAttachmentId(image.attachmentId);
    if (!alreadyPublished) assertAgentAttachmentTempId(image.tempId);
    if (
      image.filename.length < 1 ||
      [...image.filename].length > 255 ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mediaType)
    ) {
      throw new Error("invalid agent image metadata");
    }
    assertAgentAttachmentStorageKey(image.attachmentId, image.storageKey, image.mediaType as AgentImageMediaType);
    if (attachmentIds.has(image.attachmentId) || storageKeys.has(image.storageKey)) {
      throw new Error("duplicate agent image attachment");
    }
    assertAgentImageByteSize(image.byteSize);
    attachmentIds.add(image.attachmentId);
    storageKeys.add(image.storageKey);
  }
}

export class SqliteRunLifecyclePersistence
  implements AtomicLifecyclePersistence, SubtaskChildRunActivator
{
  constructor(private readonly db: Db) {}

  /** Queue activation delegates the ordinary message/Run authority in one transaction. */
  resumeQueuedSession(input: AgentResumeMessageQueueRequest & { sessionId: string }, runId: string, createdAt: number) {
    return new AgentQueueRecoveryStore(this.db).resume(input, runId, createdAt);
  }

  activateAcceptedUserRun(input: { workspaceId: string; sessionId: string; receiptId: string; runId: string; createdAt: number }): UserRunActivationResult {
    return this.db.transaction(() => {
      const queue = new AgentMessageQueueStore(this.db);
      queue.assertScope(input);
      const receipt = queue.get(input, input.receiptId);
      if (receipt.status === "injected") return { kind: "deduplicated" as const, messageId: receipt.message_id!, runId: receipt.injected_run_id! };
      assertSessionRuntimeUnblocked(this.db, input.workspaceId, input.sessionId);
      // A cleared current pointer is not proof that a draining/older execution has exited.
      if (queue.hasUndrainedExecution(input))
        return { kind: "session-running" as const };
      const snapshot = queue.snapshot(input);
      if (receipt.status !== "queued" || receipt.target_run_id !== null || snapshot.items[0]?.id !== receipt.id)
        throw new HttpError(409, "Message queue is not dispatchable", "AGENT_QUEUE_NOT_DISPATCHABLE");
      return this.activateUserRunInternal({ ...input, clientRequestId: receipt.client_request_id, text: receipt.text!, ...queueIdentity(receipt),
        uiLocale: receipt.ui_locale, images: queue.attachments(input, receipt.id).map(image => ({
          attachmentId: image.id, storageKey: image.storageKey, filename: image.filename, mediaType: image.mediaType,
          byteSize: image.byteSize, position: image.position, tempId: "",
        })) }, undefined, receipt.id);
    }).immediate();
  }

  activateUserRun(input: UserRunActivationInput, publishImages?: () => void): UserRunActivationResult {
    return this.activateUserRunInternal(input, publishImages);
  }

  private activateUserRunInternal(input: UserRunActivationInput, publishImages?: () => void, queueReceiptId?: string): UserRunActivationResult {
    const transaction = this.db.transaction(() => {
      if (!queueReceiptId && this.db.prepare("select 1 from agent_user_message_receipt where workspace_id=? and session_id=? and client_request_id=?")
        .get(input.workspaceId, input.sessionId, input.clientRequestId)) throw new HttpError(409, "Request identity belongs to the message queue", "AGENT_REQUEST_ID_NAMESPACE_CONFLICT");
      const dedup = findMessageClientRequestDedup(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        expectedSessionVisibility: input.expectedSessionVisibility,
        queueReceiptId,
      });
      // Visibility is stable identity, unlike pristine head/title/revision.
      // Check it even on an accepted replay, before the idempotency shortcut.
      const scheduledSession = input.expectedSessionVisibility == null ? null :
        getMessageSession(this.db, input.workspaceId, input.sessionId);
      if (input.expectedSessionVisibility != null && (!scheduledSession || scheduledSession.kind !== "primary" ||
          scheduledSession.visibility !== input.expectedSessionVisibility)) {
        throw new HttpError(409, "Scheduled session identity changed before Run activation", "SESSION_ID_CONFLICT");
      }
      if (dedup) return { kind: "deduplicated" as const, ...dedup };
      if (!queueReceiptId) assertSessionQueueUnoccupied(this.db, input.workspaceId, input.sessionId);
      assertSessionRuntimeUnblocked(this.db,input.workspaceId,input.sessionId);
      const runState = getMessageRunState(
        this.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!runState || runState.status !== "idle")
        return { kind: "session-running" as const };
      const session = scheduledSession ?? getMessageSession(
        this.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!session) throw new Error("agent session not found");
      const expected = input.expectedHistoricalFork;
      // Title edits do not increment revision. Both expected-ID paths must
      // compare the normalized authoritative title inside the activation txn.
      if ((expected && session.title !== expected.title) ||
          (input.expectedSessionTitle != null && session.title !== input.expectedSessionTitle)) {
        throw new HttpError(409, "Scheduled session title changed before Run activation", "SESSION_ID_CONFLICT");
      }
      // expectedSessionTitle is supplied only for a preallocated new_session.
      // A concurrent send/revert/compaction may leave the title unchanged;
      // revision and ancestry must still match the pristine primary Session.
      if (input.expectedSessionTitle != null && (session.kind !== "primary" ||
          session.headMessageId !== null || session.contextRootMessageId !== null ||
          session.revision !== 0 || session.forkedFromSessionId !== null ||
          session.forkedFromMessageId !== null)) {
        throw new HttpError(409, "Scheduled session changed before Run activation", "SESSION_ID_CONFLICT");
      }
      if (expected && (session.kind !== "primary" ||
        session.forkedFromSessionId !== expected.sourceSessionId ||
        session.forkedFromMessageId !== expected.sourceMessageId ||
        session.headMessageId !== expected.headMessageId ||
        session.contextRootMessageId !== expected.contextRootMessageId ||
        session.revision !== expected.revision)) {
        throw new HttpError(409, "Scheduled fork session changed before Run activation", "SESSION_ID_CONFLICT");
      }
      validateUserRunImages(input, !!queueReceiptId);
      // All ordinary idempotency, state and fork conflicts have been decided in
      // this synchronous SQLite transaction. Do not yield before publishing.
      publishImages?.();
      const insertAttachment = this.db.prepare(
        `insert into agent_attachment
          (id, workspace_id, storage_key, filename, media_type, byte_size, created_at)
          values (@attachmentId, @workspaceId, @storageKey, @filename, @mediaType, @byteSize, @createdAt)`,
      );
      for (const image of queueReceiptId ? [] : input.images) {
        insertAttachment.run({
          ...image,
          workspaceId: input.workspaceId,
          createdAt: input.createdAt,
        });
      }
      const messageId = `message-${input.runId}`;
      const parts = [
        {
          id: `part-${input.runId}-text`,
          position: 0,
          type: "text" as const,
          text: input.text,
        },
        ...input.images.map((image, index) => ({
          id: `part-${input.runId}-image-${index}`,
          position: index + 1,
          type: "image" as const,
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          filename: image.filename,
        })),
      ];
      const message = appendMessage(this.db, {
        id: messageId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedHeadMessageId: session.headMessageId,
        expectedRevision: session.revision,
        originRunId: null,
        type: "user",
        status: "completed",
        parts,
        createdAt: input.createdAt,
      });
      if (session.headMessageId == null)
        updateAutoMessageSessionTitle(this.db, {
          sessionId: input.sessionId,
          title: toSessionTitleFromFirstMessage(input.text),
          updatedAt: input.createdAt,
        });
      createMessageRunRecord(this.db, {
        runId: input.runId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        triggerMessageId: message.id,
        agentId: input.agentId,
        providerId: input.providerId,
        uiLocale: input.uiLocale,
        modelId: input.modelId,
        runKind: "user",
        interactiveQueue: !!queueReceiptId,
        subtaskDepth: 0,
        parentRunId: null,
        parentToolExecutionId: null,
        status: "running",
        createdAt: input.createdAt,
      });
      insertMessageClientRequestDedup(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        messageId: message.id,
        runId: input.runId,
        createdAt: input.createdAt,
      });
      if (queueReceiptId) {
        const unconfirmed = new AgentMessageQueueStore(this.db).listUnconfirmed(input);
        if (unconfirmed.some(receipt => receipt.session_id !== input.sessionId)) throw new HttpError(409, "A fork cannot claim another Session's inputs", "AGENT_QUEUE_INPUT_SCOPE_CONFLICT");
        for (const receipt of unconfirmed) this.db.prepare("insert into agent_interactive_run_input(workspace_id,session_id,run_id,receipt_id) values (?,?,?,?)")
          .run(input.workspaceId,input.sessionId,input.runId,receipt.id);
        this.db.prepare(`update agent_user_message_receipt set status='injected',message_id=?,injected_run_id=?,confirmation_state='unconfirmed',updated_at=? where id=? and status='queued'`)
          .run(message.id, input.runId, input.createdAt, queueReceiptId);
        this.db.prepare("insert into agent_interactive_run_input(workspace_id,session_id,run_id,receipt_id) values (?,?,?,?)")
          .run(input.workspaceId, input.sessionId, input.runId, queueReceiptId);
        this.db.prepare("update agent_session_queue_control set queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?")
          .run(input.createdAt, input.workspaceId, input.sessionId);
      }
      startMessageRun(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
        updatedAt: input.createdAt,
      });
      return {
        kind: "activated" as const,
        messageId: message.id,
        runId: input.runId,
      };
    });
    // Acquire SQLite's write reservation before the first dedup/state read.
    // A DEFERRED transaction lets another connection pass those reads and
    // reach filesystem publication before either can upgrade to a writer.
    return transaction.immediate();
  }

  canEnqueueUserRunIfCurrent(input: { workspaceId: string; sessionId: string; runId: string }) {
    return Boolean(this.db.prepare(`
      select 1
      from agent_run run
      join session_run_state state
        on state.workspace_id = run.workspace_id and state.session_id = run.session_id
      where run.run_id = @runId
        and run.workspace_id = @workspaceId
        and run.session_id = @sessionId
        and run.status = 'running'
        and state.status = 'running'
        and state.active_run_id = @runId
      limit 1
    `).get(input));
  }

  activate(input: SubtaskChildActivationInput): SubtaskChildActivationResult {
    const transaction = this.db.transaction(() => {
      const state = getMessageRunState(this.db, input.workspaceId, input.sessionId);
      if (!state || state.status !== "idle") return { kind: "session-running" as const };
      const parentFence = this.db.prepare(`
        select parent_session.visibility
        from agent_run parent_run
        join agent_session parent_session
          on parent_session.id = parent_run.session_id and parent_session.workspace_id = parent_run.workspace_id
        join session_run_state parent_state
          on parent_state.workspace_id = parent_run.workspace_id
          and parent_state.session_id = parent_run.session_id
        join agent_tool_execution execution
          on execution.id = @parentToolExecutionId
          and execution.origin_session_id = parent_run.session_id
          and execution.origin_run_id = parent_run.run_id
        join agent_message_part call_part
          on call_part.id = execution.call_part_id and call_part.tool_name = 'subtask'
        where parent_run.workspace_id = @workspaceId
          and parent_run.run_id = @parentRunId
          and parent_run.status = 'running'
          and parent_state.status = 'running'
          and parent_state.active_run_id = parent_run.run_id
          and execution.status = 'running'
        limit 1
      `).get(input) as { visibility: "listed" | "unlisted" } | undefined;
      if (!parentFence) return { kind: "parent-not-active" as const };
      const session = getMessageSession(this.db, input.workspaceId, input.sessionId);
      if (!session) throw new Error("agent session not found");
      // Authoritative reuse check precedes every message/Run write, including
      // callers racing the application-level materialization/shortcut reads.
      assertSubtaskSessionVisibility(parentFence.visibility, session.visibility);
      let head = getMessageSessionHead(this.db, input);
      if (!head) throw new Error("agent session not found");
      for (let index = 0; index < input.systemTexts.length; index += 1) {
        appendMessage(this.db, {
          id: `${input.runId}-system-${index}`,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          expectedHeadMessageId: head.headMessageId,
          expectedRevision: head.revision,
          originRunId: null,
          type: "system",
          status: "completed",
          parts: [
            {
              id: `${input.runId}-system-part-${index}`,
              position: 0,
              type: "text",
              text: input.systemTexts[index] ?? "",
            },
          ],
          createdAt: input.createdAt,
        });
        head = getMessageSessionHead(this.db, input);
        if (!head) throw new Error("agent session not found");
      }
      const prompt = appendMessage(this.db, {
        id: `${input.runId}-user`,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedHeadMessageId: head.headMessageId,
        expectedRevision: head.revision,
        originRunId: null,
        type: "user",
        status: "completed",
        parts: [
          {
            id: `${input.runId}-user-part`,
            position: 0,
            type: "text",
            text: input.prompt,
          },
        ],
        createdAt: input.createdAt,
      });
      createMessageRunRecord(this.db, {
        runId: input.runId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        triggerMessageId: prompt.id,
        agentId: input.agentId,
        providerId: input.providerId,
        uiLocale: input.uiLocale,
        modelId: input.modelId,
        runKind: "subtask",
        subtaskDepth: input.subtaskDepth,
        parentRunId: input.parentRunId,
        parentToolExecutionId: input.parentToolExecutionId,
        status: "running",
        createdAt: input.createdAt,
      });
      startMessageRun(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
        updatedAt: input.createdAt,
      });
      return { kind: "activated" as const, promptMessageId: prompt.id };
    });
    return transaction.immediate();
  }

  failRunAfterEnqueueFailureIfCurrent(
    input: EnqueueFailureInput,
  ): EnqueueFailureSettlement {
    const transaction = this.db.transaction(() => {
      const run = getRunRecord(this.db, input.runId);
      if (
        !run ||
        run.workspaceId !== input.workspaceId ||
        run.sessionId !== input.sessionId
      )
        return "missing-or-mismatch" as const;
      if (run.executionPhase === "terminal") return "already-terminal" as const;
      // `run_enqueue_failed` is a durable proof that work was never entered.
      // Once work starts, a late enqueue rejection cannot replace its outcome.
      if (run.executionPhase !== "work_pending") {
        // Cancellation or another terminal authority has already persisted its
        // immutable tuple. An enqueue failure must not replace that intent.
        return "run-failed-state-not-current" as const;
      }
      persistRunTerminalIntent(this.db, { ...input, status: "failed", code: "run_enqueue_failed", detail: null });
      return "intent-persisted" as const;
    });
    return transaction();
  }

  getCancelSessionSnapshot(sessionId: string): CancelSessionSnapshot | null {
    const session = getMessageSessionById(this.db, sessionId);
    if (!session) return null;
    const runState = getMessageRunState(
      this.db,
      session.workspaceId,
      session.id,
    );
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      session,
      runState: {
        status: runState?.status ?? "idle",
        activeRunId: runState?.activeRunId ?? null,
      },
    };
  }

  listActiveSessionIdsForCancel(input: CancelSessionsInput): string[] {
    return listCurrentRunScopesForStop(this.db,input.workspaceId,input.rootSessionId,input.listActiveChildSessionIds).map(run=>run.sessionId);
  }

  cancelSessions(input: CancelSessionsInput): CancelSessionsResult {
    const transaction = this.db.transaction((selectedRunIds: string[]) => {
      const cancelledRunIds = new Set<string>();
      const terminalIntents: Array<{ workspaceId: string; sessionId: string; runId: string }> = [];
      const terminalConvergences: NonNullable<CancelSessionsResult["terminalConvergences"]> = [];
      const sessionIds = this.listActiveSessionIdsForCancel(input);
      const captured = this.db.prepare(`select workspace_id as workspaceId,session_id as sessionId,run_id as runId
        from agent_run where workspace_id=? and run_id in (select value from json_each(?)) and execution_phase<>'terminal'`)
        .all(input.workspaceId,JSON.stringify(selectedRunIds)) as Array<{workspaceId:string;sessionId:string;runId:string}>;
      for (const runKey of captured) {
        if (!getPersistedRunTerminalIntent(this.db,runKey)) {
          persistRunTerminalIntent(this.db,{...runKey,status:"cancelled",code:"run_cancelled",detail:null,updatedAt:input.updatedAt});
          cancelledRunIds.add(runKey.runId);
        }
        terminalIntents.push(runKey);
        terminalConvergences.push({...runKey,result:convergeRunTerminal(this.db,{...runKey,updatedAt:input.updatedAt})});
      }
      const root = getMessageSessionById(this.db, input.rootSessionId);
      if (!root) throw new Error("cancel root session not found after cancel");
      return {
        rootSessionId: root.id,
        runtimeCancelSessionIds: sessionIds,
        cancelledRunIds: [...cancelledRunIds],
        terminalIntents,
        terminalConvergences,
      };
    });
    const stopOperationId = input.stopOperationId ?? randomUUID();
    const stopped = new AgentRuntimeControlStore(this.db).stop({workspaceId:input.workspaceId,rootSessionId:input.rootSessionId,operationId:stopOperationId}, transaction, () => listCurrentRunScopesForStop(this.db,input.workspaceId,input.rootSessionId,input.listActiveChildSessionIds));
    return stopped.result ? {...stopped.result,stopOperationId,stopReplayed:false} : {rootSessionId:input.rootSessionId,runtimeCancelSessionIds:[],cancelledRunIds:[],terminalIntents:[],stopOperationId,stopReplayed:true};
  }

  markRunWorkInProgress(input: import("./run-lifecycle-ports.js").TerminalControlInput) {
    return markRunWorkInProgress(this.db, input);
  }

  persistRunTerminalIntent(input: import("./run-lifecycle-ports.js").TerminalIntentControlInput) {
    return persistRunTerminalIntent(this.db, input);
  }

  convergeRunTerminal(input: import("./run-lifecycle-ports.js").TerminalControlInput) {
    return convergeRunTerminal(this.db, input);
  }

  listWorkspaceRunningRunCandidates(workspaceId: string) {
    return this.db.prepare(`
      select workspace_id as workspaceId, session_id as sessionId, run_id as runId,
        execution_phase as executionPhase
      from agent_run
      where workspace_id = @workspaceId and status = 'running'
      order by session_id asc, run_id asc
    `).all({ workspaceId }) as Array<{
      workspaceId: string;
      sessionId: string;
      runId: string;
      executionPhase: import("@agent-workbench/shared").AgentRunExecutionPhase;
    }>;
  }

  listRecoverableRunCandidates() {
    return this.db
      .prepare(
        `
      select run.workspace_id as workspaceId, run.session_id as sessionId,
        run.run_id as runId, run.run_kind as runKind,
        run.trigger_message_id as triggerMessageId, run.execution_phase as executionPhase
      from agent_run run
      where run.status = 'running'
    `,
      )
      .all() as Array<{
      workspaceId: string;
      sessionId: string;
      runId: string;
      runKind: "user" | "manual_compaction" | "subtask";
      triggerMessageId: string | null;
      executionPhase: import("@agent-workbench/shared").AgentRunExecutionPhase;
    }>;
  }

  isRecoverableRunCandidate(candidate: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    executionPhase: import("@agent-workbench/shared").AgentRunExecutionPhase;
  }) {
    const transaction = this.db.transaction(() => {
      const session = getMessageSessionById(this.db, candidate.sessionId);
      if (!session || session.workspaceId !== candidate.workspaceId)
        return false;
      const run = getRunRecord(this.db, candidate.runId);
      if (
        !run ||
        run.status !== "running" ||
        run.workspaceId !== candidate.workspaceId ||
        run.sessionId !== candidate.sessionId
      )
        return false;
      if (run.executionPhase === "terminal_intent_persisted") return true;
      const state = getMessageRunState(
        this.db,
        candidate.workspaceId,
        candidate.sessionId,
      );
      return (
        state?.status === "running" && state.activeRunId === candidate.runId
        && run.executionPhase === candidate.executionPhase
      );
    });
    return transaction();
  }
}
