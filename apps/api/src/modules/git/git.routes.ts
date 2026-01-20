import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  GitChangesRequestSchema,
  ChangesResponseSchema,
  GitFileCompareRequestSchema,
  FileCompareResponseSchema,
  GitBranchesRequestSchema,
  GitBranchesResponseSchema,
  GitCheckoutRequestSchema,
  GitCheckoutResponseSchema,
  GitCommitRequestSchema,
  GitCommitResponseSchema,
  GitDiscardRequestSchema,
  GitIdentitySetRequestSchema,
  GitIdentityStatusRequestSchema,
  GitIdentityStatusSchema,
  GitPullRequestSchema,
  GitPullResponseSchema,
  GitPushRequestSchema,
  GitPushResponseSchema,
  GitStageRequestSchema,
  GitStatusRequestSchema,
  GitStatusResponseSchema,
  GitUnstageRequestSchema
} from "@agent-workbench/shared";
import {
  commitWorkspace,
  discardWorkspace,
  fileCompare,
  getWorkspaceGitIdentity,
  gitBranches,
  gitCheckout,
  gitStatus,
  listChanges,
  pullWorkspace,
  pushWorkspace,
  setWorkspaceGitIdentity,
  stageWorkspace,
  unstageWorkspace
} from "./git.service.js";

export async function registerGitRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/git/changes",
    {
      schema: {
        tags: ["git"],
        body: GitChangesRequestSchema,
        response: { 200: ChangesResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      return listChanges(ctx, req.body);
    }
  );

  app.post(
    "/api/git/stage",
    {
      schema: {
        tags: ["git"],
        body: GitStageRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      await stageWorkspace(ctx, req.body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/git/unstage",
    {
      schema: {
        tags: ["git"],
        body: GitUnstageRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      await unstageWorkspace(ctx, req.body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/git/discard",
    {
      schema: {
        tags: ["git"],
        body: GitDiscardRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      await discardWorkspace(ctx, req.body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/git/commit",
    {
      schema: {
        tags: ["git"],
        body: GitCommitRequestSchema,
        response: { 200: GitCommitResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return commitWorkspace(ctx, req.body);
    }
  );

  app.post(
    "/api/git/identity/status",
    {
      schema: {
        tags: ["git"],
        body: GitIdentityStatusRequestSchema,
        response: { 200: GitIdentityStatusSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      return getWorkspaceGitIdentity(ctx, req.body);
    }
  );

  app.put(
    "/api/git/identity",
    {
      schema: {
        tags: ["git"],
        body: GitIdentitySetRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      await setWorkspaceGitIdentity(ctx, req.body);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/git/push",
    {
      schema: {
        tags: ["git"],
        body: GitPushRequestSchema,
        response: { 200: GitPushResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return pushWorkspace(ctx, req.body);
    }
  );

  app.post(
    "/api/git/pull",
    {
      schema: {
        tags: ["git"],
        body: GitPullRequestSchema,
        response: { 200: GitPullResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return pullWorkspace(ctx, req.body);
    }
  );

  app.post(
    "/api/git/file-compare",
    {
      schema: {
        tags: ["git"],
        body: GitFileCompareRequestSchema,
        response: { 200: FileCompareResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      return fileCompare(ctx, req.body);
    }
  );

  app.post(
    "/api/git/branches",
    {
      schema: {
        tags: ["git"],
        body: GitBranchesRequestSchema,
        response: { 200: GitBranchesResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return gitBranches(ctx, req.body);
    }
  );

  app.post(
    "/api/git/checkout",
    {
      schema: {
        tags: ["git"],
        body: GitCheckoutRequestSchema,
        response: { 200: GitCheckoutResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return gitCheckout(ctx, req.body);
    }
  );

  app.post(
    "/api/git/status",
    {
      schema: {
        tags: ["git"],
        body: GitStatusRequestSchema,
        response: { 200: GitStatusResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      return gitStatus(ctx, req.body);
    }
  );
}
