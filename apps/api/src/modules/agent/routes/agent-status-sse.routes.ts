import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  AgentMessageTimelineSnapshotSchema
} from "@agent-workbench/shared";
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
  AgentApiSubtaskPreforkPlanRequestSchema,
  AgentApiSubtaskPreforkPlanResponseSchema,
  AgentApiSubtaskStartRequestSchema,
  AgentApiSubtaskStartResponseSchema,
  AgentApiSubtaskResultRequestSchema,
  AgentApiSubtaskResultResponseSchema,
  AgentApiSubtaskStatusRequestSchema,
  AgentApiSubtaskStatusResponseSchema,
  AgentApiExecutionProfileRequestSchema,
  AgentApiExecutionProfileResponseSchema,
  AgentApiMessagesContextRequestSchema,
  AgentApiMessagesContextResponseSchema,
  AgentApiPromptContextRequestSchema,
  AgentApiPromptContextResponseSchema,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest,
  type AgentApiExecutionProfileRequest,
  type AgentApiMessagesContextRequest,
  type AgentApiPromptContextRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import type { AgentStatusSseRouteDependencies } from "./agent-route-types.js";
import {
  assertInternalToken,
  assertOnlyAllowedBodyKeys,
  assertPluginCaller,
  AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS,
  AGENT_PRIMARY_SESSION_FORK_BODY_KEYS,
} from "./agent-route-auth.js";
import { toSseEventChunk } from "../run-completed-events.js";

export async function registerAgentStatusSseRoutes(
  app: FastifyInstance,
  dependencies: AgentStatusSseRouteDependencies,
) {
  app.get("/api/internal/agent/events/sse", async (req, reply) => {
    assertInternalToken(req, dependencies.internalToken);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();
    reply.raw.write(": connected\n\n");

    const heartbeat = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);
    const unsubscribe = dependencies.runCompletedEventHub.subscribe((event) => {
      reply.raw.write(toSseEventChunk(event));
    });
    req.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post(
    "/api/internal/agent/sessions/message-timeline-snapshot",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          sinceRevision: Type.Optional(Type.Integer({ minimum: 0 }))
        }, { additionalProperties: false }),
        response: {
          200: AgentMessageTimelineSnapshotSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        },
      },
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        sinceRevision?: number;
      };
      if (!body.sessionId.trim()) throw new HttpError(400, "sessionId is required", "SESSION_ID_REQUIRED");
      return dependencies.service.getMessageTimelineSnapshot({
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
        ...(body.sinceRevision === undefined ? {} : { sinceRevision: body.sinceRevision })
      });
    },
  );
}
