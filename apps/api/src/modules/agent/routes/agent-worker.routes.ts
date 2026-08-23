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
import type { AgentWorkerRouteDependencies } from "./agent-route-types.js";
import { assertInternalToken, assertOnlyAllowedBodyKeys, assertPluginCaller, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS } from "./agent-route-auth.js";

const AgentBuiltinToolNameSchema = Type.Union([
  Type.Literal("bash"), Type.Literal("read"), Type.Literal("write"), Type.Literal("apply_patch"), Type.Literal("scratchpad"),
  Type.Literal("todolist"), Type.Literal("subtask"), Type.Literal("archive_search"), Type.Literal("skill"),
  Type.Literal("archive_read"), Type.Literal("visual_analyze")
]);
const AgentDynamicToolNameSchema = Type.Union([
  AgentBuiltinToolNameSchema, Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" }), PluginToolCanonicalNameSchema
]);

export async function registerAgentWorkerRoutes(app: FastifyInstance, dependencies: AgentWorkerRouteDependencies) {
  app.route({
    method: AgentApiEndpoints.getSubtaskPreforkPlan.method,
    url: AgentApiEndpoints.getSubtaskPreforkPlan.path,
    schema: {
      tags: ["agent"],
      body: AgentApiSubtaskPreforkPlanRequestSchema,
      response: {
        200: AgentApiSubtaskPreforkPlanResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskPreforkPlanRequest;
      return dependencies.service.getSubtaskPreforkPlanFromWorker(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.startSubtask.method,
    url: AgentApiEndpoints.startSubtask.path,
    schema: {
      tags: ["agent"],
      body: AgentApiSubtaskStartRequestSchema,
      response: {
        200: AgentApiSubtaskStartResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskStartRequest;
      return dependencies.service.startSubtaskRunFromWorker(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.getSubtaskResult.method,
    url: AgentApiEndpoints.getSubtaskResult.path,
    schema: {
      tags: ["agent"],
      body: AgentApiSubtaskResultRequestSchema,
      response: {
        200: AgentApiSubtaskResultResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskResultRequest;
      return dependencies.service.getSubtaskRunResultFromWorker(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.getSubtaskStatus.method,
    url: AgentApiEndpoints.getSubtaskStatus.path,
    schema: {
      tags: ["agent"],
      body: AgentApiSubtaskStatusRequestSchema,
      response: {
        200: AgentApiSubtaskStatusResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskStatusRequest;
      return dependencies.service.getSubtaskRunStatusFromWorker(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.createContextItem.method,
    url: AgentApiEndpoints.createContextItem.path,
    schema: {
      tags: ["agent"],
      body: AgentApiCreateContextItemRequestSchema,
      response: {
        200: AgentApiCreateContextItemResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiCreateContextItemRequest;
      return dependencies.service.appendContextItemFromWorker(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.updateContextItem.method,
    url: AgentApiEndpoints.updateContextItem.routeTemplate,
    schema: {
      tags: ["agent"],
      params: AgentApiContextItemParamsSchema,
      body: AgentApiUpdateContextItemRequestSchema,
      response: {
        200: AgentApiUpdateContextItemResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const routeParams = req.params as AgentApiContextItemParams;
      const body = req.body as AgentApiUpdateContextItemRequest;
      const item = await dependencies.service.updateContextItemFromWorker({ itemId: routeParams.itemId, ...body });
      return { ok: true, item };
    }
  });

  app.route({
    method: AgentApiEndpoints.updateRunState.method,
    url: AgentApiEndpoints.updateRunState.path,
    schema: {
      tags: ["agent"],
      body: AgentApiRunStateRequestSchema,
      response: {
        200: AgentApiRunStateResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiRunStateRequest;
      dependencies.service.updateRunStateFromWorker(body);
      return { ok: true };
    }
  });

  app.route({
    method: AgentApiEndpoints.completeRun.method,
    url: AgentApiEndpoints.completeRun.path,
    schema: {
      tags: ["agent"],
      body: AgentApiRunCompleteRequestSchema,
      response: {
        200: AgentApiRunCompleteResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiRunCompleteRequest;
      dependencies.service.completeRunFromWorker(body);
      return { ok: true };
    }
  });

  app.route({
    method: AgentApiEndpoints.compactContext.method,
    url: AgentApiEndpoints.compactContext.path,
    schema: {
      tags: ["agent"],
      body: AgentApiCompactContextRequestSchema,
      response: {
        200: AgentApiCompactContextResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiCompactContextRequest;
      return dependencies.service.compactContextFromWorker(body);
    }
  });

  app.post(
    "/api/internal/agent/archive/search",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          query: Type.String({ minLength: 1 }),
          beforePos: Type.Optional(Type.Integer({ minimum: 2 })),
          maxHits: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 10000 })),
          snippet: Type.Optional(Type.Boolean()),
          regex: Type.Optional(Type.Boolean())
        }),
        response: {
          200: Type.Object({ text: Type.String(), noArchive: Type.Optional(Type.Boolean()) }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        query: string;
        beforePos?: number;
        maxHits?: number;
        maxChars?: number;
        snippet?: boolean;
        regex?: boolean;
      };
      return dependencies.service.archiveSearchFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/archive/read",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          beforePos: Type.Optional(Type.Integer({ minimum: 2 })),
          lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 10000 }))
        }),
        response: {
          200: Type.Object({ text: Type.String(), noArchive: Type.Optional(Type.Boolean()) }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        beforePos?: number;
        lineCount?: number;
        maxChars?: number;
      };
      return dependencies.service.archiveReadFromWorker(body);
    }
  );

  app.route({
    method: AgentApiEndpoints.getPromptContext.method,
    url: AgentApiEndpoints.getPromptContext.path,
    schema: {
      tags: ["agent"],
      body: AgentApiPromptContextRequestSchema,
      response: {
        200: AgentApiPromptContextResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiPromptContextRequest;
      return dependencies.service.getPromptContextForRun(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.getMessagesContext.method,
    url: AgentApiEndpoints.getMessagesContext.path,
    schema: {
      tags: ["agent"],
      body: AgentApiMessagesContextRequestSchema,
      response: {
        200: AgentApiMessagesContextResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiMessagesContextRequest;
      return dependencies.service.getMessagesContext(body);
    }
  });

  app.route({
    method: AgentApiEndpoints.getExecutionProfile.method,
    url: AgentApiEndpoints.getExecutionProfile.path,
    schema: {
      tags: ["agent"],
      body: AgentApiExecutionProfileRequestSchema,
      response: {
        200: AgentApiExecutionProfileResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema
      }
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiExecutionProfileRequest;
      return dependencies.service.getExecutionProfileForRun(body);
    }
  });

  app.post(
    "/api/internal/agent/single-call-model-profile",
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
              modelId: Type.String({ minLength: 1 }),
              source: Type.Literal("agent_default")
            }),
            provider: Type.Object({
              id: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
              npm: AgentProviderNpmSchema,
              options: Type.Object({
                baseURL: Type.String({ minLength: 1 }),
                apiKey: Type.String({ minLength: 1 }),
                apiMode: Type.Optional(Type.Union([Type.Literal("responses"), Type.Literal("chatCompletions")]))
              })
            }),
            model: Type.Object({
              id: Type.String({ minLength: 1 }),
              providerModelId: Type.Optional(Type.String({ minLength: 1 })),
              name: Type.String({ minLength: 1 }),
              contextWindowTokens: Type.Integer({ minimum: 1 }),
              options: Type.Optional(Type.Any())
            })
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string;
      };
      return dependencies.service.getSingleCallModelProfileForRun(body);
    }
  );
}
