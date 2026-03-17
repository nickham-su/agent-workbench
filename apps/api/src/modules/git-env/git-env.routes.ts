import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import { cleanupGitEnvLease, prepareGitEnvLeaseForBash } from "./git-env.service.js";

function assertInternalToken(req: FastifyRequest, ctx: AppContext) {
  const token = String(req.headers["x-awb-agent-internal-token"] || "");
  if (token !== ctx.agentInternalToken) {
    throw new HttpError(401, "Unauthorized");
  }
}

const GitEnvPrepareRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  purpose: Type.Optional(Type.String({ minLength: 1 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 }))
});

const GitEnvPrepareResponseSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    kind: Type.Union([Type.Literal("https"), Type.Literal("ssh"), Type.Literal("none")]),
    env: Type.Record(Type.String(), Type.String()),
    leaseId: Type.Union([Type.String(), Type.Null()]),
    expiresAt: Type.Union([Type.String(), Type.Null()])
  }),
  Type.Object({
    ok: Type.Literal(false),
    errorCode: Type.String(),
    error: Type.String()
  })
]);

const GitEnvCleanupRequestSchema = Type.Object({
  leaseId: Type.String({ minLength: 1 })
});

const GitEnvCleanupResponseSchema = Type.Object({
  ok: Type.Literal(true)
});

export async function registerGitEnvRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/internal/git-env/prepare",
    {
      schema: {
        tags: ["agent"],
        body: GitEnvPrepareRequestSchema,
        response: {
          200: GitEnvPrepareResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, ctx);
      const body = req.body as { workspaceId: string; cwd: string; purpose?: string; timeoutMs?: number };
      const timeoutMsRaw = body.timeoutMs;
      const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? Math.floor(timeoutMsRaw) : undefined;
      return await prepareGitEnvLeaseForBash({
        ctx,
        workspaceId: String(body.workspaceId || "").trim(),
        cwd: String(body.cwd || "").trim(),
        purpose: typeof body.purpose === "string" ? body.purpose : undefined,
        timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined
      });
    }
  );

  app.post(
    "/api/internal/git-env/cleanup",
    {
      schema: {
        tags: ["agent"],
        body: GitEnvCleanupRequestSchema,
        response: { 200: GitEnvCleanupResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema }
      }
    },
    async (req) => {
      assertInternalToken(req, ctx);
      const body = req.body as { leaseId: string };
      const leaseId = String(body.leaseId || "").trim();
      if (!leaseId) throw new HttpError(400, "leaseId is required", "LEASE_ID_REQUIRED");
      await cleanupGitEnvLease({ ctx, leaseId });
      return { ok: true };
    }
  );
}
