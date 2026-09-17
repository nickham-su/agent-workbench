import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  AgentCancelSessionRequestSchema,
  AgentCreateSessionRequestSchema,
  AgentForkSessionRequestSchema,
  AgentRevertSessionRequestSchema,
  AgentInternalCreateSessionRequestSchema,
  AgentSendMessageRequestSchema,
  AgentSendMessageResponseSchema,
  AgentChannelAllowlistCheckRequestSchema,
  AgentChannelAllowlistCheckResponseSchema,
  type AgentSendMessageRequest,
  AgentSessionRecordSchema,
  AgentUiLocaleSchema,
  AgentProviderNpmSchema,
  AgentRecentSessionsRequestSchema,
  AgentRecentSessionsResponseSchema,
  AgentListAvailableAgentsRequestSchema,
  AgentListAvailableAgentsResponseSchema,
  AgentRecentWorkspacesRequestSchema,
  AgentRecentWorkspacesResponseSchema,
  PluginToolCanonicalNameSchema,
  PluginRuntimeSnapshotsResponseSchema,
  PluginToolRpcExecuteRequestSchema,
  PluginToolRpcExecuteResponseSchema,
  PluginToolRpcListRequestSchema,
  PluginToolRpcListResponseSchema,
  ErrorResponseSchema,
} from "@agent-workbench/shared/internal-contracts/agent-api-session";
import {
  AgentApiEndpoints,
  AgentApiCreateStreamingAssistantRequestSchema,
  AgentApiCreateStreamingAssistantResponseSchema,
  AgentApiFlushAssistantPartsRequestSchema,
  AgentApiResumeStreamingAssistantRequestSchema,
  AgentApiReplaceStreamingAssistantRequestSchema,
  AgentApiReplaceStreamingAssistantResponseSchema,
  AgentApiCompleteAssistantRequestSchema,
  AgentApiUpdateToolExecutionRequestSchema,
  AgentApiUpdateRunNoticeRequestSchema,
  AgentApiFencedWriteResponseSchema,
  AgentApiCommitCompactionRequestSchema,
  AgentApiCommitCompactionResponseSchema,
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
  AgentApiExecutionProfileRequestSchema,
  AgentApiExecutionProfileResponseSchema,
  AgentApiMessagesContextRequestSchema,
  AgentApiMessagesContextResponseSchema,
  AgentApiPromptContextRequestSchema,
  AgentApiPromptContextResponseSchema,
  AgentApiArchiveReadRequestSchema,
  AgentApiArchiveSearchRequestSchema,
  AgentApiArchivePageResponseSchema,
  type AgentApiCreateStreamingAssistantRequest,
  type AgentApiFlushAssistantPartsRequest,
  type AgentApiResumeStreamingAssistantRequest,
  type AgentApiReplaceStreamingAssistantRequest,
  type AgentApiCompleteAssistantRequest,
  type AgentApiUpdateToolExecutionRequest,
  type AgentApiUpdateRunNoticeRequest,
  type AgentApiCommitCompactionRequest,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest,
  type AgentApiRunCompleteRequest,
  type AgentApiExecutionProfileRequest,
  type AgentApiMessagesContextRequest,
  type AgentApiPromptContextRequest,
  type AgentApiArchiveReadRequest,
  type AgentApiArchiveSearchRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import type { AgentWorkerRouteDependencies } from "./agent-route-types.js";
import {
  assertInternalToken,
  assertOnlyAllowedBodyKeys,
  assertPluginCaller,
  AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS,
  AGENT_PRIMARY_SESSION_FORK_BODY_KEYS,
} from "./agent-route-auth.js";

const AgentBuiltinToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("apply_patch"),
  Type.Literal("scratchpad"),
  Type.Literal("todolist"),
  Type.Literal("subtask"),
  Type.Literal("skill"),
  Type.Literal("visual_analyze"),
]);
const AgentDynamicToolNameSchema = Type.Union([
  AgentBuiltinToolNameSchema,
  Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" }),
  PluginToolCanonicalNameSchema,
]);

export async function registerAgentWorkerRoutes(
  app: FastifyInstance,
  dependencies: AgentWorkerRouteDependencies,
) {
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
        404: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskPreforkPlanRequest;
      return dependencies.service.getSubtaskPreforkPlanFromWorker(body);
    },
  });

  app.route({
    method: AgentApiEndpoints.replaceStreamingAssistant.method,
    url: AgentApiEndpoints.replaceStreamingAssistant.path,
    schema: {
      tags: ["agent"],
      body: AgentApiReplaceStreamingAssistantRequestSchema,
      response: {
        200: AgentApiReplaceStreamingAssistantResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.replaceStreamingAssistantFromWorker(
        req.body as AgentApiReplaceStreamingAssistantRequest,
      );
    },
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
        409: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskStartRequest;
      return dependencies.service.startSubtaskRunFromWorker(body);
    },
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
        404: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskResultRequest;
      return dependencies.service.getSubtaskRunResultFromWorker(body);
    },
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
        404: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiSubtaskStatusRequest;
      return dependencies.service.getSubtaskRunStatusFromWorker(body);
    },
  });

  app.route({
    method: AgentApiEndpoints.createStreamingAssistant.method,
    url: AgentApiEndpoints.createStreamingAssistant.path,
    schema: {
      tags: ["agent"],
      body: AgentApiCreateStreamingAssistantRequestSchema,
      response: {
        200: AgentApiCreateStreamingAssistantResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.createStreamingAssistantFromWorker(
        req.body as AgentApiCreateStreamingAssistantRequest,
      );
    },
  });

  app.route({
    method: AgentApiEndpoints.flushAssistantParts.method,
    url: AgentApiEndpoints.flushAssistantParts.path,
    schema: {
      tags: ["agent"],
      body: AgentApiFlushAssistantPartsRequestSchema,
      response: {
        200: AgentApiFencedWriteResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.flushAssistantPartsFromWorker(
        req.body as AgentApiFlushAssistantPartsRequest,
      );
    },
  });

  app.route({
    method: AgentApiEndpoints.resumeStreamingAssistant.method,
    url: AgentApiEndpoints.resumeStreamingAssistant.path,
    schema: {
      tags: ["agent"],
      body: AgentApiResumeStreamingAssistantRequestSchema,
      response: {
        200: AgentApiFencedWriteResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.resumeStreamingAssistantFromWorker(
        req.body as AgentApiResumeStreamingAssistantRequest,
      );
    },
  });

  app.route({
    method: AgentApiEndpoints.completeAssistant.method,
    url: AgentApiEndpoints.completeAssistant.path,
    schema: {
      tags: ["agent"],
      body: AgentApiCompleteAssistantRequestSchema,
      response: {
        200: AgentApiFencedWriteResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.completeAssistantFromWorker(
        req.body as AgentApiCompleteAssistantRequest,
      );
    },
  });

  app.route({
    method: AgentApiEndpoints.updateToolExecution.method,
    url: AgentApiEndpoints.updateToolExecution.path,
    schema: {
      tags: ["agent"],
      body: AgentApiUpdateToolExecutionRequestSchema,
      response: {
        200: AgentApiFencedWriteResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.updateToolExecutionFromWorker(
        req.body as AgentApiUpdateToolExecutionRequest,
      );
    },
  });

  app.route({
    method: AgentApiEndpoints.updateRunNotice.method,
    url: AgentApiEndpoints.updateRunNotice.path,
    schema: {
      tags: ["agent"],
      body: AgentApiUpdateRunNoticeRequestSchema,
      response: {
        200: AgentApiFencedWriteResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.updateRunNoticeFromWorker(
        req.body as AgentApiUpdateRunNoticeRequest,
      );
    },
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
        401: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiRunCompleteRequest;
      dependencies.service.completeRunFromWorker(body);
      return { ok: true };
    },
  });

  app.route({
    method: AgentApiEndpoints.commitCompaction.method,
    url: AgentApiEndpoints.commitCompaction.path,
    schema: {
      tags: ["agent"],
      body: AgentApiCommitCompactionRequestSchema,
      response: {
        200: AgentApiCommitCompactionResponseSchema,
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiCommitCompactionRequest;
      return dependencies.service.commitCompactionFromWorker(body);
    },
  });

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
        404: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiPromptContextRequest;
      return dependencies.service.getPromptContextForRun(body);
    },
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
        404: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiMessagesContextRequest;
      return dependencies.service.getMessagesContext(body);
    },
  });

  app.route({
    method: AgentApiEndpoints.archiveRead.method,
    url: AgentApiEndpoints.archiveRead.path,
    schema: {
      tags: ["agent"],
      body: AgentApiArchiveReadRequestSchema,
      response: { 200: AgentApiArchivePageResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 404: ErrorResponseSchema },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.archiveReadFromWorker(req.body as AgentApiArchiveReadRequest);
    },
  });

  app.route({
    method: AgentApiEndpoints.archiveSearch.method,
    url: AgentApiEndpoints.archiveSearch.path,
    schema: {
      tags: ["agent"],
      body: AgentApiArchiveSearchRequestSchema,
      response: { 200: AgentApiArchivePageResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 404: ErrorResponseSchema },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.archiveSearchFromWorker(req.body as AgentApiArchiveSearchRequest);
    },
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
        404: ErrorResponseSchema,
      },
    },
    handler: async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as AgentApiExecutionProfileRequest;
      return dependencies.service.getExecutionProfileForRun(body);
    },
  });

  app.post(
    "/api/internal/agent/single-call-model-profile",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          runId: Type.String({ minLength: 1 }),
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
              source: Type.Literal("agent_default"),
            }),
            provider: Type.Object({
              id: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
              npm: AgentProviderNpmSchema,
              options: Type.Object({
                baseURL: Type.String({ minLength: 1 }),
                apiKey: Type.String({ minLength: 1 }),
                apiMode: Type.Optional(
                  Type.Union([
                    Type.Literal("responses"),
                    Type.Literal("chatCompletions"),
                  ]),
                ),
              }),
            }),
            model: Type.Object({
              id: Type.String({ minLength: 1 }),
              providerModelId: Type.Optional(Type.String({ minLength: 1 })),
              name: Type.String({ minLength: 1 }),
              contextWindowTokens: Type.Integer({ minimum: 1 }),
              options: Type.Optional(Type.Any()),
            }),
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string;
      };
      return dependencies.service.getSingleCallModelProfileForRun(body);
    },
  );
}
