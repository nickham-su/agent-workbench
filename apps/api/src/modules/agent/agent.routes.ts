import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  AgentCancelSessionRequestSchema,
  AgentControlResultSchema,
  AgentCreateSessionRequestSchema,
  AgentEventRecordSchema,
  AgentForkSessionRequestSchema,
  AgentRevertSessionRequestSchema,
  AgentSendMessageRequestSchema,
  AgentSendMessageResponseSchema,
  AgentSessionConversationResponseSchema,
  AgentSessionRecordSchema,
  AgentSessionRunStateSchema,
  AgentProviderNpmSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentService } from "./agent.service.js";
import { HttpError } from "../../app/errors.js";

export async function registerAgentRoutes(app: FastifyInstance, params: { service: AgentService; runtime: AgentRuntimePort }) {
  app.get(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        querystring: Type.Object({ workspaceId: Type.String({ minLength: 1 }) }),
        response: { 200: Type.Array(AgentSessionRecordSchema), 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const query = req.query as { workspaceId: string };
      return params.service.listSessions(query.workspaceId);
    }
  );

  app.post(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        body: AgentCreateSessionRequestSchema,
        response: { 201: AgentSessionRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const body = req.body as { workspaceId: string; title?: string; kind?: "primary" | "subtask" };
      const session = params.service.createSession(body);
      return reply.code(201).send(session);
    }
  );

  app.post(
    "/api/agent/sessions/fork",
    {
      schema: {
        tags: ["agent"],
        body: AgentForkSessionRequestSchema,
        response: { 201: AgentSessionRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const body = req.body as {
        fromSessionId: string;
        fromEventId: string;
        title?: string;
        kind?: "primary" | "subtask";
      };
      const session = params.service.forkSession(body);
      return reply.code(201).send(session);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/conversation",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        response: { 200: AgentSessionConversationResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      return params.service.getConversation(p.sessionId);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/run-state",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        response: { 200: AgentSessionRunStateSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      return params.service.getRunState(p.sessionId);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/messages",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentSendMessageRequestSchema,
        response: {
          201: AgentSendMessageResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; text: string; clientRequestId: string; agentId?: string };
      const result = await params.service.sendMessage({ sessionId: p.sessionId, body });
      if (result.triggerMessageId) {
        const workspace = params.service.getWorkspace(body.workspaceId);
        if (!workspace) throw new HttpError(404, "workspace not found");
        await params.runtime.enqueueRun({
          workspaceId: body.workspaceId,
          sessionId: p.sessionId,
          runId: result.runId,
          triggerMessageId: result.triggerMessageId,
          inputText: body.text,
          workspacePath: workspace.path
        });
      }
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/revert",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentRevertSessionRequestSchema,
        response: { 200: AgentControlResultSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; toEventId: string; reason?: string };
      const result = params.service.revertSession(p.sessionId, body);
      await params.runtime.cancelSession(p.sessionId);
      return result;
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/cancel",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCancelSessionRequestSchema,
        response: { 200: AgentControlResultSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; anchorEventId: string };
      const result = params.service.cancelSession(p.sessionId, body);
      await params.runtime.cancelSession(p.sessionId);
      return result;
    }
  );

  app.post(
    "/api/internal/agent/append-timeline",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          type: Type.String({ minLength: 1 }),
          payload: Type.Any(),
          correlationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          causationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          createdAt: Type.Optional(Type.Number())
        }),
        response: {
          200: Type.Object({ ok: Type.Boolean(), eventId: Type.String({ minLength: 1 }) }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const token = String(req.headers["x-awb-agent-internal-token"] || "");
      if (token !== params.service.getContext().agentInternalToken) {
        throw new HttpError(401, "Unauthorized");
      }
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        type: string;
        payload: unknown;
        correlationId?: string | null;
        causationId?: string | null;
        createdAt?: number;
      };
      const event = params.service.appendTimelineFromWorker(body);
      return { ok: true, eventId: event.id };
    }
  );

  app.post(
    "/api/internal/agent/execution-profile",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          runId: Type.String({ minLength: 1 })
        }),
        response: {
          200: Type.Object({
            resolved: Type.Object({
              runId: Type.String({ minLength: 1 }),
              sessionId: Type.String({ minLength: 1 }),
              workspaceId: Type.String({ minLength: 1 }),
              agentId: Type.String({ minLength: 1 }),
              providerId: Type.String({ minLength: 1 }),
              modelId: Type.String({ minLength: 1 })
            }),
            agent: Type.Object({
              id: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
              prompt: Type.String(),
              tools: Type.Array(Type.Union([Type.Literal("bash"), Type.Literal("read"), Type.Literal("write")])),
              permissions: Type.Object({
                allowRead: Type.Boolean(),
                allowWrite: Type.Boolean(),
                allowBash: Type.Boolean()
              }),
              defaultModel: Type.Union([
                Type.Object({ providerId: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) }),
                Type.Null()
              ])
            }),
            provider: Type.Object({
              id: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
              npm: AgentProviderNpmSchema,
              options: Type.Object({
                baseURL: Type.String({ minLength: 1 }),
                apiKey: Type.String({ minLength: 1 })
              }),
              models: Type.Array(
                Type.Object({
                  id: Type.String({ minLength: 1 }),
                  providerModelId: Type.String({ minLength: 1 }),
                  name: Type.String({ minLength: 1 }),
                  options: Type.Any()
                })
              )
            }),
            model: Type.Object({
              id: Type.String({ minLength: 1 }),
              providerModelId: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
              options: Type.Any()
            })
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const token = String(req.headers["x-awb-agent-internal-token"] || "");
      if (token !== params.service.getContext().agentInternalToken) {
        throw new HttpError(401, "Unauthorized");
      }
      const body = req.body as { workspaceId: string; sessionId: string; runId: string };
      return params.service.getExecutionProfileForRun(body);
    }
  );

  // 调试接口: 直接查看某个事件
  app.get(
    "/api/agent/events/:eventId",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ eventId: Type.String({ minLength: 1 }) }),
        querystring: Type.Object({ workspaceId: Type.String({ minLength: 1 }) }),
        response: { 200: AgentEventRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { eventId: string };
      const query = req.query as { workspaceId: string };
      const view = params.service.getEventById(p.eventId);
      if (!view) throw new HttpError(404, "event not found");
      if (view.workspaceId !== query.workspaceId) throw new HttpError(400, "workspaceId mismatch");
      return view;
    }
  );
}
