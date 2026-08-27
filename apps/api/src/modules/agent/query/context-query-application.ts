import type {
  AgentContextItemRecord,
  AgentContextItemsResponse,
  AgentSessionRunState,
  AgentSessionStatusSummaryResponse,
  AgentSubtaskRunSummary
} from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { ContextItemsQuery, ContextQueryApplicationDependencies } from "./context-query-ports.js";
import type { SubtaskParentKey, SubtaskRunProjectionRecord } from "./context-query-read-model.js";

const SUBTASK_RUN_PARENT_CONFLICT = "AGENT_SUBTASK_RUN_PARENT_CONFLICT";

function parentKey(parentRunId: string, parentToolItemId: number) {
  return JSON.stringify([parentRunId, parentToolItemId]);
}

function toSubtaskParentKey(item: AgentContextItemRecord): SubtaskParentKey | null {
  if (item.kind !== "tool" || item.output.type !== "tool" || item.output.toolName !== "subtask") return null;
  // The trimmed value only validates whitespace. Lineage must use the exact stored run id.
  if (typeof item.runId !== "string" || !item.runId.trim()) return null;
  if (!Number.isSafeInteger(item.id) || item.id <= 0) return null;
  return { parentRunId: item.runId, parentToolItemId: item.id };
}

function toSubtaskRunSummary(record: SubtaskRunProjectionRecord): AgentSubtaskRunSummary | null {
  const startedAt = Number(record.createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  if (record.status === "running") {
    return { runId: record.runId, status: "running", startedAt, endedAt: null, durationMs: null };
  }
  if (record.status !== "completed" && record.status !== "failed" && record.status !== "cancelled") return null;
  const endedAt = Number(record.updatedAt);
  if (!Number.isFinite(endedAt) || endedAt <= 0) return null;
  return {
    runId: record.runId,
    status: record.status,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt)
  };
}

function toFiniteNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export class ContextQueryApplication {
  constructor(private readonly dependencies: ContextQueryApplicationDependencies) {}

  getContextItems(sessionId: string, query?: ContextItemsQuery): AgentContextItemsResponse {
    const session = this.findSession(sessionId);
    const afterId = toFiniteNumber(query?.afterId);
    const tailLimit = toFiniteNumber(query?.tailLimit);
    const beforeId = toFiniteNumber(query?.beforeId);
    const limit = toFiniteNumber(query?.limit);
    const expectedHeadItemId = toFiniteNumber(query?.expectedHeadItemId);
    const hasAfter = afterId != null && afterId > 0;
    const hasTail = tailLimit != null && tailLimit > 0;
    const hasBefore = beforeId != null && beforeId > 0;

    if (Number(hasAfter) + Number(hasTail) + Number(hasBefore) > 1) {
      throw new HttpError(400, "invalid context-items query", "AGENT_CONTEXT_ITEMS_QUERY_INVALID");
    }

    let hasMoreBefore: boolean | undefined;
    const items = hasTail
      ? (() => {
          const window = this.dependencies.store.getTailWindow(session.workspaceId, session.id, tailLimit!);
          hasMoreBefore = window.hasMoreBefore;
          return window.items;
        })()
      : hasBefore
        ? (() => {
            if (expectedHeadItemId != null && expectedHeadItemId > 0) {
              const expected = Math.floor(expectedHeadItemId);
              if (session.headItemId == null || session.headItemId < expected) {
                throw new HttpError(409, "session head conflict", "AGENT_CONTEXT_ITEMS_HEAD_MOVED");
              }
            }
            const window = this.dependencies.store.getBeforeWindow({
              workspaceId: session.workspaceId,
              sessionId: session.id,
              beforeId: Math.floor(beforeId!),
              limit: limit != null ? limit : 100
            });
            hasMoreBefore = window.hasMoreBefore;
            return window.items;
          })()
        : hasAfter
          ? this.dependencies.store.listAfterWindow({ workspaceId: session.workspaceId, sessionId: session.id, afterId: Math.floor(afterId!) })
          : this.dependencies.store.listTranscript(session.workspaceId, session.id);

    const runState = this.dependencies.store.getRunState(session.workspaceId, session.id);
    return {
      sessionId: session.id,
      headItemId: session.headItemId,
      appliedItemId: runState.appliedItemId,
      ...(typeof hasMoreBefore === "boolean" ? { hasMoreBefore } : {}),
      items: this.enrichSubtaskRuns(session.workspaceId, items)
    };
  }

  getContextItem(sessionId: string, itemId: number): AgentContextItemRecord {
    const session = this.findSession(sessionId);
    const item = this.dependencies.store.getTranscriptItem(session.workspaceId, session.id, itemId);
    if (!item) throw new HttpError(404, "context item not found");
    return this.enrichSubtaskRuns(session.workspaceId, [item])[0]!;
  }

  private enrichSubtaskRuns(workspaceId: string, items: AgentContextItemRecord[]) {
    const keys = items.flatMap((item) => {
      const key = toSubtaskParentKey(item);
      return key ? [key] : [];
    });
    if (keys.length === 0) return items;

    const records = this.dependencies.store.listSubtaskRunProjectionsByParentTools({ workspaceId, parents: keys });
    const recordsByParent = new Map<string, SubtaskRunProjectionRecord[]>();
    for (const record of records) {
      const key = parentKey(record.parentRunId, record.parentToolItemId);
      const grouped = recordsByParent.get(key);
      if (grouped) grouped.push(record);
      else recordsByParent.set(key, [record]);
    }

    const conflicts = new Set<string>();
    for (const [key, matches] of recordsByParent) {
      if (matches.length < 2) continue;
      conflicts.add(key);
      const [parentRunId, parentToolItemId] = JSON.parse(key) as [string, number];
      this.dependencies.logger.error({
        diagnosticCode: SUBTASK_RUN_PARENT_CONFLICT,
        workspaceId,
        parentRunId,
        parentToolItemId,
        runIds: matches.map((match) => match.runId).sort(),
        matchCount: matches.length
      }, "multiple subtask runs matched one parent tool");
    }

    return items.map((item) => {
      const key = toSubtaskParentKey(item);
      if (!key) return item;
      const encodedKey = parentKey(key.parentRunId, key.parentToolItemId);
      if (conflicts.has(encodedKey)) return item;
      const record = recordsByParent.get(encodedKey)?.[0];
      const subtaskRun = record ? toSubtaskRunSummary(record) : null;
      return subtaskRun ? { ...item, subtaskRun } : item;
    });
  }

  async getApplyPatchUiArtifact(params: { sessionId: string; itemId: number }) {
    const item = this.getContextItem(params.sessionId, params.itemId);
    const toolCallId = this.assertArtifactTool(item, "apply_patch", "apply_patch artifact not found");
    return await this.dependencies.uiArtifacts.readApplyPatch({ workspaceId: item.workspaceId, toolCallId });
  }

  async getWriteUiArtifact(params: { sessionId: string; itemId: number }) {
    const item = this.getContextItem(params.sessionId, params.itemId);
    const toolCallId = this.assertArtifactTool(item, "write", "write artifact not found");
    return await this.dependencies.uiArtifacts.readWrite({ workspaceId: item.workspaceId, toolCallId });
  }

  getRunState(sessionId: string): AgentSessionRunState {
    const session = this.findSession(sessionId);
    const state = this.dependencies.store.getRunState(session.workspaceId, session.id);
    const latestTerminalRun = this.dependencies.store.getLatestTerminalRun({ workspaceId: session.workspaceId, sessionId: session.id });
    const lastTerminalStatus = latestTerminalRun && state.status === "idle" && latestTerminalRun.updatedAt === state.updatedAt
      ? latestTerminalRun.status
      : null;
    const activeRun = this.findOwnedRun(session, state.activeRunId, "run-state has activeRunId but run record not found", "run-state activeRunId does not belong to the session");
    const contextRun = activeRun ?? latestTerminalRun ?? null;
    let contextWindowTokens: number | null = null;
    if (contextRun) {
      try {
        const rawTokens = Number(this.dependencies.resolveContextWindowTokens({
          workspaceId: session.workspaceId,
          sessionKind: session.kind,
          run: contextRun
        }));
        if (Number.isFinite(rawTokens) && rawTokens >= 1) contextWindowTokens = Math.floor(rawTokens);
      } catch (err) {
        this.dependencies.logger.warn(
          { err, sessionId: session.id, workspaceId: session.workspaceId, runId: contextRun.runId },
          "resolve context-window tokens failed for run-state"
        );
      }
    }
    const contextTokenRatio = typeof state.lastResponseTotalTokens === "number" && contextWindowTokens != null
      ? state.lastResponseTotalTokens / contextWindowTokens
      : null;
    const lastRun = latestTerminalRun
      ? {
          runId: latestTerminalRun.runId,
          status: latestTerminalRun.status,
          startedAt: latestTerminalRun.createdAt,
          endedAt: latestTerminalRun.updatedAt,
          durationMs: Math.max(0, latestTerminalRun.updatedAt - latestTerminalRun.createdAt)
        }
      : null;
    return {
      sessionId: session.id,
      status: state.status,
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      activeRun: activeRun ? { runId: activeRun.runId, startedAt: activeRun.createdAt } : null,
      lastResponseTotalTokens: state.lastResponseTotalTokens,
      runNoticeText: state.runNoticeText,
      nonTerminalItemIds: this.dependencies.store.listNonTerminalVisibleItemIds(session.workspaceId, session.id),
      updatedAt: state.updatedAt,
      lastTerminalStatus,
      appliedItemId: state.appliedItemId,
      lastRun,
      contextWindowTokens,
      contextTokenRatio
    };
  }

  getSessionStatusSummary(params: { sessionId: string; agentId?: string | null; selectedAgentId?: string | null }): AgentSessionStatusSummaryResponse {
    const sessionId = String(params.sessionId || "").trim();
    if (!sessionId) throw new HttpError(400, "sessionId is required", "SESSION_ID_REQUIRED");
    const session = this.dependencies.store.getSession(sessionId);
    if (!session) throw new HttpError(404, "session not found", "SESSION_NOT_FOUND");
    const runState = this.getRunState(session.id);
    const generatedAt = this.dependencies.clock.nowMs();
    const activeRun = runState.activeRunId ? this.dependencies.store.getRun(runState.activeRunId) : null;
    const startedAt = activeRun && activeRun.workspaceId === session.workspaceId && activeRun.sessionId === session.id ? activeRun.createdAt : null;
    const selectedAgentId = String(
      typeof params.selectedAgentId === "string" && params.selectedAgentId.trim() ? params.selectedAgentId : params.agentId || ""
    ).trim();
    const agent = selectedAgentId
      ? this.dependencies.availableAgentQuery.findUserDisplayAgent({ workspaceId: session.workspaceId, agentId: selectedAgentId })
      : null;
    if (selectedAgentId && !agent) throw new HttpError(400, "Agent not found", "AGENT_NOT_FOUND");
    const workspace = this.dependencies.store.getWorkspace(session.workspaceId);
    return {
      updatedAt: Math.max(session.updatedAt, runState.updatedAt, startedAt ?? 0),
      generatedAt,
      session: { ...session, workspaceTitle: workspace?.title, workspaceDirName: workspace?.dirName },
      agent,
      runState: { ...runState, terminalStatus: runState.lastTerminalStatus },
      startedAt,
      elapsedMs: startedAt == null ? null : Math.max(0, generatedAt - startedAt),
      contextWindowTokens: runState.contextWindowTokens ?? null,
      contextTokenRatio: runState.contextTokenRatio ?? null
    };
  }

  private findSession(sessionId: string) {
    const session = this.dependencies.store.getSession(sessionId);
    if (!session) throw new HttpError(404, "session not found");
    return session;
  }

  private assertArtifactTool(item: AgentContextItemRecord, expectedName: "apply_patch" | "write", message: string) {
    if (item.kind !== "tool" || item.output.type !== "tool" || item.output.toolName !== expectedName) throw new HttpError(404, message);
    const toolCallId = typeof item.output.toolCallId === "string" ? item.output.toolCallId.trim() : "";
    if (!toolCallId) throw new HttpError(404, message);
    return toolCallId;
  }

  private findOwnedRun(
    session: { id: string; workspaceId: string },
    activeRunId: string | null,
    missingMessage: string,
    mismatchMessage: string
  ) {
    if (!activeRunId) return null;
    const run = this.dependencies.store.getRun(activeRunId);
    if (!run) {
      this.dependencies.logger.warn({ sessionId: session.id, workspaceId: session.workspaceId, activeRunId }, missingMessage);
      return null;
    }
    if (run.workspaceId !== session.workspaceId || run.sessionId !== session.id) {
      this.dependencies.logger.warn(
        { sessionId: session.id, workspaceId: session.workspaceId, activeRunId, runWorkspaceId: run.workspaceId, runSessionId: run.sessionId },
        mismatchMessage
      );
      return null;
    }
    return run;
  }
}
