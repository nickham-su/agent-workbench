import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import { AgentGitToolEndpoints, PrepareRepoGitEnvRequestSchema, PrepareRepoGitEnvResponseSchema,
  ReleaseRepoGitEnvRequestSchema, ReleaseRepoGitEnvResponseSchema,
  type PrepareRepoGitEnvRequest, type ReleaseRepoGitEnvRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { prepareRepoGitEnvLease } from "./git-env.repo-service.js";
import { releaseRepoGitEnvLease } from "./git-env.lease.js";

// Default AJV strips extra fields and coerces values. Git RPCs must reject both.
function gitLeaseValidator({ schema }: { schema: unknown }) {
  return (data: unknown) => Value.Check(schema as TSchema, data)
    ? { value: data }
    : { error: new Error("Invalid Git lease request.") };
}

function assertInternalToken(req: FastifyRequest, ctx: AppContext) {
  const token = String(req.headers["x-awb-agent-internal-token"] || "");
  if (!token || token !== ctx.agentInternalToken) {
    throw new HttpError(401, "Unauthorized");
  }
}

export async function registerGitEnvRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(AgentGitToolEndpoints.prepareRepoGitEnvLease.path, {
    attachValidation: true,
    validatorCompiler: gitLeaseValidator,
    schema: {
      tags: ["agent"], body: PrepareRepoGitEnvRequestSchema,
      response: { 200: PrepareRepoGitEnvResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema },
    },
  }, async (req) => {
    assertInternalToken(req, ctx);
    if (req.validationError) throw new HttpError(400, "Invalid Git environment request.", "GIT_INPUT_INVALID");
    return prepareRepoGitEnvLease({ ctx, request: req.body as PrepareRepoGitEnvRequest });
  });

  app.post(AgentGitToolEndpoints.releaseRepoGitEnvLease.path, {
    attachValidation: true,
    validatorCompiler: gitLeaseValidator,
    schema: {
      tags: ["agent"], body: ReleaseRepoGitEnvRequestSchema,
      response: { 200: ReleaseRepoGitEnvResponseSchema, 400: ErrorResponseSchema,
        401: ErrorResponseSchema, 403: ErrorResponseSchema, 409: ErrorResponseSchema },
    },
  }, async (req) => {
    assertInternalToken(req, ctx);
    if (req.validationError) throw new HttpError(400, "Invalid Git lease release request.", "LEASE_RELEASE_INVALID");
    return releaseRepoGitEnvLease({ dataDir: ctx.dataDir, request: req.body as ReleaseRepoGitEnvRequest });
  });

}
