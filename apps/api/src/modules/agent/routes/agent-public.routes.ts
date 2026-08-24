import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  AgentCancelSessionRequestSchema,
  AgentContextItemRecordSchema,
  AgentContextItemStatusSchema,
  AgentContextItemsQuerySchema,
  AgentContextItemsResponseSchema,
  AgentControlResultSchema,
  AgentCreateSessionRequestSchema,
  AgentForkSessionRequestSchema,
  AgentRevertSessionRequestSchema,
  AgentInternalCreateSessionRequestSchema,
  AgentSendMessageRequestSchema,
  AgentSendMessageResponseSchema,
  AgentChannelAllowlistCheckRequestSchema,
  AgentChannelAllowlistCheckResponseSchema,
  type AgentSendMessageRequest,
  AgentClearSessionRequestSchema,
  AgentCompactSessionRequestSchema,
  AgentCompactSessionResponseSchema,
  AgentSessionRecordSchema,
  AgentSessionRunStateSchema,
  AgentUiLocaleSchema,
  AgentProviderNpmSchema,
  AgentRecentSessionsRequestSchema,
  AgentRecentSessionsResponseSchema,
  AgentListAvailableAgentsRequestSchema,
  AgentListAvailableAgentsResponseSchema,
  AgentSessionStatusSummaryRequestSchema,
  AgentSessionContextItemsTailRequestSchema,
  AgentSessionContextItemsTailResponseSchema,
  AgentRecentWorkspacesRequestSchema,
  AgentRecentWorkspacesResponseSchema,
  AgentSessionStatusSummaryResponseSchema,
  PluginToolCanonicalNameSchema,
  PluginRuntimeSnapshotsResponseSchema,
  PluginToolRpcExecuteRequestSchema,
  PluginToolRpcExecuteResponseSchema,
  PluginToolRpcListRequestSchema,
  PluginToolRpcListResponseSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import {
  AgentApiEndpoints,
  AgentApiContextItemParamsSchema,
  AgentApiCreateContextItemRequestSchema,
  AgentApiCreateContextItemResponseSchema,
  AgentApiUpdateContextItemRequestSchema,
  AgentApiUpdateContextItemResponseSchema,
  AgentApiCompactContextRequestSchema,
  AgentApiCompactContextResponseSchema,
  AgentApiSubtaskPreforkPlanRequestSchema,
  AgentApiSubtaskPreforkPlanResponseSchema,
  AgentApiSubtaskStartRequestSchema,
  AgentApiSubtaskStartResponseSchema,
  AgentApiSubtaskResultRequestSchema,
  AgentApiSubtaskResultResponseSchema,
  AgentApiSubtaskStatusRequestSchema,
  AgentApiSubtaskStatusResponseSchema,
  AgentApiRunCompleteRequestSchema,
  AgentApiRunCompleteResponseSchema,
  AgentApiRunStateRequestSchema,
  AgentApiRunStateResponseSchema,
  AgentApiExecutionProfileRequestSchema,
  AgentApiExecutionProfileResponseSchema,
  AgentApiMessagesContextRequestSchema,
  AgentApiMessagesContextResponseSchema,
  AgentApiPromptContextRequestSchema,
  AgentApiPromptContextResponseSchema,
  type AgentApiContextItemParams,
  type AgentApiCreateContextItemRequest,
  type AgentApiUpdateContextItemRequest,
  type AgentApiCompactContextRequest,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest,
  type AgentApiRunCompleteRequest,
  type AgentApiRunStateRequest,
  type AgentApiExecutionProfileRequest,
  type AgentApiMessagesContextRequest,
  type AgentApiPromptContextRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import type { AgentPublicRouteDependencies } from "./agent-route-types.js";
import { assertInternalToken, assertOnlyAllowedBodyKeys, assertPluginCaller, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS } from "./agent-route-auth.js";

async function handleCompactRequest(dependencies: AgentPublicRouteDependencies, sessionId: string, body: { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" }) {
  return await dependencies.service.compactSession({ sessionId, body, runtime: dependencies.runtime });
}

export async function registerAgentPublicRoutes(app: FastifyInstance, dependencies: AgentPublicRouteDependencies) {
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
      return dependencies.service.listSessions(query.workspaceId);
    }
  );

  app.post(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        body: AgentCreateSessionRequestSchema,
        response: { 201: AgentSessionRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      },
      preValidation: async (req) => assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS)
    },
    async (req, reply) => {
      const body = req.body as { workspaceId: string; title?: string };
      const session = dependencies.service.createPrimarySession(body);
      return reply.code(201).send(session);
    }
  );

  app.post(
    "/api/agent/sessions/fork",
    {
      schema: {
        tags: ["agent"],
        body: AgentForkSessionRequestSchema,
        response: {
          201: AgentSessionRecordSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      },
      preValidation: async (req) => assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS)
    },
    async (req, reply) => {
      const body = req.body as {
        fromSessionId: string;
        fromItemId: number;
        mode: "with_archive" | "visible_only";
        title?: string;
      };
      const session = await dependencies.service.forkPrimarySession(body);
      return reply.code(201).send(session);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        querystring: AgentContextItemsQuerySchema,
        response: {
          200: AgentContextItemsResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const query = req.query as {
        afterId?: number;
        tailLimit?: number;
        beforeId?: number;
        limit?: number;
        expectedHeadItemId?: number;
      };
      return dependencies.service.getContextItems(p.sessionId, {
        afterId: query.afterId,
        tailLimit: query.tailLimit,
        beforeId: query.beforeId,
        limit: query.limit,
        expectedHeadItemId: query.expectedHeadItemId
      });
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items/:itemId",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          itemId: Type.Number({ minimum: 1 })
        }),
        response: { 200: AgentContextItemRecordSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string; itemId: number };
      return dependencies.service.getContextItem(p.sessionId, p.itemId);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items/:itemId/apply-patch-artifact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          itemId: Type.Number({ minimum: 1 })
        }),
        response: { 200: Type.Any(), 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string; itemId: number };
      return await dependencies.service.getApplyPatchUiArtifact({ sessionId: p.sessionId, itemId: p.itemId });
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items/:itemId/write-artifact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          itemId: Type.Number({ minimum: 1 })
        }),
        response: { 200: Type.Any(), 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string; itemId: number };
      return await dependencies.service.getWriteUiArtifact({ sessionId: p.sessionId, itemId: p.itemId });
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
      return dependencies.service.getRunState(p.sessionId);
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
      const body = req.body as AgentSendMessageRequest;
      const result = await dependencies.service.sendMessage({ sessionId: p.sessionId, body, runtime: dependencies.runtime });
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/compact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCompactSessionRequestSchema,
        response: {
          201: AgentCompactSessionResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" };
      const result = await handleCompactRequest(dependencies, p.sessionId, body);
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/internal/agent/sessions/:sessionId/compact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCompactSessionRequestSchema,
        response: {
          201: AgentCompactSessionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      assertInternalToken(req, dependencies.internalToken);
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" };
      const result = await handleCompactRequest(dependencies, p.sessionId, body);
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/clear",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentClearSessionRequestSchema,
        response: {
          200: AgentControlResultSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; reason?: string; uiLocale?: "zh-CN" | "en-US" };
      return dependencies.service.clearSession(p.sessionId, body);
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
      const body = req.body as { workspaceId: string; itemId: number; reason?: string };
      return await dependencies.service.revertSession({ sessionId: p.sessionId, body, runtime: dependencies.runtime });
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
      const body = req.body as { workspaceId: string };
      return dependencies.service.cancelSessionWithRuntime({
        sessionId: p.sessionId,
        workspaceId: body.workspaceId,
        runtime: dependencies.runtime
      });
    }
  );
}
