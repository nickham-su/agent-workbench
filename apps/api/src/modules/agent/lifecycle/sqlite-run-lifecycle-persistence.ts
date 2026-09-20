import type { Db } from "../../../infra/db/db.js";
import { assertAgentImageByteSize } from "../attachments/agent-attachment-storage.js";
import { assertAgentAttachmentId, assertAgentAttachmentTempId } from "../attachments/agent-attachment-paths.js";
import {
  appendMessage,
  getMessageSessionHead,
  getMessageRunState,
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

function validateUserRunImages(input: UserRunActivationInput) {
  const attachmentIds = new Set<string>();
  const storageKeys = new Set<string>();
  for (let index = 0; index < input.images.length; index += 1) {
    const image = input.images[index]!;
    if (image.position !== index) throw new Error("invalid agent image position");
    assertAgentAttachmentId(image.attachmentId);
    assertAgentAttachmentTempId(image.tempId);
    if (image.storageKey !== image.attachmentId) {
      throw new Error("invalid agent image storage key");
    }
    if (attachmentIds.has(image.attachmentId) || storageKeys.has(image.storageKey)) {
      throw new Error("duplicate agent image attachment");
    }
    if (
      image.filename.length < 1 ||
      [...image.filename].length > 255 ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mediaType)
    ) {
      throw new Error("invalid agent image metadata");
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

  activateUserRun(input: UserRunActivationInput): UserRunActivationResult {
    const transaction = this.db.transaction(() => {
      const dedup = findMessageClientRequestDedup(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
      });
      if (dedup) return { kind: "deduplicated" as const, ...dedup };
      const runState = getMessageRunState(
        this.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!runState || runState.status !== "idle")
        return { kind: "session-running" as const };
      const session = getMessageSession(
        this.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!session) throw new Error("agent session not found");
      validateUserRunImages(input);
      const insertAttachment = this.db.prepare(
        `insert into agent_attachment
          (id, workspace_id, storage_key, filename, media_type, byte_size, created_at)
          values (@attachmentId, @workspaceId, @storageKey, @filename, @mediaType, @byteSize, @createdAt)`,
      );
      for (const image of input.images) {
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
    return transaction();
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
      const state = getMessageRunState(
        this.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!state || state.status !== "idle")
        return { kind: "session-running" as const };
      const parentFence = this.db.prepare(`
        select 1
        from agent_run parent_run
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
      `).get(input);
      if (!parentFence) return { kind: "parent-not-active" as const };
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
    return transaction();
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
      if (run.executionPhase !== "work_pending" && run.executionPhase !== "work_in_progress") {
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
    const visited = new Set<string>();
    const queue = [input.rootSessionId];
    const sessionIds: string[] = [];
    while (queue.length > 0) {
      const sessionId = queue.shift();
      if (!sessionId || visited.has(sessionId)) continue;
      visited.add(sessionId);
      const session = getMessageSessionById(this.db, sessionId);
      if (!session || session.workspaceId !== input.workspaceId) continue;
      const state = getMessageRunState(this.db, session.workspaceId, session.id);
      if (!state?.activeRunId || state.status !== "running") continue;
      sessionIds.push(session.id);
      for (const childSessionId of input.listActiveChildSessionIds({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        runId: state.activeRunId,
      })) {
        if (!visited.has(childSessionId)) queue.push(childSessionId);
      }
    }
    return sessionIds;
  }

  cancelSessions(input: CancelSessionsInput): CancelSessionsResult {
    const transaction = this.db.transaction(() => {
      const cancelledRunIds = new Set<string>();
      const terminalIntents: Array<{ workspaceId: string; sessionId: string; runId: string }> = [];
      const sessionIds = this.listActiveSessionIdsForCancel(input);
      for (const sessionId of sessionIds) {
        const session = getMessageSessionById(this.db, sessionId);
        if (!session) continue;
        const messageState = getMessageRunState(this.db, session.workspaceId, session.id);
        if (!messageState?.activeRunId || messageState.status !== "running") continue;
        persistRunTerminalIntent(this.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId: messageState.activeRunId,
          status: "cancelled",
          code: "run_cancelled",
          detail: null,
          updatedAt: input.updatedAt,
        });
        cancelledRunIds.add(messageState.activeRunId);
        terminalIntents.push({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId: messageState.activeRunId,
        });
      }
      const root = getMessageSessionById(this.db, input.rootSessionId);
      if (!root) throw new Error("cancel root session not found after cancel");
      return {
        rootSessionId: root.id,
        runtimeCancelSessionIds: sessionIds,
        cancelledRunIds: [...cancelledRunIds],
        terminalIntents,
      };
    });
    return transaction();
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
