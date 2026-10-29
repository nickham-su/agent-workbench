import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CreateWorkspaceEnvironmentVariableRequestSchema, UpdateWorkspaceEnvironmentVariableRequestSchema,
  SetWorkspaceEnvironmentVariableEnabledRequestSchema, WorkspaceEnvironmentVariableSchema,
  WorkspaceEnvironmentVariablesSchema, WorkspaceEnvironmentParamsSchema, WorkspaceEnvironmentVariableParamsSchema,
  ErrorResponseSchema,
  type CreateWorkspaceEnvironmentVariableRequest, type UpdateWorkspaceEnvironmentVariableRequest,
  type SetWorkspaceEnvironmentVariableEnabledRequest
} from "@agent-workbench/shared";
import { WorkspaceEnvironmentResponseSchema } from "@agent-workbench/shared/internal-contracts/workspace-environment";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { getWorkspaceEnvironmentService } from "./workspace-environment.service.js";

/** Validate before Fastify's default AJV can remove properties or coerce input types. */
function strictBody(schema: TSchema) {
  return async (req: FastifyRequest) => {
    if (!Value.Check(schema, req.body)) throw new HttpError(400, "Invalid Workspace environment variable input.", "WORKSPACE_ENV_INVALID_INPUT");
  };
}

export async function registerWorkspaceEnvironmentRoutes(app: FastifyInstance, ctx: AppContext) {
  const service = getWorkspaceEnvironmentService(ctx);
  // A scoped plugin covers auth/parse/validation errors as well as successful plaintext responses.
  await app.register(async (routes) => {
    routes.addHook("onSend", async (_req, reply, payload) => {
      reply.header("Cache-Control", "no-store");
      return payload;
    });
    routes.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message, code: error.code });
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === "number" && status < 500) {
        return reply.code(status === 413 ? 413 : 400).send({ message: "Invalid Workspace environment variable input.", code: "WORKSPACE_ENV_INVALID_INPUT" });
      }
      return reply.code(503).send({ message: "Workspace environment configuration is unavailable.", code: "WORKSPACE_ENV_UNAVAILABLE" });
    });
    const errors = { 400: ErrorResponseSchema, 401: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 500: ErrorResponseSchema, 503: ErrorResponseSchema };
    const path = "/api/workspaces/:workspaceId/environment-variables";
    const params = (req: FastifyRequest) => req.params as { workspaceId: string; variableId: string };
    routes.get(path, {
      schema: { tags: ["workspaces"], params: WorkspaceEnvironmentParamsSchema, response: { 200: WorkspaceEnvironmentVariablesSchema, ...errors } }
    }, async (req) => service.list(params(req).workspaceId));
    routes.post(path, {
      preValidation: strictBody(CreateWorkspaceEnvironmentVariableRequestSchema),
      schema: { tags: ["workspaces"], params: WorkspaceEnvironmentParamsSchema, body: CreateWorkspaceEnvironmentVariableRequestSchema, response: { 201: WorkspaceEnvironmentVariableSchema, ...errors } }
    }, async (req, reply) => reply.code(201).send(await service.create(params(req).workspaceId, req.body as CreateWorkspaceEnvironmentVariableRequest)));
    routes.patch(`${path}/:variableId`, {
      preValidation: strictBody(UpdateWorkspaceEnvironmentVariableRequestSchema),
      schema: { tags: ["workspaces"], params: WorkspaceEnvironmentVariableParamsSchema, body: UpdateWorkspaceEnvironmentVariableRequestSchema, response: { 200: WorkspaceEnvironmentVariableSchema, ...errors } }
    }, async (req) => service.update(params(req).workspaceId, params(req).variableId, req.body as UpdateWorkspaceEnvironmentVariableRequest));
    routes.put(`${path}/:variableId/enabled`, {
      preValidation: strictBody(SetWorkspaceEnvironmentVariableEnabledRequestSchema),
      schema: { tags: ["workspaces"], params: WorkspaceEnvironmentVariableParamsSchema, body: SetWorkspaceEnvironmentVariableEnabledRequestSchema, response: { 200: WorkspaceEnvironmentVariableSchema, ...errors } }
    }, async (req) => service.update(params(req).workspaceId, params(req).variableId, req.body as SetWorkspaceEnvironmentVariableEnabledRequest));
    routes.delete(`${path}/:variableId`, {
      schema: { tags: ["workspaces"], params: WorkspaceEnvironmentVariableParamsSchema, response: { 204: { type: "null" }, ...errors } }
    }, async (req, reply: FastifyReply) => {
      await service.delete(params(req).workspaceId, params(req).variableId);
      return reply.code(204).send();
    });
    routes.get("/api/internal/workspaces/:workspaceId/environment", {
      schema: { tags: ["internal"], params: WorkspaceEnvironmentParamsSchema, response: { 200: WorkspaceEnvironmentResponseSchema, ...errors } }
    }, async (req) => ({ workspaceId: params(req).workspaceId, env: service.readEnvironment(params(req).workspaceId) }));
  });
}
