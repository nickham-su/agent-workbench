import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  AgentInternalCreateSessionRequestSchema,
  AgentSendMessageResponseSchema,
  AgentChannelAllowlistCheckRequestSchema,
  AgentChannelAllowlistCheckResponseSchema,
  AgentSessionRecordSchema,
  AgentUiLocaleSchema,
  AgentRecentSessionsRequestSchema,
  AgentRecentSessionsResponseSchema,
  AgentListAvailableAgentsRequestSchema,
  AgentListAvailableAgentsResponseSchema,
  AgentRecentWorkspacesRequestSchema,
  AgentRecentWorkspacesResponseSchema,
  PluginRuntimeSnapshotsResponseSchema,
  PluginToolRpcExecuteRequestSchema,
  PluginToolRpcExecuteResponseSchema,
  PluginToolRpcListRequestSchema,
  PluginToolRpcListResponseSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { AgentPeripheralRouteDependencies } from "./agent-route-types.js";
import { assertInternalToken, assertOnlyAllowedBodyKeys, assertPluginCaller, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS } from "./agent-route-auth.js";

export async function registerAgentPeripheralRoutes(app: FastifyInstance, dependencies: AgentPeripheralRouteDependencies) {
  app.post(
    "/api/internal/agent/mcp-settings",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({}),
        response: {
          200: Type.Object({
            servers: Type.Array(
              Type.Object({
                id: Type.String({ minLength: 1 }),
                enabled: Type.Boolean(),
                config: Type.Any()
              })
            ),
            updatedAt: Type.Number()
          }),
          401: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.getAgentMcpSettingsFromWorker();
    }
  );

  app.post(
    "/api/internal/agent/plugins/runtime-snapshots",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({}),
        response: {
          200: PluginRuntimeSnapshotsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.getPluginRuntimeSnapshotsFromWorker();
    }
  );

  app.post(
    "/api/internal/agent/plugins/tools/list",
    {
      schema: {
        tags: ["agent"],
        body: PluginToolRpcListRequestSchema,
        response: {
          200: PluginToolRpcListResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      if (!dependencies.pluginHost) {
        throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
      }
      return await dependencies.pluginHost.listTools(req.body as any);
    }
  );

  app.post(
    "/api/internal/agent/plugins/tools/execute",
    {
      schema: {
        tags: ["agent"],
        body: PluginToolRpcExecuteRequestSchema,
        response: {
          200: PluginToolRpcExecuteResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      if (!dependencies.pluginHost) {
        throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
      }
      return await dependencies.pluginHost.executeTool(req.body as any);
    }
  );

  app.post(
    "/api/internal/agent/sessions/recent",
    {
      schema: {
        tags: ["agent"],
        body: AgentRecentSessionsRequestSchema,
        response: {
          200: AgentRecentSessionsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.listRecentSessions(req.body as { limit?: number; kind?: "primary" | "subtask" | "all" });
    }
  );

  app.get(
    "/api/internal/agent/workspaces/list",
    {
      schema: {
        tags: ["agent"],
        querystring: AgentRecentWorkspacesRequestSchema,
        response: {
          200: AgentRecentWorkspacesResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      return dependencies.service.listRecentWorkspaces(req.query as { limit?: number });
    }
  );

  app.post(
    "/api/internal/agent/channels/allowlist/check",
    {
      schema: {
        tags: ["agent"],
        body: AgentChannelAllowlistCheckRequestSchema,
        response: {
          200: AgentChannelAllowlistCheckResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as { pluginId: string; senderId: string };
      assertPluginCaller(req, body.pluginId);
      return dependencies.service.checkChannelSenderAllowlist(body);
    }
  );

  app.post(
    "/api/internal/agent/sessions/create",
    {
      schema: {
        tags: ["agent"],
        body: AgentInternalCreateSessionRequestSchema,
        response: { 201: AgentSessionRecordSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 404: ErrorResponseSchema }
      },
      preValidation: async (req) => assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS)
    },
    async (req, reply) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as { workspaceId: string; title?: string };
      const session = dependencies.service.createPrimarySession(body);
      return reply.code(201).send(session);
    }
  );

  app.post(
    "/api/internal/agent/runs/trigger",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 }),
          text: Type.String({ minLength: 1 }),
          clientRequestId: Type.String({ minLength: 1 }),
          uiLocale: Type.Optional(AgentUiLocaleSchema)
        }),
        response: {
          201: AgentSendMessageResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        agentId: string;
        text: string;
        clientRequestId: string;
        uiLocale?: "zh-CN" | "en-US";
      };
      const result = await dependencies.service.sendMessage({
        sessionId: body.sessionId,
        body: {
          workspaceId: body.workspaceId,
          agentId: body.agentId,
          text: body.text,
          clientRequestId: body.clientRequestId,
          uiLocale: body.uiLocale
        },
        runtime: dependencies.runtime
      });
      return reply.code(201).send(result);
    }
  );

  app.get(
    "/api/internal/agent/runs/:runId/final-text",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ runId: Type.String({ minLength: 1 }) }),
        response: {
          200: Type.Object({
            found: Type.Boolean(),
            text: Type.String()
          }),
          401: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const p = req.params as { runId: string };
      return dependencies.service.getRunFinalText({ runId: p.runId });
    }
  );

  app.post(
    "/api/internal/agent/agents/list",
    {
      schema: {
        tags: ["agent"],
        body: AgentListAvailableAgentsRequestSchema,
        response: {
          200: AgentListAvailableAgentsResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, dependencies.internalToken);
      const body = req.body as { workspaceId: string; surface?: string };
      return dependencies.service.listAvailableAgents(body);
    }
  );
}
