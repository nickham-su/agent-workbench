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
import type { AgentStatusSseRouteDependencies } from "./agent-route-types.js";
import { assertInternalToken, assertOnlyAllowedBodyKeys, assertPluginCaller, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS } from "./agent-route-auth.js";
import { toSseEventChunk } from "../run-completed-events.js";

export async function registerAgentStatusSseRoutes(app: FastifyInstance, dependencies: AgentStatusSseRouteDependencies) {
  app.get("/api/internal/agent/events/sse", async (req, reply) => {
    assertInternalToken(req, dependencies.internalToken);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
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
    "/api/internal/agent/sessions/status-summary",
    {
      schema: {
        tags: ["agent"],
        body: AgentSessionStatusSummaryRequestSchema,
        response: {
          200: AgentSessionStatusSummaryResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      try {
        const body = req.body as { sessionId: string; agentId?: string; selectedAgentId?: string };
        return dependencies.service.getSessionStatusSummary({
          sessionId: body.sessionId,
          agentId: body.agentId,
          selectedAgentId: body.selectedAgentId
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(500, "failed to get session status summary", "SESSION_STATUS_SUMMARY_FAILED");
      }
    }
  );

  app.post(
    "/api/internal/agent/sessions/context-items-tail",
    {
      schema: {
        tags: ["agent"],
        body: AgentSessionContextItemsTailRequestSchema,
        response: {
          200: AgentSessionContextItemsTailResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const pluginId = String(req.headers["x-awb-plugin-id"] || "").trim();
      if (!pluginId) {
        throw new HttpError(400, "x-awb-plugin-id is required", "PLUGIN_ID_REQUIRED");
      }
      const body = req.body as { pluginId: string; sessionId: string; tailLimit?: number };
      const bodyPluginId = String(body.pluginId || "").trim();
      if (!bodyPluginId) {
        throw new HttpError(400, "pluginId is required", "PLUGIN_ID_REQUIRED");
      }
      if (bodyPluginId !== pluginId) {
        throw new HttpError(401, "pluginId mismatch", "PLUGIN_ID_MISMATCH");
      }

      const sessionId = String(body.sessionId || "").trim();

      if (!sessionId) {
        throw new HttpError(400, "sessionId is required", "SESSION_ID_REQUIRED");
      }

      return dependencies.service.getContextItems(sessionId, { tailLimit: body.tailLimit });
    }
  );
}
