import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentService } from "./agent.service.js";
import { HttpError } from "../../app/errors.js";
import type { AgentPluginHostClient } from "./agent.plugin-host-client.js";
import { listAvailableAgentsForSurface } from "../settings/settings.service.js";
import { getWorkspaceEnabledAgentIds } from "../workspaces/workspace.service.js";
import { type AgentRunCompletedEventHub, toSseEventChunk } from "./run-completed-events.js";

const AgentBuiltinToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("apply_patch"),
  Type.Literal("scratchpad"),
  Type.Literal("todolist"),
  Type.Literal("subtask"),
  Type.Literal("archive_search"),
  Type.Literal("skill"),
  Type.Literal("archive_read"),
  Type.Literal("visual_analyze")
]);
const AgentDynamicToolNameSchema = Type.Union([
  AgentBuiltinToolNameSchema,
  Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" }),
  PluginToolCanonicalNameSchema
]);

function assertInternalToken(req: FastifyRequest, service: AgentService) {
  const token = String(req.headers["x-awb-agent-internal-token"] || "");
  if (token !== service.getContext().agentInternalToken) {
    throw new HttpError(401, "Unauthorized");
  }
}

function assertPluginCaller(req: FastifyRequest, pluginId: string) {
  const caller = String(req.headers["x-awb-plugin-id"] || "").trim();
  if (!caller) {
    throw new HttpError(401, "Unauthorized", "PLUGIN_CALLER_REQUIRED");
  }
  if (caller !== String(pluginId || "").trim()) {
    throw new HttpError(401, "Unauthorized", "PLUGIN_CALLER_MISMATCH");
  }
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  params: {
    service: AgentService;
    runtime: AgentRuntimePort;
    pluginHost?: AgentPluginHostClient | null;
    runCompletedEventHub: AgentRunCompletedEventHub;
  }
) {
  async function handleCompactRequest(
    sessionId: string,
    body: { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" }
  ) {
    const result = await params.service.compactSession({ sessionId, body });
    if (result.scheduled) {
      const workspace = params.service.getWorkspace(body.workspaceId);
      if (!workspace) throw new HttpError(404, "workspace not found");
      try {
        await params.runtime.enqueueRun({
          workspaceId: body.workspaceId,
          sessionId,
          runId: result.runId,
          workspacePath: workspace.path,
          inputText: "__awb_compact__"
        });
      } catch (err) {
        params.service.failRunOnEnqueueFailure({
          workspaceId: body.workspaceId,
          sessionId,
          runId: result.runId,
          updatedAt: Date.now()
        });
        throw err;
      }
    }
    return result;
  }

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
        response: {
          201: AgentSessionRecordSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      const body = req.body as {
        fromSessionId: string;
        fromItemId: number;
        mode: "with_archive" | "visible_only";
        title?: string;
        kind?: "primary" | "subtask";
      };
      const session = await params.service.forkSession(body);
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
      return params.service.getContextItems(p.sessionId, {
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
      return params.service.getContextItem(p.sessionId, p.itemId);
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
      return await params.service.getApplyPatchUiArtifact({ sessionId: p.sessionId, itemId: p.itemId });
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
      return await params.service.getWriteUiArtifact({ sessionId: p.sessionId, itemId: p.itemId });
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
      const body = req.body as AgentSendMessageRequest;
      const result = await params.service.sendMessage({ sessionId: p.sessionId, body });
      if (!result.deduplicated) {
        const workspace = params.service.getWorkspace(body.workspaceId);
        if (!workspace) throw new HttpError(404, "workspace not found");
        await params.runtime.enqueueRun({
          workspaceId: body.workspaceId,
          sessionId: p.sessionId,
          runId: result.runId,
          workspacePath: workspace.path,
          inputText: body.text
        });
      }
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
      const result = await handleCompactRequest(p.sessionId, body);
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
      assertInternalToken(req, params.service);
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" };
      const result = await handleCompactRequest(p.sessionId, body);
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
      return params.service.clearSession(p.sessionId, body);
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
      const body = req.body as { workspaceId: string };
      const { result, runtimeCancelSessionIds } = params.service.cancelSessionCascade(p.sessionId, body);
      const settled = await Promise.allSettled(runtimeCancelSessionIds.map((sessionId) => params.runtime.cancelSession(sessionId)));
      for (let i = 0; i < settled.length; i += 1) {
        const item = settled[i];
        const targetSessionId = runtimeCancelSessionIds[i];
        if (!item || item.status !== "rejected") continue;
        req.log.warn({ err: item.reason, rootSessionId: p.sessionId, targetSessionId }, "agent cancel runtime session failed");
      }
      return result;
    }
  );

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
      assertInternalToken(req, params.service);
      return params.service.getAgentMcpSettingsFromWorker();
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
      assertInternalToken(req, params.service);
      return params.service.getPluginRuntimeSnapshotsFromWorker();
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
      assertInternalToken(req, params.service);
      if (!params.pluginHost) {
        throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
      }
      return await params.pluginHost.listTools(req.body as any);
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
      assertInternalToken(req, params.service);
      if (!params.pluginHost) {
        throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
      }
      return await params.pluginHost.executeTool(req.body as any);
    }
  );

  app.post(
    "/api/internal/agent/subtask/prefork-plan",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          parentSessionId: Type.String({ minLength: 1 }),
          parentRunId: Type.String({ minLength: 1 }),
          parentToolItemId: Type.Number({ minimum: 1 }),
          agentId: Type.String({ minLength: 1 }),
          thresholdPct: Type.Optional(Type.Number())
        }),
        response: {
          200: Type.Object({
            shouldPrefork: Type.Boolean(),
            thresholdPct: Type.Integer({ minimum: 50, maximum: 99 }),
            parentLastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
            childContextWindowTokens: Type.Integer({ minimum: 1 }),
            thresholdTokens: Type.Integer({ minimum: 1 })
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        parentSessionId: string;
        parentRunId: string;
        parentToolItemId: number;
        agentId: string;
        thresholdPct?: number;
      };
      return params.service.getSubtaskPreforkPlanFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/subtask/start",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          parentSessionId: Type.String({ minLength: 1 }),
          parentRunId: Type.String({ minLength: 1 }),
          parentToolItemId: Type.Number({ minimum: 1 }),
          description: Type.String({ minLength: 1 }),
          prompt: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 }),
          session: Type.Union([
            Type.Object({ mode: Type.Literal("new") }),
             Type.Object({ mode: Type.Literal("existing"), sessionId: Type.String({ minLength: 1 }) }),
             Type.Object({ mode: Type.Literal("fork") })
           ]),
           preforkSummaryText: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
           preforkMeta: Type.Optional(Type.Object({
             thresholdPct: Type.Integer({ minimum: 50, maximum: 99 }),
             parentLastResponseTotalTokens: Type.Number({ minimum: 0 }),
            childContextWindowTokens: Type.Integer({ minimum: 1 })
          }, {
            additionalProperties: false
          }))
        }),
        response: {
          200: Type.Object({
            sessionId: Type.String({ minLength: 1 }),
            runId: Type.String({ minLength: 1 }),
            workspacePath: Type.String({ minLength: 1 }),
            agentName: Type.String({ minLength: 1 })
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        parentSessionId: string;
        parentRunId: string;
        parentToolItemId: number;
        description: string;
        prompt: string;
        agentId: string;
        session: { mode: "new" | "existing" | "fork"; sessionId?: string };
        preforkSummaryText?: string;
        preforkMeta?: {
          thresholdPct: number;
          parentLastResponseTotalTokens: number;
          childContextWindowTokens: number;
        };
      };
      return params.service.startSubtaskRunFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/subtask/result",
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
            resultText: Type.String()
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as { workspaceId: string; sessionId: string; runId: string };
      return params.service.getSubtaskRunResultFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/subtask/status",
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
            status: Type.Union([
              Type.Literal("running"),
              Type.Literal("completed"),
              Type.Literal("failed"),
              Type.Literal("cancelled")
            ])
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as { workspaceId: string; sessionId: string; runId: string };
      return params.service.getSubtaskRunStatusFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/context-items",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          runId: Type.Union([Type.String(), Type.Null()]),
          turnId: Type.Union([Type.String(), Type.Null()]),
          step: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
          prevId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
          kind: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("system")]),
          status: AgentContextItemStatusSchema,
          output: Type.Any(),
          createdAt: Type.Optional(Type.Number())
        }),
        response: {
          200: Type.Object({ ok: Type.Boolean(), item: AgentContextItemRecordSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string | null;
         turnId: string | null;
         step: number | null;
         prevId: number | null;
         kind: "user" | "assistant" | "tool" | "system";
         status: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
         output: unknown;
         createdAt?: number;
       };
      const item = params.service.appendContextItemFromWorker({
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
        runId: body.runId,
        turnId: body.turnId,
        step: body.step,
        prevId: body.prevId,
        kind: body.kind,
        status: body.status,
        output: body.output as any,
        createdAt: body.createdAt
      });
      return { ok: true, item };
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
      assertInternalToken(req, params.service);
      const body = req.body as { limit?: number; kind?: "primary" | "subtask" | "all" };
      const limit = typeof body.limit === "number" ? body.limit : 10;
      const kind = body.kind === "primary" || body.kind === "subtask" || body.kind === "all" ? body.kind : "all";
      return params.service.listRecentSessions({ limit, kind });
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
      assertInternalToken(req, params.service);
      const query = req.query as { limit?: number };
      const limit = typeof query.limit === "number" ? query.limit : 10;
      return params.service.listRecentWorkspaces({ limit });
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
      assertInternalToken(req, params.service);
      const body = req.body as { pluginId: string; senderId: string };
      assertPluginCaller(req, body.pluginId);
      return params.service.checkChannelSenderAllowlist(body);
    }
  );

  app.post(
    "/api/internal/agent/sessions/create",
    {
      schema: {
        tags: ["agent"],
        body: AgentInternalCreateSessionRequestSchema,
        response: { 201: AgentSessionRecordSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      assertInternalToken(req, params.service);
      const body = req.body as { workspaceId: string; title?: string; kind?: "primary" | "subtask" };
      const session = params.service.createSession(body);
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
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        agentId: string;
        text: string;
        clientRequestId: string;
        uiLocale?: "zh-CN" | "en-US";
      };
      const result = await params.service.sendMessage({
        sessionId: body.sessionId,
        body: {
          workspaceId: body.workspaceId,
          agentId: body.agentId,
          text: body.text,
          clientRequestId: body.clientRequestId,
          uiLocale: body.uiLocale
        }
      });
      if (!result.deduplicated) {
        const workspace = params.service.getWorkspace(body.workspaceId);
        if (!workspace) throw new HttpError(404, "workspace not found");
        try {
          await params.runtime.enqueueRun({
            workspaceId: body.workspaceId,
            sessionId: body.sessionId,
            runId: result.runId,
            workspacePath: workspace.path,
            inputText: body.text
          });
        } catch (err) {
          params.service.failRunOnEnqueueFailure({
            workspaceId: body.workspaceId,
            sessionId: body.sessionId,
            runId: result.runId,
            updatedAt: Date.now()
          });
          throw err;
        }
      }
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
      assertInternalToken(req, params.service);
      const p = req.params as { runId: string };
      return params.service.getRunFinalText({ runId: p.runId });
    }
  );

  app.get("/api/internal/agent/events/sse", async (req, reply) => {
    assertInternalToken(req, params.service);
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
    const unsubscribe = params.runCompletedEventHub.subscribe((event) => {
      reply.raw.write(toSseEventChunk(event));
    });
    req.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

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
      assertInternalToken(req, params.service);
      const body = req.body as { workspaceId: string; surface?: string };
      const workspaceId = String(body.workspaceId || "").trim();
      if (!workspaceId) throw new HttpError(400, "workspaceId is required", "WORKSPACE_ID_REQUIRED");
      const ws = params.service.getWorkspace(workspaceId);
      if (!ws) throw new HttpError(404, "workspace not found", "WORKSPACE_NOT_FOUND");
      const surface = body.surface ?? "user";
      if (surface !== "user") throw new HttpError(400, "surface must be user", "AGENT_SURFACE_INVALID");

      const workspaceEnablement = getWorkspaceEnabledAgentIds(params.service.getContext(), workspaceId);
      const agents = listAvailableAgentsForSurface(params.service.getContext(), surface, { workspaceEnablement })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
      return { agents };
    }
  );

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
      assertInternalToken(req, params.service);
      try {
        const body = req.body as { sessionId: string; agentId?: string; selectedAgentId?: string };
        return params.service.getSessionStatusSummary({
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
      assertInternalToken(req, params.service);
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

      return params.service.getContextItems(sessionId, { tailLimit: body.tailLimit });
    }
  );

  app.patch(
    "/api/internal/agent/context-items/:itemId",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ itemId: Type.Number({ minimum: 1 }) }),
        body: Type.Object({
          status: Type.Optional(AgentContextItemStatusSchema),
          output: Type.Optional(Type.Any()),
          updatedAt: Type.Optional(Type.Number())
        }),
        response: {
          200: Type.Object({ ok: Type.Boolean(), item: AgentContextItemRecordSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const p = req.params as { itemId: number };
      const body = req.body as {
        status?: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
        output?: unknown;
        updatedAt?: number;
      };
      const item = await params.service.updateContextItemFromWorker({
        itemId: p.itemId,
        status: body.status,
        output: body.output as any,
        updatedAt: body.updatedAt
      });
      return { ok: true, item };
    }
  );

  app.post(
    "/api/internal/agent/run-state",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
          activeRunId: Type.Union([Type.String(), Type.Null()]),
          activeAssistantItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
          lastResponseTotalTokens: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
          runNoticeText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          updatedAt: Type.Optional(Type.Number())
        }),
        response: { 200: Type.Object({ ok: Type.Boolean() }), 401: ErrorResponseSchema }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        status: "idle" | "running";
        activeRunId: string | null;
        activeAssistantItemId: number | null;
        lastResponseTotalTokens?: number | null;
        runNoticeText?: string | null;
        updatedAt?: number;
      };
      params.service.updateRunStateFromWorker(body);
      return { ok: true };
    }
  );

  app.post(
    "/api/internal/agent/run-complete",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          runId: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]),
          updatedAt: Type.Optional(Type.Number())
        }),
        response: { 200: Type.Object({ ok: Type.Boolean() }), 401: ErrorResponseSchema }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string;
        status: "completed" | "failed" | "cancelled";
        updatedAt?: number;
      };
      params.service.completeRunFromWorker(body);
      return { ok: true };
    }
  );

  app.post(
    "/api/internal/agent/context/compact",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          runId: Type.String({ minLength: 1 }),
          expectedHeadItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
          summaryText: Type.String({ minLength: 1 })
        }),
        response: {
          200: Type.Object({
            compacted: Type.Boolean(),
            summaryItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
            archivedCount: Type.Number({ minimum: 0 })
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string;
        expectedHeadItemId: number | null;
        summaryText: string;
      };
      return params.service.compactContextFromWorker(body);
    }
  );

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
      assertInternalToken(req, params.service);
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
      return params.service.archiveSearchFromWorker(body);
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
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        beforePos?: number;
        lineCount?: number;
        maxChars?: number;
      };
      return params.service.archiveReadFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/prompt-context",
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
            headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
            system: Type.String(),
            messages: Type.Array(
              Type.Object({
                role: Type.Union([Type.Literal("system"), Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
                content: Type.Any()
              })
            ),
            tools: Type.Array(
              Type.Object({
                name: AgentDynamicToolNameSchema,
                description: Type.String(),
                inputSchema: Type.Any()
              })
            ),
            pendingTools: Type.Array(
              Type.Object({
                itemId: Type.Number({ minimum: 1 }),
                status: AgentContextItemStatusSchema,
                toolName: AgentDynamicToolNameSchema,
                toolCallId: Type.Optional(Type.String({ minLength: 1 })),
                args: Type.Any()
              })
            ),
            lastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
            uiLocale: Type.Union([AgentUiLocaleSchema, Type.Null()]),
            externalSkillRoots: Type.Array(
              Type.Object({
                sourceType: Type.Union([Type.Literal("workspace"), Type.Literal("repo")]),
                repoId: Type.Optional(Type.String({ minLength: 1 })),
                rootDir: Type.String({ minLength: 1 }),
                rootPath: Type.String({ minLength: 1 })
              })
            )
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as { workspaceId: string; sessionId: string; runId: string };
      return params.service.getPromptContextForRun(body);
    }
  );

  app.post(
    "/api/internal/agent/messages-context",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          appendMessage: Type.Optional(
            Type.Object({
              role: Type.Union([Type.Literal("system"), Type.Literal("user")]),
              content: Type.String({ minLength: 1 })
            })
          )
        }),
        response: {
          200: Type.Object({
            headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
            system: Type.String(),
            messages: Type.Array(
              Type.Object({
                role: Type.Union([Type.Literal("system"), Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
                content: Type.Any()
              })
            )
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        appendMessage?: { role: "system" | "user"; content: string };
      };
      return params.service.getMessagesContext(body);
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
               summary: Type.String({ maxLength: 160 }),
               prompt: Type.String(),
               tools: Type.Array(AgentBuiltinToolNameSchema),
               pluginTools: Type.Array(PluginToolCanonicalNameSchema),
               mcpServers: Type.Array(Type.String({ minLength: 1 })),
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
            }),
            runtime: Type.Object({
              modelIdleTimeoutMs: Type.Integer({ minimum: 0 }),
              modelTotalTimeoutMs: Type.Integer({ minimum: 0 }),
              modelRequestMaxRetries: Type.Integer({ minimum: 0, maximum: 100 }),
              autoCompactThresholdPct: Type.Integer({ minimum: 50, maximum: 99 }),
              visionModel: Type.Union([
                Type.Object({
                  providerId: Type.String({ minLength: 1 }),
                  modelId: Type.String({ minLength: 1 })
                }),
                Type.Null()
              ]),
              updatedAt: Type.Number()
            }),
            vision: Type.Union([
              Type.Object({
                source: Type.Union([Type.Literal("runtime_vision"), Type.Literal("agent_default_fallback")]),
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
              Type.Null()
            ]),
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string;
      };
      return params.service.getExecutionProfileForRun(body);
    }
  );

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
      assertInternalToken(req, params.service);
      const body = req.body as {
        workspaceId: string;
        sessionId: string;
        runId: string;
      };
      return params.service.getSingleCallModelProfileForRun(body);
    }
  );
}
