import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  AttachWorkspaceRepoRequestSchema,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceDetailSchema
} from "@agent-workbench/shared";
import { nowMs } from "../../utils/time.js";
import {
  attachRepoToWorkspace,
  createWorkspace,
  deleteWorkspace,
  detachRepoFromWorkspace,
  getWorkspaceDetailById,
  listWorkspaceDetails,
  updateWorkspaceById
} from "./workspace.service.js";
import { touchWorkspaceLastUsedAt } from "./workspace.store.js";

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
      const detail = await getWorkspaceDetailById(ctx, params.workspaceId);
      // “最近使用”以用户进入 workspace 页并拉取详情为准（不要求强一致）。
      try {
        touchWorkspaceLastUsedAt(ctx.db, params.workspaceId, nowMs());
      } catch {
        // ignore
      }
      return detail;
    }
  );

  app.patch(
    "/api/workspaces/:workspaceId",
    {
      schema: {
        tags: ["workspaces"],
        body: UpdateWorkspaceRequestSchema,
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = req.body as { title?: string; useTerminalCredential?: boolean };
      return updateWorkspaceById(ctx, app.log, params.workspaceId, {
        title: body.title,
        useTerminalCredential: body.useTerminalCredential
      });
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

  app.post(
    "/api/workspaces/:workspaceId/repos",
    {
      schema: {
        tags: ["workspaces"],
        body: AttachWorkspaceRepoRequestSchema,
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = req.body as { repoId: string; branch?: string };
      return attachRepoToWorkspace(ctx, app.log, params.workspaceId, { repoId: body.repoId, branch: body.branch });
    }
  );

  app.delete(
    "/api/workspaces/:workspaceId/repos/:repoId",
    {
      schema: {
        tags: ["workspaces"],
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string; repoId: string };
      return detachRepoFromWorkspace(ctx, app.log, params.workspaceId, params.repoId);
    }
  );
}
