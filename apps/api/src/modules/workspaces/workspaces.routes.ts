import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  CreateWorkspaceRequestSchema,
  SwitchWorkspaceBranchRequestSchema,
  WorkspaceDetailSchema
} from "@agent-workbench/shared";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaceDetailById,
  listWorkspaceDetails,
  switchWorkspaceBranch
} from "./workspace.service.js";

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
      const body = req.body as { repoId: string; branch: string };
      const ws = await createWorkspace(ctx, app.log, { repoId: body.repoId, branch: body.branch });
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

  app.post(
    "/api/workspaces/:workspaceId/git/checkout",
    {
      schema: {
        tags: ["git"],
        body: SwitchWorkspaceBranchRequestSchema,
        response: { 200: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] }, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = req.body as { branch: string };
      return switchWorkspaceBranch(ctx, app.log, params.workspaceId, body.branch);
    }
  );

  app.delete(
    "/api/workspaces/:workspaceId",
    {
      schema: { tags: ["workspaces"], response: { 204: { type: "null" }, 404: ErrorResponseSchema } }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      await deleteWorkspace(ctx, app.log, params.workspaceId);
      return reply.code(204).send();
    }
  );
}
