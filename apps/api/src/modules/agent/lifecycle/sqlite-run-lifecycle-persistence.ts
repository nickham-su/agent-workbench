import type { AgentContextItemOutput } from "@agent-workbench/shared";
import type { AgentApiRunCompleteRequest, AgentApiRunStateRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { Db } from "../../../infra/db/db.js";
import type { SubtaskChildActivationInput, SubtaskChildActivationResult, SubtaskChildRunActivator } from "../subtask/subtask-ports.js";
import {
  appendContextItem,
  createRunRecord,
  failNonTerminalContextItemsByRunId,
  failRunRecordIfInFlight,
  findClientRequestDedup,
  getAgentSession,
  getContextItemById,
  getLatestSessionItemId,
  getRunRecord,
  getRunState,
  getSessionHead,
  insertContextItemAttachments,
  insertClientRequestDedup,
  listInFlightSessionsWithoutActiveRunId,
  listNonTerminalRunIdsByItemIds,
  listNonTerminalRunIdsBySession,
  listNonTerminalSessionItemIds,
  listNonTerminalSessionItemIdsByRunId,
  listRecoverableRuns,
  setRunStateIdleIfActiveRunMatches,
  setRunStateIdleIfNoActiveRun,
  setRunStateIdle,
  updateContextItem,
  updateRunRecordStatus,
  updateAgentSessionTitle,
  updateRunState
} from "../agent.store.js";
import type {
  AtomicLifecyclePersistence,
  CancelSessionSnapshot,
  CancelSessionsInput,
  CancelSessionsResult,
  EnqueueFailureInput,
  EnqueueFailureSettlement,
  UserRunActivationInput,
  UserRunActivationResult
} from "./run-lifecycle-ports.js";

const NON_TERMINAL_ITEM_STATUS = new Set(["streaming", "queued", "running"] as const);
const TERMINAL_RUN_RECORD_STATUS = new Set(["completed", "failed", "cancelled"] as const);

function toSessionTitleFromFirstMessage(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "新会话";
  if (compact.length <= 50) return compact;
  return `${compact.slice(0, 49)}…`;
}

function normalizeRunNoticeText(raw: unknown) {
  if (raw == null) return "";
  const value = String(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\0/g, "")
    .trim();
  if (!value) return "";
  if (value.length <= 1000) return value;
  return `${value.slice(0, 1000)}...`;
}

function parseSubtaskSessionIdFromToolText(text: unknown) {
  if (typeof text !== "string") return "";
  const match = text.match(/(?:^|\n)subtask_session_id:\s*([^\s]+)/);
  return match ? String(match[1] || "").trim() : "";
}

function toTerminalCancelledOutput(output: AgentContextItemOutput) {
  if (!output || output.type !== "tool" || output.toolName !== "subtask") return output;
  const result = output.result && typeof output.result === "object" ? (output.result as Record<string, unknown>) : null;
  const fromResult = typeof result?.subtaskSessionId === "string" ? result.subtaskSessionId.trim() : "";
  const subtaskSessionId = fromResult || parseSubtaskSessionIdFromToolText(output.text);
  const body = subtaskSessionId
    ? `Subtask was cancelled. To continue it later, call subtask with session: { mode: "existing", sessionId: "${subtaskSessionId}" }.`
    : "Subtask was cancelled.";
  const nextResult = result
    ? { ...result, ...(subtaskSessionId && !fromResult ? { subtaskSessionId } : {}) }
    : output.result;
  const text = ["tool: subtask", "status: cancelled", ...(subtaskSessionId ? [`subtask_session_id: ${subtaskSessionId}`] : []), "", body].join("\n");
  return { ...output, text, ...(nextResult !== output.result ? { result: nextResult } : {}) };
}

export class SqliteRunLifecyclePersistence implements AtomicLifecyclePersistence, SubtaskChildRunActivator {
  constructor(private readonly db: Db) {}

  activateUserRun(input: UserRunActivationInput): UserRunActivationResult {
    const transaction = this.db.transaction(() => {
      const dedup = findClientRequestDedup(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId
      });
      if (dedup) return { kind: "deduplicated" as const, ...dedup };

      const runState = getRunState(this.db, input.workspaceId, input.sessionId);
      if (runState.status !== "idle") return { kind: "session-running" as const };

      const head = getSessionHead(this.db, input.workspaceId, input.sessionId);
      const item = appendContextItem(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
        turnId: null,
        step: null,
        prevId: head,
        kind: "user",
        status: "completed",
        output: input.images.length > 0
          ? { type: "user_message", text: input.text, attachments: input.images.map((image) => ({ attachmentId: image.attachmentId, kind: "image", filename: image.filename, mediaType: image.mediaType, size: image.byteSize })) }
          : { type: "user_text", text: input.text },
        createdAt: input.createdAt
      });
      if (input.images.length > 0) {
        insertContextItemAttachments(this.db, { workspaceId: input.workspaceId, contextItemId: item.id, attachments: input.images, createdAt: input.createdAt });
      }
      if (head == null) {
        updateAgentSessionTitle(this.db, {
          sessionId: input.sessionId,
          title: toSessionTitleFromFirstMessage(input.text),
          updatedAt: input.createdAt
        });
      }
      insertClientRequestDedup(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        messageItemId: item.id,
        runId: input.runId,
        createdAt: input.createdAt
      });
      createRunRecord(this.db, {
        runId: input.runId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        triggerItemId: item.id,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        uiLocale: input.uiLocale,
        subtaskDepth: 0,
        parentRunId: null,
        parentToolItemId: null,
        status: "running",
        createdAt: input.createdAt
      });
      updateRunState(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        status: "running",
        activeRunId: input.runId,
        activeAssistantItemId: null,
        runNoticeText: "",
        updatedAt: input.createdAt,
        appliedItemId: item.id
      });
      return { kind: "activated" as const, messageItemId: item.id, runId: input.runId };
    });
    return transaction();
  }

  activate(input: SubtaskChildActivationInput): SubtaskChildActivationResult {
    const transaction = this.db.transaction(() => {
      const state = getRunState(this.db, input.workspaceId, input.sessionId);
      if (state.status !== "idle") return { kind: "session-running" as const };

      let head = getSessionHead(this.db, input.workspaceId, input.sessionId);
      let promptItemId: number | null = null;
      for (const seed of input.seedItems) {
        const item = appendContextItem(this.db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          runId: seed.attachToRun ? input.runId : null,
          turnId: null,
          step: null,
          prevId: head,
          kind: seed.kind,
          status: "completed",
          output: seed.kind === "system"
            ? { type: "system_text", text: seed.text }
            : { type: "user_text", text: seed.text },
          createdAt: input.createdAt
        });
        head = item.id;
        if (seed.attachToRun) promptItemId = item.id;
      }
      if (promptItemId == null) throw new Error("subtask child activation requires a prompt item");

      createRunRecord(this.db, {
        runId: input.runId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        triggerItemId: promptItemId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        uiLocale: input.uiLocale,
        subtaskDepth: input.subtaskDepth,
        parentRunId: input.parentRunId,
        parentToolItemId: input.parentToolItemId,
        status: "running",
        createdAt: input.createdAt
      });
      updateRunState(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        status: "running",
        activeRunId: input.runId,
        activeAssistantItemId: null,
        runNoticeText: "",
        updatedAt: input.createdAt,
        appliedItemId: promptItemId
      });
      return { kind: "activated" as const, promptItemId };
    });
    return transaction();
  }

  failRunAfterEnqueueFailureIfCurrent(input: EnqueueFailureInput): EnqueueFailureSettlement {
    const transaction = this.db.transaction(() => {
      const run = getRunRecord(this.db, input.runId);
      if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId) return "missing-or-mismatch" as const;
      if (TERMINAL_RUN_RECORD_STATUS.has(run.status as "completed" | "failed" | "cancelled")) return "already-terminal" as const;
      updateRunRecordStatus(this.db, { runId: input.runId, status: "failed", updatedAt: input.updatedAt });
      const state = getRunState(this.db, input.workspaceId, input.sessionId);
      if (state.activeRunId !== input.runId) return "run-failed-state-not-current" as const;
      setRunStateIdle(this.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        updatedAt: input.updatedAt,
        appliedItemId: getLatestSessionItemId(this.db, input.workspaceId, input.sessionId)
      });
      return "failed-and-idled" as const;
    });
    return transaction();
  }

  getCancelSessionSnapshot(sessionId: string): CancelSessionSnapshot | null {
    const session = getAgentSession(this.db, sessionId);
    if (!session) return null;
    return { sessionId: session.id, workspaceId: session.workspaceId, session, runState: getRunState(this.db, session.workspaceId, session.id) };
  }

  cancelSessions(input: CancelSessionsInput): CancelSessionsResult {
    const transaction = this.db.transaction(() => {
      const cancelledRunIds = new Set<string>();
      const visited = new Set<string>();
      const queue = [input.rootSessionId];
      const sessionIds: string[] = [];
      while (queue.length > 0) {
        const sessionId = queue.shift();
        if (!sessionId || visited.has(sessionId)) continue;
        visited.add(sessionId);
        const session = getAgentSession(this.db, sessionId);
        if (!session || session.workspaceId !== input.workspaceId) continue;
        const state = getRunState(this.db, session.workspaceId, session.id);
        if (session.id !== input.rootSessionId && (state.status !== "running" || !state.activeRunId)) continue;
        sessionIds.push(session.id);
        if (state.status === "running" && state.activeRunId) {
          for (const childSessionId of input.listActiveChildSessionIds({
            workspaceId: session.workspaceId,
            sessionId: session.id,
            runId: state.activeRunId
          })) {
            if (!visited.has(childSessionId)) queue.push(childSessionId);
          }
        }
        const itemIds = new Set(listNonTerminalSessionItemIds(this.db, session.workspaceId, session.id));
        const runIds = new Set(listNonTerminalRunIdsBySession(this.db, { workspaceId: session.workspaceId, sessionId: session.id }));
        for (const runId of listNonTerminalRunIdsByItemIds(this.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          itemIds: [...itemIds]
        })) runIds.add(runId);

        for (const itemId of itemIds) {
          const item = getContextItemById(this.db, itemId);
          if (!item || !NON_TERMINAL_ITEM_STATUS.has(item.status as "streaming" | "queued" | "running")) continue;
          updateContextItem(this.db, {
            itemId,
            status: "cancelled",
            output: toTerminalCancelledOutput(item.output),
            updatedAt: input.updatedAt
          });
        }
        setRunStateIdle(this.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          updatedAt: input.updatedAt,
          appliedItemId: getLatestSessionItemId(this.db, session.workspaceId, session.id)
        });
        for (const runId of runIds) {
          updateRunRecordStatus(this.db, { runId, status: "cancelled", updatedAt: input.updatedAt });
          cancelledRunIds.add(runId);
        }
        if (state.activeRunId && !runIds.has(state.activeRunId)) {
          updateRunRecordStatus(this.db, { runId: state.activeRunId, status: "cancelled", updatedAt: input.updatedAt });
          cancelledRunIds.add(state.activeRunId);
        }
      }
      const root = getAgentSession(this.db, input.rootSessionId);
      if (!root) throw new Error("cancel root session not found after cancel");
      return {
        rootSessionId: root.id,
        runtimeCancelSessionIds: sessionIds,
        cancelledRunIds: [...cancelledRunIds]
      };
    });
    return transaction();
  }

  updateRunStateFromWorker(params: AgentApiRunStateRequest) {
    const transaction = this.db.transaction(() => {
      const currentState = getRunState(this.db, params.workspaceId, params.sessionId);
      const activeRunId = typeof params.activeRunId === "string" && params.activeRunId.trim() ? params.activeRunId : null;
      const activeRun = activeRunId ? getRunRecord(this.db, activeRunId) : null;
      if (activeRunId && currentState.activeRunId && currentState.activeRunId !== activeRunId) return;
      // A late idle/null writeback carries no run identity. It must not clear a
      // newer durable in-flight run; terminal ownership belongs to completeRunFromWorker.
      // Keep the existing idle clearing behavior for legacy state-only updates that
      // have no corresponding run record.
      const currentActiveRun = currentState.activeRunId ? getRunRecord(this.db, currentState.activeRunId) : null;
      if (
        params.status === "idle"
        && !activeRunId
        && currentActiveRun
        && currentActiveRun.workspaceId === params.workspaceId
        && currentActiveRun.sessionId === params.sessionId
        && !TERMINAL_RUN_RECORD_STATUS.has(currentActiveRun.status as "completed" | "failed" | "cancelled")
      ) return;
      if (activeRunId && activeRun) {
        if (activeRun.workspaceId !== params.workspaceId || activeRun.sessionId !== params.sessionId) return;
        if (TERMINAL_RUN_RECORD_STATUS.has(activeRun.status as "completed" | "failed" | "cancelled")) return;
      }
      const appliedItemId = getLatestSessionItemId(this.db, params.workspaceId, params.sessionId);
      const hasLastResponseTotalTokens = Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens");
      const hasRunNoticeText = Object.prototype.hasOwnProperty.call(params, "runNoticeText");
      updateRunState(this.db, {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        status: params.status,
        activeRunId,
        activeAssistantItemId: params.activeAssistantItemId,
        ...(hasLastResponseTotalTokens ? { lastResponseTotalTokens: params.lastResponseTotalTokens ?? null } : {}),
        ...(hasRunNoticeText
          ? { runNoticeText: normalizeRunNoticeText(params.runNoticeText) }
          : params.status === "idle"
            ? { runNoticeText: "" }
            : {}),
        updatedAt: params.updatedAt ?? 0,
        appliedItemId
      });
      if (activeRunId) updateRunRecordStatus(this.db, { runId: activeRunId, status: "running", updatedAt: params.updatedAt ?? 0 });
    });
    transaction();
  }

  completeRunFromWorker(params: AgentApiRunCompleteRequest) {
    const transaction = this.db.transaction(() => {
      const run = getRunRecord(this.db, params.runId);
      if (!run || run.workspaceId !== params.workspaceId || run.sessionId !== params.sessionId) return false;
      if (TERMINAL_RUN_RECORD_STATUS.has(run.status as "completed" | "failed" | "cancelled")) return false;
      updateRunRecordStatus(this.db, { runId: params.runId, status: params.status, updatedAt: params.updatedAt ?? 0 });
      if (params.status === "cancelled") {
        for (const itemId of listNonTerminalSessionItemIdsByRunId(this.db, params)) {
          const item = getContextItemById(this.db, itemId);
          if (!item || item.workspaceId !== params.workspaceId || item.sessionId !== params.sessionId || item.runId !== params.runId) continue;
          updateContextItem(this.db, {
            itemId,
            status: "cancelled",
            ...(item.kind === "tool" && item.output.type === "tool" ? { output: toTerminalCancelledOutput(item.output) } : {}),
            updatedAt: params.updatedAt ?? 0
          });
        }
      }
      const state = getRunState(this.db, params.workspaceId, params.sessionId);
      if (state.activeRunId === params.runId) {
        setRunStateIdle(this.db, {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          updatedAt: params.updatedAt ?? 0,
          appliedItemId: getLatestSessionItemId(this.db, params.workspaceId, params.sessionId)
        });
      }
      return true;
    });
    return transaction();
  }

  listRecoverableRunCandidates() {
    return listRecoverableRuns(this.db).map(({ workspaceId, sessionId, runId, triggerItemId }) => ({
      workspaceId,
      sessionId,
      runId,
      triggerItemId
    }));
  }

  isRecoverableRunCandidate(candidate: { workspaceId: string; sessionId: string; runId: string }) {
    const transaction = this.db.transaction(() => {
      const session = getAgentSession(this.db, candidate.sessionId);
      if (!session || session.workspaceId !== candidate.workspaceId) return false;
      const run = getRunRecord(this.db, candidate.runId);
      if (
        !run
        || run.status !== "running"
        || run.workspaceId !== candidate.workspaceId
        || run.sessionId !== candidate.sessionId
      ) return false;
      const state = getRunState(this.db, candidate.workspaceId, candidate.sessionId);
      return state.status === "running" && state.activeRunId === candidate.runId;
    });
    return transaction();
  }

  failNonTerminalContextItemsForRecovery(input: { runId: string; updatedAt: number }) {
    return failNonTerminalContextItemsByRunId(this.db, input);
  }

  failRunRecordForRecovery(input: { runId: string; updatedAt: number }) {
    return failRunRecordIfInFlight(this.db, input);
  }

  reclaimRunStateForRecovery(input: { workspaceId: string; sessionId: string; runId: string; updatedAt: number }) {
    return setRunStateIdleIfActiveRunMatches(this.db, {
      ...input,
      appliedItemId: getLatestSessionItemId(this.db, input.workspaceId, input.sessionId)
    });
  }

  appendRecoveryFailureNotice(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    text: string;
    createdAt: number;
  }) {
    appendContextItem(this.db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: null,
      step: null,
      prevId: getSessionHead(this.db, input.workspaceId, input.sessionId),
      kind: "system",
      status: "completed",
      boundaryReason: null,
      output: { type: "system_text", text: input.text },
      createdAt: input.createdAt
    });
  }

  listInFlightSessionsWithoutActiveRunId() {
    return listInFlightSessionsWithoutActiveRunId(this.db);
  }

  reclaimDirtyRunStateForRecovery(input: { workspaceId: string; sessionId: string; updatedAt: number }) {
    return setRunStateIdleIfNoActiveRun(this.db, {
      ...input,
      appliedItemId: getLatestSessionItemId(this.db, input.workspaceId, input.sessionId)
    });
  }
}
