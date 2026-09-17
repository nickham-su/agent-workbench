import type { AgentForkSessionRequest, AgentSendMessageResponse, AgentSessionRecord, AgentUpdateSessionTitleRequest } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentMessageControlResult } from "@agent-workbench/shared";
import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import { AgentMessageDomainError } from "../agent-message.store.js";
import { normalizeManualSessionTitle } from "./session-title.js";
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

  updateSessionTitle(params: { sessionId: string; body: AgentUpdateSessionTitleRequest }): AgentSessionRecord {
    const session = this.dependencies.store.getSession(params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const normalized = normalizeManualSessionTitle(params.body.title);
    if (!normalized.ok) {
      const code = normalized.reason === "empty"
        ? "AGENT_SESSION_TITLE_EMPTY"
        : normalized.reason === "too_long"
          ? "AGENT_SESSION_TITLE_TOO_LONG"
          : "AGENT_SESSION_TITLE_INVALID_CHARACTERS";
      throw new HttpError(400, code === "AGENT_SESSION_TITLE_EMPTY"
        ? "title must not be empty"
        : code === "AGENT_SESSION_TITLE_TOO_LONG"
          ? "title must not exceed 50 characters"
          : "title contains disallowed control characters", code);
    }

    const updated = this.dependencies.store.setManualTitle({
      sessionId: params.sessionId,
      workspaceId: params.body.workspaceId,
      title: normalized.title
    });
    if (!updated) throw new HttpError(404, "session not found");

    const next = this.dependencies.store.getSession(params.sessionId);
    if (!next) throw new HttpError(404, "session not found");
    return next;
  }

  async forkPrimarySession(params: AgentForkSessionRequest): Promise<AgentSessionRecord> {
    const fromSession = this.dependencies.store.getSession(params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    if (fromSession.kind !== "primary") {
      throw new HttpError(400, "source session must be primary", "AGENT_FORK_SOURCE_KIND_INVALID");
    }
    try {
      return await this.dependencies.store.cloneSession({
        createdAt: this.dependencies.clock.nowMs(),
        id: this.dependencies.ids.newSessionId(),
        fromSession,
        fromMessageId: params.fromMessageId,
        title: params.title,
        targetKind: "primary",
        boundaryPolicy: "public-user-assistant"
      });
    } catch (error) {
      if (this.dependencies.isConflict(error)) throw this.dependencies.toConflictHttpError(error);
      if (error instanceof AgentMessageDomainError) {
        if (error.code === "SESSION_NOT_FOUND") {
          throw new HttpError(404, "source session not found", "SESSION_NOT_FOUND");
        }
        if (error.code === "FORK_TARGET_INVALID" || error.code === "FORK_TARGET_BEFORE_CONTEXT_ROOT") {
          throw new HttpError(400, "fromMessageId is invalid", `AGENT_${error.code}`);
        }
        if (error.code === "FORK_TARGET_HAS_NON_TERMINAL_EXECUTIONS" || error.code === "SESSION_NOT_IDLE") {
          throw new HttpError(409, "session cannot fork while work is in flight", `AGENT_${error.code}`);
        }
      }
      throw error;
    }
  }

  async sendMessage(params: { sessionId: string; body: import("./session-interaction-ports.js").NormalizedAgentUserMessageInput; runtime: AgentRuntimePort }): Promise<AgentSendMessageResponse> {
    const session = this.dependencies.store.getSession(params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.kind === "subtask") {
      throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
    }
    if (session.workspaceId !== params.body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const text = params.body.text.trim();
    const images = params.body.images ?? [];
    if (!text && images.length === 0) throw new HttpError(400, "text or image is required");
    // These fast paths are intentionally non-authoritative. Lifecycle repeats
    // them in its activation transaction after this user-facing validation order.
    const dedup = this.dependencies.store.findClientRequestDedup({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      clientRequestId: params.body.clientRequestId
    });
    if (dedup) return { sessionId: session.id, messageId: dedup.messageId, runId: dedup.runId, deduplicated: true };
    if (this.dependencies.store.getRunState(session.workspaceId, session.id).status !== "idle") {
      throw new HttpError(409, "session is running");
    }

    const profile = this.dependencies.profileReader.resolveUser({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      requestedAgentId: params.body.agentId
    });
    try {
      return await this.dependencies.lifecycleStarter.startUserRun({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        clientRequestId: params.body.clientRequestId,
        text,
        inputText: params.body.text,
        images,
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

  async revertSession(command: RevertSessionCommand): Promise<AgentMessageControlResult> {
    const session = this.dependencies.store.getSession(command.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== command.body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
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
        expectedHeadMessageId: session.headMessageId,
        expectedRevision: session.revision,
        nextHeadMessageId: command.body.messageId,
        updatedAt: this.dependencies.clock.nowMs()
      });
    } catch (error) {
      if (this.dependencies.isConflict(error)) throw this.dependencies.toConflictHttpError(error);
      if (error instanceof AgentMessageDomainError) {
        switch (error.code) {
          case "SESSION_NOT_FOUND":
            throw new HttpError(404, "session not found", "SESSION_NOT_FOUND");
          case "MESSAGE_TARGET_INVALID":
          case "MESSAGE_TARGET_BEFORE_CONTEXT_ROOT":
            throw new HttpError(400, "messageId is invalid", `AGENT_${error.code}`);
          case "MESSAGE_TARGET_HAS_NON_TERMINAL_EXECUTIONS":
          case "SESSION_NOT_IDLE":
            throw new HttpError(409, "session cannot move head while work is in flight", `AGENT_${error.code}`);
          default:
            throw error;
        }
      }
      throw error;
    }

    const updated = this.dependencies.store.getSession(session.id);
    if (!updated) throw new HttpError(500, "session not found after revert");
    const result: AgentMessageControlResult = {
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
        forkedFromMessageId: null
      });
      return { session, createdSessionId: session.id };
    }
    if (command.shouldUsePreforkSummary || command.forkBoundaryMessageId == null) {
      const session = this.createSession({
        workspaceId: command.workspaceId,
        title: `${command.subtaskTitleBase} (fork)`,
        kind: "subtask",
        ...(command.shouldUsePreforkSummary ? {
          forkedFromSessionId: command.parentSessionId,
          forkedFromMessageId: null
        } : {})
      });
      return { session, createdSessionId: session.id };
    }
    const fromSession = this.dependencies.store.getSession(command.parentSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    const session = await this.dependencies.store.cloneSession({
      createdAt: this.dependencies.clock.nowMs(),
      id: this.dependencies.ids.newSessionId(),
      fromSession,
      fromMessageId: command.forkBoundaryMessageId,
      title: `${command.subtaskTitleBase} (fork)`,
      targetKind: "subtask",
      allowSourceWithActiveRun: true,
      boundaryPolicy: "internal-resolved"
    });
    return { session, createdSessionId: session.id };
  }

  private createSession(params: { workspaceId: string; title?: string; kind: "primary" | "subtask"; forkedFromSessionId?: string | null; forkedFromMessageId?: string | null }) {
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
      forkedFromMessageId: params.forkedFromMessageId ?? null
    });
    const session = this.dependencies.store.getSession(id);
    if (!session) throw new HttpError(500, "failed to create session");
    return session;
  }

  private assertWorkspace(workspaceId: string) {
    if (!this.dependencies.store.workspaceExists(workspaceId)) throw new HttpError(404, "workspace not found");
  }
}
