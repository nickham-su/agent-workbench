import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  CreateRepoRequestSchema,
  RepoBranchesResponseSchema,
  RepoRecordSchema,
  RepoSyncResponseSchema,
  UpdateRepoRequestSchema
} from "@agent-workbench/shared";
import { deleteRepo, createRepo, getRepoById, listRepoBranches, syncRepo, updateRepo } from "./repo.service.js";
import { listRepos } from "./repo.store.js";

export async function registerReposRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/repos",
    {
      schema: { tags: ["repos"], response: { 200: { type: "array", items: RepoRecordSchema } } }
    },
    async () => listRepos(ctx.db)
  );

  app.post(
    "/api/repos",
    {
      schema: {
        tags: ["repos"],
        body: CreateRepoRequestSchema,
        response: { 201: RepoRecordSchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const body = req.body as { url: string; credentialId?: string | null };
      const repo = await createRepo(ctx, app.log, { url: body.url, credentialId: body.credentialId ?? null });
      return reply.code(201).send(repo);
    }
  );

  app.get(
    "/api/repos/:repoId",
    {
      schema: {
        tags: ["repos"],
        response: { 200: RepoRecordSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { repoId: string };
      return getRepoById(ctx, params.repoId);
    }
  );

  app.patch(
    "/api/repos/:repoId",
    {
      schema: {
        tags: ["repos"],
        body: UpdateRepoRequestSchema,
        response: { 200: RepoRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { repoId: string };
      const body = (req.body ?? {}) as { credentialId?: string | null };
      return updateRepo(ctx, app.log, params.repoId, { credentialId: body.credentialId ?? undefined });
    }
  );

  app.post(
    "/api/repos/:repoId/sync",
    {
      schema: {
        tags: ["repos"],
        response: { 202: RepoSyncResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { repoId: string };
      const res = await syncRepo(ctx, app.log, params.repoId);
      return reply.code(202).send(res);
    }
  );

  app.get(
    "/api/repos/:repoId/branches",
    {
      schema: {
        tags: ["repos"],
        response: { 200: RepoBranchesResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { repoId: string };
      return listRepoBranches(ctx, params.repoId);
    }
  );

  app.delete(
    "/api/repos/:repoId",
    {
      schema: {
        tags: ["repos"],
        response: { 204: { type: "null" }, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { repoId: string };
      await deleteRepo(ctx, params.repoId);
      return reply.code(204).send();
    }
  );
}
