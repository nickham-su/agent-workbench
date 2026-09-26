import type { FastifyInstance, FastifyRequest } from "fastify";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  ScheduledWorkspaceParamsSchema, ScheduledTaskParamsSchema, ScheduledTaskListQuerySchema,
  ScheduledTaskResponseSchema, ScheduledTaskListResponseSchema, CreateScheduledTaskRequestSchema,
  ReplaceScheduledTaskRequestSchema, ScheduledEmptyBodySchema, ScheduledExecutionListQuerySchema,
  ScheduledExecutionListResponseSchema, ScheduledExecutionResponseSchema, ScheduledServerTimeResponseSchema,
  ValidateScheduledSourceRequestSchema, ScheduledSourceResponseSchema, ScheduledReadyAgentsResponseSchema
} from "@agent-workbench/shared";
import type { CreateScheduledTaskRequest, ReplaceScheduledTaskRequest } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import { scheduledError, type ScheduledTaskService } from "./scheduled-task.service.js";

type WorkspaceParams = { workspaceId: string };
type TaskParams = WorkspaceParams & { taskId: string };
type ListQuery = { status?: "all" | "enabled" | "paused"; q?: string; cursor?: string; limit?: number };
type HistoryQuery = { result?: "all" | "completed" | "failed" | "skipped";
  triggerType?: "all" | "scheduled" | "manual"; cursor?: string; limit?: number };

/** Fastify's default AJV strips unknown fields. Preserve the strict shared request contract. */
function strictBody(schema: TSchema, classifyTrigger = false) {
  return async (request: FastifyRequest) => {
    if (Value.Check(schema, request.body)) return;
    if (classifyTrigger && request.body && typeof request.body === "object") {
      const body = request.body as Record<string, unknown>;
      const mode = body.triggerMode;
      const hasSource = (value: unknown) => typeof value === "string" && value.length > 0;
      if (mode !== "new_session" && mode !== "fork_message" ||
          mode === "new_session" && (body.sourceSessionId != null || body.sourceMessageId != null) ||
          mode === "fork_message" && (!hasSource(body.sourceSessionId) || !hasSource(body.sourceMessageId))) {
        throw new HttpError(400, "Invalid trigger mode and source", "TASK_TRIGGER_MODE_INVALID");
      }
    }
    throw new HttpError(400, "Invalid request", "SCHEDULE_INVALID");
  };
}

export async function registerScheduledTaskRoutes(app: FastifyInstance, service: ScheduledTaskService) {
  const root = "/api/workspaces/:workspaceId/scheduled-tasks";
  const guarded = async <T>(fn: () => T | Promise<T>) => {
    try { return await fn(); } catch (error) { return scheduledError(error); }
  };
  app.get<{Params: WorkspaceParams; Querystring: ListQuery}>(root,
    { schema: { params: ScheduledWorkspaceParamsSchema, querystring: ScheduledTaskListQuerySchema,
      response: { 200: ScheduledTaskListResponseSchema } } },
    async ({ params, query }) => guarded(() => { service.assertWorkspace(params.workspaceId); return service.list({ workspaceId: params.workspaceId, ...query }); }));
  app.post<{Params: WorkspaceParams; Body: CreateScheduledTaskRequest}>(root,
    { preValidation: strictBody(CreateScheduledTaskRequestSchema, true),
      schema: { params: ScheduledWorkspaceParamsSchema, body: CreateScheduledTaskRequestSchema,
      response: { 201: ScheduledTaskResponseSchema } } },
    async ({ params, body }, reply) => guarded(() => reply.code(201).send({ task: service.create(params.workspaceId, body) })));
  app.get<{Params: TaskParams}>(`${root}/:taskId`,
    { schema: { params: ScheduledTaskParamsSchema, response: { 200: ScheduledTaskResponseSchema } } },
    async ({ params }) => guarded(() => ({ task: service.read(params.workspaceId, params.taskId) })));
  app.put<{Params: TaskParams; Body: ReplaceScheduledTaskRequest}>(`${root}/:taskId`,
    { preValidation: strictBody(ReplaceScheduledTaskRequestSchema, true),
      schema: { params: ScheduledTaskParamsSchema, body: ReplaceScheduledTaskRequestSchema,
      response: { 200: ScheduledTaskResponseSchema } } },
    async ({ params, body }) => guarded(() => ({ task: service.replace(params.workspaceId, params.taskId, body) })));
  app.delete<{Params: TaskParams}>(`${root}/:taskId`,
    { schema: { params: ScheduledTaskParamsSchema, response: { 204: { type: "null" } } } },
    async ({ params }, reply) => guarded(() => { service.delete(params.workspaceId, params.taskId); return reply.code(204).send(); }));
  for (const [path, enabled] of [["enable", true], ["pause", false]] as const) {
    app.post<{Params: TaskParams; Body: Record<string, never>}>(`${root}/:taskId/${path}`,
      { preValidation: strictBody(ScheduledEmptyBodySchema), schema: { params: ScheduledTaskParamsSchema, body: ScheduledEmptyBodySchema,
        response: { 200: ScheduledTaskResponseSchema } } },
      async ({ params }) => guarded(() => ({ task: service.enable(params.workspaceId, params.taskId, enabled) })));
  }
  app.post<{Params: TaskParams; Body: Record<string, never>}>(`${root}/:taskId/run`,
    { preValidation: strictBody(ScheduledEmptyBodySchema), schema: { params: ScheduledTaskParamsSchema, body: ScheduledEmptyBodySchema,
      response: { 202: ScheduledExecutionResponseSchema } } },
    async ({ params }, reply) => {
      try { return reply.code(202).send({ execution: await service.run(params.workspaceId, params.taskId) }); }
      catch (error) {
        if (error instanceof HttpError && "executionId" in error && typeof error.executionId === "string") {
          return reply.code(error.statusCode).send({ code: error.code, message: error.message,
            details: { executionId: error.executionId } });
        }
        return scheduledError(error);
      }
    });
  app.get<{Params: TaskParams; Querystring: HistoryQuery}>(`${root}/:taskId/executions`,
    { schema: { params: ScheduledTaskParamsSchema, querystring: ScheduledExecutionListQuerySchema,
      response: { 200: ScheduledExecutionListResponseSchema } } },
    async ({ params, query }) => guarded(() => service.history({ workspaceId: params.workspaceId, taskId: params.taskId, ...query })));
  app.post<{Params: WorkspaceParams; Body: {sessionId: string; messageId: string}}>(`${root}/validate-source`,
    { preValidation: strictBody(ValidateScheduledSourceRequestSchema),
      schema: { params: ScheduledWorkspaceParamsSchema, body: ValidateScheduledSourceRequestSchema,
      response: { 200: ScheduledSourceResponseSchema } } },
    async ({ params, body }) => guarded(() => ({ source: service.validateSource(params.workspaceId, body.sessionId, body.messageId) })));
  app.get<{Params: WorkspaceParams}>(`${root}/server-time`,
    { schema: { params: ScheduledWorkspaceParamsSchema, response: { 200: ScheduledServerTimeResponseSchema } } },
    async ({ params }) => { service.assertWorkspace(params.workspaceId); return { now: Date.now(), protocolVersion: 1 as const }; });
  app.get<{Params: WorkspaceParams}>(`${root}/ready-agents`,
    { schema: { params: ScheduledWorkspaceParamsSchema, response: { 200: ScheduledReadyAgentsResponseSchema } } },
    async ({ params }) => guarded(() => service.readyAgents(params.workspaceId)));
}
