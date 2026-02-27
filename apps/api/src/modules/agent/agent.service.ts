import type { FastifyBaseLogger } from "fastify";
import type {
  AgentCancelSessionRequest,
  AgentControlResult,
  AgentForkSessionRequest,
  AgentRevertSessionRequest,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionConversationResponse,
  AgentSessionRunState
} from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import {
  AgentConflictError,
  appendControlEvent,
  appendTimelineEvent,
  createAgentSession,
  findRunCreatedEvent,
  findClientRequestDedup,
  getAgentSession,
  getEventById,
  getLatestSessionEventId,
  getRunState,
  getSessionHead,
  getSessionTimelineEvents,
  insertClientRequestDedup,
  listAgentSessions,
  moveSessionHead,
  setRunStateIdle
} from "./agent.store.js";
import { buildTextPayload } from "./agent.text.js";
import { resolveExecutionProfile } from "../settings/settings.service.js";

export type AgentQueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  triggerMessageId: string;
};

function conflictToHttpError(err: AgentConflictError): HttpError {
  return new HttpError(409, "session head conflict", `conflict_head:${err.currentHeadEventId ?? "null"}`);
}

export class AgentService {
  constructor(private readonly ctx: AppContext, private readonly logger: FastifyBaseLogger) {}

  getContext() {
    return this.ctx;
  }

  listSessions(workspaceId: string) {
    this.ensureWorkspace(workspaceId);
    return listAgentSessions(this.ctx.db, workspaceId);
  }

  getSession(sessionId: string) {
    return getAgentSession(this.ctx.db, sessionId);
  }

  getWorkspace(workspaceId: string) {
    return getWorkspace(this.ctx.db, workspaceId);
  }

  createSession(params: { workspaceId: string; title?: string; kind?: "primary" | "subtask" }) {
    this.ensureWorkspace(params.workspaceId);
    const createdAt = nowMs();
    const sessionId = newSortableId("sess");
    const title = (params.title || "新会话").trim() || "新会话";
    const kind = params.kind === "subtask" ? "subtask" : "primary";

    try {
      const tx = this.ctx.db.transaction(() => {
        createAgentSession(this.ctx.db, {
          id: sessionId,
          workspaceId: params.workspaceId,
          title,
          kind,
          createdAt
        });

        appendTimelineEvent(this.ctx.db, {
          id: newSortableId("evt"),
          workspaceId: params.workspaceId,
          sessionId,
          lane: "timeline",
          prevId: null,
          type: "session.created",
          schemaVersion: 1,
          createdAt,
          payload: {
            title,
            kind,
            createdBy: "client"
          }
        });
      });
      tx();
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      throw err;
    }

    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(500, "failed to create session");
    return session;
  }

  forkSession(params: AgentForkSessionRequest) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    const fromEvent = getEventById(this.ctx.db, params.fromEventId);
    if (!fromEvent || fromEvent.sessionId !== params.fromSessionId || fromEvent.lane !== "timeline") {
      throw new HttpError(400, "invalid fromEventId");
    }

    const createdAt = nowMs();
    const newSessionId = newSortableId("sess");
    const title = (params.title || `${fromSession.title} (fork)`).trim() || `${fromSession.title} (fork)`;
    const kind = params.kind === "subtask" ? "subtask" : "primary";
    const correlationId = newSortableId("corr");

    try {
      const tx = this.ctx.db.transaction(() => {
        appendControlEvent(this.ctx.db, {
          id: newSortableId("evt"),
          workspaceId: fromSession.workspaceId,
          sessionId: fromSession.id,
          lane: "control",
          type: "control.session.fork.requested",
          schemaVersion: 1,
          correlationId,
          createdAt,
          payload: {
            fromSessionId: fromSession.id,
            fromEventId: fromEvent.id,
            newSessionKind: kind
          }
        });

        createAgentSession(this.ctx.db, {
          id: newSessionId,
          workspaceId: fromSession.workspaceId,
          title,
          kind,
          createdAt,
          forkedFromSessionId: fromSession.id,
          forkedFromEventId: fromEvent.id
        });

        appendTimelineEvent(this.ctx.db, {
          id: newSortableId("evt"),
          workspaceId: fromSession.workspaceId,
          sessionId: newSessionId,
          lane: "timeline",
          prevId: null,
          type: "session.fork_base",
          schemaVersion: 1,
          correlationId,
          createdAt,
          payload: {
            fromSessionId: fromSession.id,
            fromEventId: fromEvent.id,
            kind
          }
        });
      });
      tx();
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      throw err;
    }

    const session = getAgentSession(this.ctx.db, newSessionId);
    if (!session) throw new HttpError(500, "failed to create fork session");
    return session;
  }

  async sendMessage(params: { sessionId: string; body: AgentSendMessageRequest }): Promise<AgentSendMessageResponse> {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.body.workspaceId) {
      throw new HttpError(400, "workspaceId mismatch");
    }
    const text = params.body.text.trim();
    if (!text) throw new HttpError(400, "text is required");

    const dedup = findClientRequestDedup(this.ctx.db, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      clientRequestId: params.body.clientRequestId
    });
    if (dedup) {
      const event = getEventById(this.ctx.db, dedup.messageEventId);
      const payload = (event?.payload ?? null) as any;
      const triggerMessageId = typeof payload?.messageId === "string" ? payload.messageId : undefined;
      return {
        sessionId: session.id,
        messageEventId: dedup.messageEventId,
        runId: dedup.runId,
        deduplicated: true,
        triggerMessageId
      };
    }

    const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (runState.status !== "idle") {
      throw new HttpError(409, "session is running");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      requestedAgentId: params.body.agentId
    });

    const workspace = this.ensureWorkspace(session.workspaceId);
    const correlationId = newSortableId("corr");
    const messageId = newSortableId("msg");
    const messageEventId = newSortableId("evt");
    const runId = newSortableId("run");
    const runCreatedEventId = newSortableId("evt");
    const createdAt = nowMs();

    const textPayload = await buildTextPayload({
      workspacePath: workspace.path,
      text
    });

    let userEventId = messageEventId;
    let createdRunId = runId;
    let deduplicated = false;
    try {
      const tx = this.ctx.db.transaction(() => {
        const prevHead = getSessionHead(this.ctx.db, session.workspaceId, session.id);
        appendTimelineEvent(this.ctx.db, {
          id: messageEventId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          lane: "timeline",
          prevId: prevHead,
          type: "user.message.created",
          schemaVersion: 1,
          correlationId,
          createdAt,
          payload: {
            messageId,
            clientRequestId: params.body.clientRequestId,
            text: textPayload,
            agentId: profile.agent.id
          }
        });

        appendTimelineEvent(this.ctx.db, {
          id: runCreatedEventId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          lane: "timeline",
          prevId: messageEventId,
          type: "run.created",
          schemaVersion: 1,
          correlationId,
          causationId: messageEventId,
          createdAt: createdAt + 1,
          payload: {
            runId,
            triggerMessageId: messageId,
            agentId: profile.agent.id,
            providerId: profile.provider.id,
            modelId: profile.model.id
          }
        });

        insertClientRequestDedup(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          clientRequestId: params.body.clientRequestId,
          messageEventId,
          runId,
          createdAt
        });
      });
      tx();
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      const fresh = findClientRequestDedup(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        clientRequestId: params.body.clientRequestId
      });
      if (fresh) {
        userEventId = fresh.messageEventId;
        createdRunId = fresh.runId;
        deduplicated = true;
      } else {
        throw err;
      }
    }

    return {
      sessionId: session.id,
      messageEventId: userEventId,
      runId: createdRunId,
      deduplicated,
      triggerMessageId: deduplicated ? undefined : messageId
    };
  }

  getConversation(sessionId: string): AgentSessionConversationResponse {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const events = getSessionTimelineEvents(this.ctx.db, session.workspaceId, session.id);
    const appliedEventId = events.length > 0 ? events[events.length - 1]!.eventId : 0;
    return {
      sessionId: session.id,
      headEventId: session.headEventId,
      appliedEventId,
      events
    };
  }

  getRunState(sessionId: string): AgentSessionRunState {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      status: state.status,
      activeRunId: state.activeRunId,
      updatedAt: state.updatedAt,
      appliedEventId: state.appliedEventId
    };
  }

  getEventById(eventId: string) {
    return getEventById(this.ctx.db, eventId);
  }

  revertSession(sessionId: string, body: AgentRevertSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const targetEvent = getEventById(this.ctx.db, body.toEventId);
    if (!targetEvent || targetEvent.sessionId !== session.id || targetEvent.lane !== "timeline") {
      throw new HttpError(400, "toEventId is invalid");
    }

    const createdAt = nowMs();
    const correlationId = newSortableId("corr");
    appendControlEvent(this.ctx.db, {
      id: newSortableId("evt"),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      lane: "control",
      type: "control.session.revert.requested",
      schemaVersion: 1,
      correlationId,
      createdAt,
      payload: {
        toEventId: body.toEventId,
        reason: body.reason ?? "manual"
      }
    });

    try {
      moveSessionHead(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        expectedHeadEventId: session.headEventId,
        nextHeadEventId: body.toEventId,
        reason: "revert",
        movedEvent: {
          id: newSortableId("evt"),
          workspaceId: session.workspaceId,
          sessionId: session.id,
          schemaVersion: 1,
          correlationId,
          createdAt: createdAt + 1,
          payload: null
        }
      });
      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt + 1,
        appliedEventId: getLatestSessionEventId(this.ctx.db, session.workspaceId, session.id)
      });
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      if (err instanceof Error && err.message === "invalid target head event") {
        throw new HttpError(400, "toEventId is invalid");
      }
      throw err;
    }

    const headEventId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
    return { sessionId: session.id, headEventId };
  }

  cancelSession(sessionId: string, body: AgentCancelSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const anchor = getEventById(this.ctx.db, body.anchorEventId);
    if (!anchor || anchor.sessionId !== session.id || anchor.lane !== "timeline") {
      throw new HttpError(400, "anchorEventId is invalid");
    }

    const createdAt = nowMs();
    const correlationId = newSortableId("corr");
    appendControlEvent(this.ctx.db, {
      id: newSortableId("evt"),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      lane: "control",
      type: "control.session.cancel.requested",
      schemaVersion: 1,
      correlationId,
      createdAt,
      payload: {
        scope: "session",
        cancelMode: "discard_to_anchor",
        anchorEventId: body.anchorEventId
      }
    });

    try {
      let expectedHeadEventId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
      const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
      if (runState.activeRunId && expectedHeadEventId) {
        const cancelledEvent = appendTimelineEvent(this.ctx.db, {
          id: newSortableId("evt"),
          workspaceId: session.workspaceId,
          sessionId: session.id,
          lane: "timeline",
          prevId: expectedHeadEventId,
          type: "run.cancelled",
          schemaVersion: 1,
          correlationId,
          createdAt: createdAt + 1,
          payload: {
            runId: runState.activeRunId,
            reason: "cancel_requested"
          }
        });
        expectedHeadEventId = cancelledEvent.id;
      }

      moveSessionHead(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        expectedHeadEventId,
        nextHeadEventId: body.anchorEventId,
        reason: "cancel",
        movedEvent: {
          id: newSortableId("evt"),
          workspaceId: session.workspaceId,
          sessionId: session.id,
          schemaVersion: 1,
          correlationId,
          createdAt: createdAt + 2,
          payload: null
        }
      });
      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt + 2,
        appliedEventId: getLatestSessionEventId(this.ctx.db, session.workspaceId, session.id)
      });
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      if (err instanceof Error && err.message === "invalid target head event") {
        throw new HttpError(400, "anchorEventId is invalid");
      }
      throw err;
    }

    const headEventId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
    return { sessionId: session.id, headEventId };
  }

  appendTimelineFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    type: string;
    payload: unknown;
    correlationId?: string | null;
    causationId?: string | null;
    createdAt?: number;
  }) {
    const head = getSessionHead(this.ctx.db, params.workspaceId, params.sessionId);
    try {
      return appendTimelineEvent(this.ctx.db, {
        id: newSortableId("evt"),
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        lane: "timeline",
        prevId: head,
        type: params.type,
        schemaVersion: 1,
        correlationId: params.correlationId,
        causationId: params.causationId,
        createdAt: params.createdAt ?? nowMs(),
        payload: params.payload
      });
    } catch (err) {
      if (err instanceof AgentConflictError) {
        this.logger.warn(
          {
            sessionId: params.sessionId,
            type: params.type,
            currentHeadEventId: err.currentHeadEventId
          },
          "agent append timeline conflict"
        );
        throw conflictToHttpError(err);
      }
      throw err;
    }
  }

  private ensureWorkspace(workspaceId: string) {
    const workspace = getWorkspace(this.ctx.db, workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    return workspace;
  }

  getExecutionProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const runCreated = findRunCreatedEvent(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId
    });
    if (!runCreated) throw new HttpError(404, "run not found");
    const payload = runCreated.payload as Record<string, unknown>;

    const profile = resolveExecutionProfile(this.ctx, {
      agentIdFromRun: typeof payload.agentId === "string" ? payload.agentId : null,
      providerIdFromRun: typeof payload.providerId === "string" ? payload.providerId : null,
      modelIdFromRun: typeof payload.modelId === "string" ? payload.modelId : null
    });

    return {
      resolved: {
        runId: params.runId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id
      },
      agent: profile.agent,
      provider: profile.provider,
      model: profile.model
    };
  }
}
