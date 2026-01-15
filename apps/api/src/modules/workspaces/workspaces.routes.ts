import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceDetailSchema
} from "@agent-workbench/shared";
import { createWorkspace, deleteWorkspace, getWorkspaceDetailById, listWorkspaceDetails, updateWorkspaceTitleById } from "./workspace.service.js";

export async function registerWorkspacesRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/workspaces",
    {
      schema: { tags: ["workspaces"], response: { 200: { type: "array", items: WorkspaceDetailSchema } } }
    },
    async () => listWorkspaceDetails(ctx)
  );

  app.post(
    "/api/workspaces",
    {
      schema: {
        tags: ["workspaces"],
        body: CreateWorkspaceRequestSchema,
        response: { 201: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const body = req.body as { repoIds: string[]; title?: string; useTerminalCredential?: boolean };
      const ws = await createWorkspace(ctx, app.log, {
        repoIds: body.repoIds,
        title: body.title,
        useTerminalCredential: body.useTerminalCredential
      });
      const detail = await getWorkspaceDetailById(ctx, ws.id);
      return reply.code(201).send(detail);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId",
    {
      schema: { tags: ["workspaces"], response: { 200: WorkspaceDetailSchema, 404: ErrorResponseSchema } }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return getWorkspaceDetailById(ctx, params.workspaceId);
    }
  );

  app.patch(
    "/api/workspaces/:workspaceId",
    {
      schema: {
        tags: ["workspaces"],
        body: UpdateWorkspaceRequestSchema,
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = req.body as { title: string };
      return updateWorkspaceTitleById(ctx, app.log, params.workspaceId, body.title);
    }
  );

  app.delete(
    "/api/workspaces/:workspaceId",
    {
      schema: { tags: ["workspaces"], response: { 204: { type: "null" }, 404: ErrorResponseSchema, 409: ErrorResponseSchema } }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      await deleteWorkspace(ctx, app.log, params.workspaceId);
      return reply.code(204).send();
    }
  );
}
