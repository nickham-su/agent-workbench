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
  AgentPermissionDecisionSchema,
  AgentRevertSessionRequestSchema,
  AgentSendMessageRequestSchema,
  AgentSendMessageResponseSchema,
  AgentSessionRecordSchema,
  AgentSessionRunStateSchema,
  AgentToolPermissionRequestSchema,
  AgentProviderNpmSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import type { AgentToolPermissionRequest } from "@agent-workbench/shared";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentService } from "./agent.service.js";
import { HttpError } from "../../app/errors.js";

const AgentBuiltinToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("apply_patch"),
  Type.Literal("todolist"),
  Type.Literal("subtask"),
  Type.Literal("archive_search"),
  Type.Literal("archive_read"),
  Type.Literal("archive_tail")
]);
const AgentDynamicToolNameSchema = Type.Union([
  AgentBuiltinToolNameSchema,
  Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" })
]);

function assertInternalToken(req: FastifyRequest, service: AgentService) {
  const token = String(req.headers["x-awb-agent-internal-token"] || "");
  if (token !== service.getContext().agentInternalToken) {
    throw new HttpError(401, "Unauthorized");
  }
}

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
        fromItemId: number;
        title?: string;
        kind?: "primary" | "subtask";
      };
      const session = params.service.forkSession(body);
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
        response: { 200: AgentContextItemsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const query = req.query as { afterId?: number };
      return params.service.getContextItems(p.sessionId, query.afterId);
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
      const body = req.body as { workspaceId: string; toItemId: number; reason?: string };
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
      const result = params.service.cancelSession(p.sessionId, body);
      await params.runtime.cancelSession(p.sessionId);
      return result;
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/tool-permission",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentToolPermissionRequestSchema,
        response: {
          200: Type.Object({ runId: Type.String({ minLength: 1 }), decision: AgentPermissionDecisionSchema }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as AgentToolPermissionRequest;
      const result = params.service.applyToolPermission(p.sessionId, body);
      const workspace = params.service.getWorkspace(body.workspaceId);
      if (workspace) {
        await params.runtime.enqueueRun({
          workspaceId: body.workspaceId,
          sessionId: p.sessionId,
          runId: result.runId,
          workspacePath: workspace.path,
          inputText: ""
        });
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
    "/api/internal/agent/subtask/start",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          parentSessionId: Type.String({ minLength: 1 }),
          parentRunId: Type.String({ minLength: 1 }),
          parentToolItemId: Type.Number({ minimum: 1 }),
          description: Type.String({ minLength: 1, maxLength: 20 }),
          prompt: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 }),
          session: Type.Union([
            Type.Object({ mode: Type.Literal("new") }),
            Type.Object({ mode: Type.Literal("existing"), sessionId: Type.String({ minLength: 1 }) }),
            Type.Object({ mode: Type.Literal("fork") })
          ])
        }),
        response: {
          200: Type.Object({
            sessionId: Type.String({ minLength: 1 }),
            runId: Type.String({ minLength: 1 }),
            workspacePath: Type.String({ minLength: 1 })
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
              Type.Literal("waiting_permission"),
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
        status: "streaming" | "queued" | "running" | "awaiting_permission" | "completed" | "failed" | "denied" | "cancelled";
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
        status?: "streaming" | "queued" | "running" | "awaiting_permission" | "completed" | "failed" | "denied" | "cancelled";
        output?: unknown;
        updatedAt?: number;
      };
      const item = params.service.updateContextItemFromWorker({
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
          status: Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("waiting_permission")]),
          activeRunId: Type.Union([Type.String(), Type.Null()]),
          activeAssistantItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
          waitingToolItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
          lastResponseTotalTokens: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
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
        status: "idle" | "running" | "waiting_permission";
        activeRunId: string | null;
        activeAssistantItemId: number | null;
        waitingToolItemId: number | null;
        lastResponseTotalTokens?: number | null;
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
          cursor: Type.Optional(Type.String({ minLength: 1 })),
          maxHits: Type.Optional(Type.Number({ minimum: 1 })),
          maxChars: Type.Optional(Type.Number({ minimum: 1 })),
          regex: Type.Optional(Type.Boolean())
        }),
        response: {
          200: Type.Object({
            hits: Type.Array(
              Type.Object({
                file: Type.String({ minLength: 1 }),
                line: Type.Number({ minimum: 1 }),
                preview: Type.String()
              })
            ),
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            hasMore: Type.Boolean(),
            truncated: Type.Boolean()
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
        query: string;
        cursor?: string;
        maxHits?: number;
        maxChars?: number;
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
          file: Type.String({ minLength: 1 }),
          startLine: Type.Number({ minimum: 1 }),
          lineCount: Type.Optional(Type.Number({ minimum: 1 })),
          maxChars: Type.Optional(Type.Number({ minimum: 1 }))
        }),
        response: {
          200: Type.Object({
            lines: Type.Array(
              Type.Object({
                line: Type.Number({ minimum: 1 }),
                text: Type.String(),
                truncated: Type.Boolean()
              })
            ),
            nextStartLine: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
            hasMore: Type.Boolean(),
            truncated: Type.Boolean()
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
        file: string;
        startLine: number;
        lineCount?: number;
        maxChars?: number;
      };
      return params.service.archiveReadFromWorker(body);
    }
  );

  app.post(
    "/api/internal/agent/archive/tail",
    {
      schema: {
        tags: ["agent"],
        body: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
          sessionId: Type.String({ minLength: 1 }),
          n: Type.Number({ minimum: 1 }),
          cursor: Type.Optional(Type.String({ minLength: 1 })),
          maxChars: Type.Optional(Type.Number({ minimum: 1 }))
        }),
        response: {
          200: Type.Object({
            lines: Type.Array(
              Type.Object({
                file: Type.String({ minLength: 1 }),
                line: Type.Number({ minimum: 1 }),
                text: Type.String()
              })
            ),
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            hasMore: Type.Boolean(),
            truncated: Type.Boolean()
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
        n: number;
        cursor?: string;
        maxChars?: number;
      };
      return params.service.archiveTailFromWorker(body);
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
                inputSchema: Type.Any(),
                requiresApproval: Type.Boolean()
              })
            ),
            pendingTools: Type.Array(
              Type.Object({
                itemId: Type.Number({ minimum: 1 }),
                status: AgentContextItemStatusSchema,
                toolName: AgentDynamicToolNameSchema,
                toolCallId: Type.Optional(Type.String({ minLength: 1 })),
                args: Type.Any(),
                approved: Type.Optional(Type.Boolean())
              })
            ),
            lastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()])
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
              mcpServers: Type.Array(Type.String({ minLength: 1 })),
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
              })
            }),
            model: Type.Object({
              id: Type.String({ minLength: 1 }),
              providerModelId: Type.Optional(Type.String({ minLength: 1 })),
              name: Type.String({ minLength: 1 }),
              options: Type.Optional(Type.Any())
            }),
            runtime: Type.Object({
              modelIdleTimeoutMs: Type.Integer({ minimum: 0 }),
              modelTotalTimeoutMs: Type.Integer({ minimum: 0 }),
              maxContextTokens: Type.Integer({ minimum: 1 }),
              autoCompactThresholdPct: Type.Integer({ minimum: 50, maximum: 90 }),
              updatedAt: Type.Number()
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
              providerId: Type.String({ minLength: 1 }),
              modelId: Type.String({ minLength: 1 }),
              source: Type.Literal("global_default")
            }),
            provider: Type.Object({
              id: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
              npm: AgentProviderNpmSchema,
              options: Type.Object({
                baseURL: Type.String({ minLength: 1 }),
                apiKey: Type.String({ minLength: 1 })
              })
            }),
            model: Type.Object({
              id: Type.String({ minLength: 1 }),
              providerModelId: Type.Optional(Type.String({ minLength: 1 })),
              name: Type.String({ minLength: 1 }),
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
