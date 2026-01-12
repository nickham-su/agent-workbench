import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  ChangesResponseSchema,
  FileCompareResponseSchema,
  GitCommitRequestSchema,
  GitCommitResponseSchema,
  GitDiscardRequestSchema,
  GitPullRequestSchema,
  GitPullResponseSchema,
  GitPushRequestSchema,
  GitPushResponseSchema,
  GitStageRequestSchema,
  GitUnstageRequestSchema
} from "@agent-workbench/shared";
import {
  commitWorkspace,
  discardWorkspace,
  fileCompare,
  listChanges,
  pullWorkspace,
  pushWorkspace,
  stageWorkspace,
  unstageWorkspace
} from "./git.service.js";

export async function registerGitRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/workspaces/:workspaceId/changes",
    {
      schema: {
        tags: ["git"],
        querystring: {
          type: "object",
          properties: { mode: { type: "string" } },
          required: ["mode"]
        },
        response: { 200: ChangesResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const query = req.query as { mode?: string };
      return listChanges(ctx, params.workspaceId, query.mode);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/git/stage",
    {
      schema: {
        tags: ["git"],
        body: GitStageRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as any;
      await stageWorkspace(ctx, params.workspaceId, body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/git/unstage",
    {
      schema: {
        tags: ["git"],
        body: GitUnstageRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as any;
      await unstageWorkspace(ctx, params.workspaceId, body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/git/discard",
    {
      schema: {
        tags: ["git"],
        body: GitDiscardRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as any;
      await discardWorkspace(ctx, params.workspaceId, body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/git/commit",
    {
      schema: {
        tags: ["git"],
        body: GitCommitRequestSchema,
        response: { 200: GitCommitResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as any;
      return commitWorkspace(ctx, params.workspaceId, body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/git/push",
    {
      schema: {
        tags: ["git"],
        body: GitPushRequestSchema,
        response: { 200: GitPushResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as any;
      return pushWorkspace(ctx, params.workspaceId, body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/git/pull",
    {
      schema: {
        tags: ["git"],
        body: GitPullRequestSchema,
        response: { 200: GitPullResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as any;
      return pullWorkspace(ctx, params.workspaceId, body);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/file-compare",
    {
      schema: {
        tags: ["git"],
        querystring: {
          type: "object",
          properties: { mode: { type: "string" }, path: { type: "string" }, oldPath: { type: "string" } },
          required: ["mode", "path"]
        },
        response: { 200: FileCompareResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const query = req.query as { mode?: string; path?: string; oldPath?: string };
      return fileCompare(ctx, params.workspaceId, query.mode, query.path, query.oldPath);
    }
  );
}
