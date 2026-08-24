import type { AgentControlResult, AgentForkSessionRequest, AgentSendMessageRequest, AgentSendMessageResponse, AgentSessionRecord } from "@agent-workbench/shared";
import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import type { AgentRuntimePort } from "../agent.runtime-port.js";
import type {
  RevertSessionCommand,
  SessionInteractionApplicationDependencies,
  SubtaskSessionMaterializationCommand
} from "./session-interaction-ports.js";

function titleOrDefault(title: string | undefined, fallback: string) {
  return (title || fallback).trim() || fallback;
}

export class SessionInteractionApplication {
  constructor(private readonly dependencies: SessionInteractionApplicationDependencies) {}

  listSessions(workspaceId: string): AgentSessionRecord[] {
    this.assertWorkspace(workspaceId);
    return this.dependencies.store.listSessions(workspaceId);
  }

  createPrimarySession(params: { workspaceId: string; title?: string }): AgentSessionRecord {
    return this.createSession({ workspaceId: params.workspaceId, title: params.title, kind: "primary" });
  }

  async forkPrimarySession(params: AgentForkSessionRequest): Promise<AgentSessionRecord> {
    const fromSession = this.dependencies.store.getSession(params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    if (fromSession.kind !== "primary") {
      throw new HttpError(400, "source session must be primary", "AGENT_FORK_SOURCE_KIND_INVALID");
    }
    return await this.dependencies.store.cloneSession({
      createdAt: this.dependencies.clock.nowMs(),
      id: this.dependencies.ids.newSessionId(),
      archiveAt: this.dependencies.clock.nowMs(),
      fromSession,
      fromItemId: params.fromItemId,
      mode: params.mode,
      title: params.title,
      targetKind: "primary",
      boundaryPolicy: "public-user-assistant"
    });
  }

  async sendMessage(params: { sessionId: string; body: AgentSendMessageRequest; runtime: AgentRuntimePort }): Promise<AgentSendMessageResponse> {
    const session = this.dependencies.store.getSession(params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.kind === "subtask") {
      throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
    }
    if (session.workspaceId !== params.body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const text = params.body.text.trim();
    if (!text) throw new HttpError(400, "text is required");
    // These fast paths are intentionally non-authoritative. Lifecycle repeats
    // them in its activation transaction after this user-facing validation order.
    const dedup = this.dependencies.store.findClientRequestDedup({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      clientRequestId: params.body.clientRequestId
    });
    if (dedup) return { sessionId: session.id, messageItemId: dedup.messageItemId, runId: dedup.runId, deduplicated: true };
    if (this.dependencies.store.getRunState(session.workspaceId, session.id).status !== "idle") {
      throw new HttpError(409, "session is running");
    }

    const profile = this.dependencies.profileReader.resolveUser({
      workspaceId: session.workspaceId,
      requestedAgentId: params.body.agentId
    });
    try {
      return await this.dependencies.lifecycleStarter.startUserRun({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        clientRequestId: params.body.clientRequestId,
        text,
        inputText: params.body.text,
        agentId: profile.agentId,
        providerId: profile.providerId,
        modelId: profile.modelId,
        uiLocale: this.dependencies.normalizeUiLocale(params.body.uiLocale),
        runtime: params.runtime
      });
    } catch (error) {
      if (this.dependencies.isConflict(error)) throw this.dependencies.toConflictHttpError(error);
      throw error;
    }
  }

  async revertSession(command: RevertSessionCommand): Promise<AgentControlResult> {
    const session = this.dependencies.store.getSession(command.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== command.body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const target = this.dependencies.store.getTranscriptItem(session.id, session.workspaceId, command.body.itemId);
    if (!target) throw new HttpError(400, "itemId is invalid");
    if (target.archiveAt != null) throw new HttpError(400, "itemId is archived", "AGENT_ARCHIVED_ITEM_IMMUTABLE");
    if (this.dependencies.store.getRunState(session.workspaceId, session.id).status !== "idle") {
      throw new HttpError(409, "session is running", "AGENT_REVERT_NOT_IDLE");
    }
    if (this.dependencies.store.hasNonTerminalItems(session.workspaceId, session.id)) {
      throw new HttpError(409, "session has non-terminal items", "AGENT_REVERT_HAS_NON_TERMINAL_ITEMS");
    }

    try {
      this.dependencies.store.moveHead({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        expectedHeadItemId: session.headItemId,
        nextHeadItemId: command.body.itemId,
        updatedAt: this.dependencies.clock.nowMs()
      });
    } catch (error) {
      if (this.dependencies.isConflict(error)) throw this.dependencies.toConflictHttpError(error);
      if (error instanceof Error && error.message === "invalid target head item") {
        throw new HttpError(400, "itemId is invalid");
      }
      throw error;
    }

    const updated = this.dependencies.store.getSession(session.id);
    if (!updated) throw new HttpError(500, "session not found after revert");
    const result: AgentControlResult = {
      ok: true,
      session: updated,
      runState: this.dependencies.store.getControlRunState(updated.id)
    };
    try {
      await command.runtime.cancelSession(session.id);
    } catch (error) {
      this.dependencies.logger.warn({ err: error, sessionId: session.id }, "cancel session runtime after revert failed");
    }
    return result;
  }

  async resolveSubtaskSessionForStart(command: SubtaskSessionMaterializationCommand) {
    const requestedSessionId = String(command.session.sessionId || "").trim();
    if (command.session.mode === "existing") {
      if (!requestedSessionId) throw new HttpError(400, "existing sessionId is required", AgentSubtaskErrorCode.ExistingSessionRequired);
      const session = this.dependencies.store.getSession(requestedSessionId);
      if (!session) throw new HttpError(404, "subtask session not found", AgentSubtaskErrorCode.SessionNotFound);
      if (session.workspaceId !== command.workspaceId) throw new HttpError(400, "subtask session workspace mismatch", AgentSubtaskErrorCode.WorkspaceMismatch);
      if (session.kind !== "subtask") throw new HttpError(400, "existing session must be subtask", AgentSubtaskErrorCode.KindMismatch);
      return { session, createdSessionId: null };
    }
    if (requestedSessionId) {
      throw new HttpError(400, `sessionId is not allowed when mode=${command.session.mode}`, AgentSubtaskErrorCode.SessionIdNotAllowed);
    }
    if (command.session.mode === "new") {
      const session = this.createSession({
        workspaceId: command.workspaceId,
        title: command.subtaskTitleBase,
        kind: "subtask",
        forkedFromSessionId: command.parentSessionId,
        forkedFromItemId: command.parentToolItemId
      });
      return { session, createdSessionId: session.id };
    }
    if (command.shouldUsePreforkSummary || command.forkBoundaryItemId == null) {
      const session = this.createSession({
        workspaceId: command.workspaceId,
        title: `${command.subtaskTitleBase} (fork)`,
        kind: "subtask",
        ...(command.shouldUsePreforkSummary ? {
          forkedFromSessionId: command.parentSessionId,
          forkedFromItemId: command.parentToolItemId
        } : {})
      });
      return { session, createdSessionId: session.id };
    }
    const fromSession = this.dependencies.store.getSession(command.parentSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    const session = await this.dependencies.store.cloneSession({
      createdAt: this.dependencies.clock.nowMs(),
      id: this.dependencies.ids.newSessionId(),
      archiveAt: this.dependencies.clock.nowMs(),
      fromSession,
      fromItemId: command.forkBoundaryItemId,
      mode: "visible_only",
      title: `${command.subtaskTitleBase} (fork)`,
      targetKind: "subtask",
      boundaryPolicy: "internal-resolved"
    });
    return { session, createdSessionId: session.id };
  }

  private createSession(params: { workspaceId: string; title?: string; kind: "primary" | "subtask"; forkedFromSessionId?: string | null; forkedFromItemId?: number | null }) {
    this.assertWorkspace(params.workspaceId);
    const createdAt = this.dependencies.clock.nowMs();
    const id = this.dependencies.ids.newSessionId();
    this.dependencies.store.createSession({
      id,
      workspaceId: params.workspaceId,
      title: titleOrDefault(params.title, "新会话"),
      kind: params.kind,
      createdAt,
      forkedFromSessionId: params.forkedFromSessionId ?? null,
      forkedFromItemId: params.forkedFromItemId ?? null
    });
    const session = this.dependencies.store.getSession(id);
    if (!session) throw new HttpError(500, "failed to create session");
    return session;
  }

  private assertWorkspace(workspaceId: string) {
    if (!this.dependencies.store.workspaceExists(workspaceId)) throw new HttpError(404, "workspace not found");
  }
}
