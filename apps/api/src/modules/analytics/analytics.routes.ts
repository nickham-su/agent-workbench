import type { FastifyInstance, FastifyRequest } from "fastify";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  DashboardQueryErrorResponseSchema,
  DashboardQueryRequestSchema,
  DashboardQuerySuccessResponseSchema,
  AnalyticsProducerSignalSchema,
  AnalyticsSignalResultSchema,
  isCanonicalAnalyticsSignal,
  type AnalyticsSignal,
  type DashboardQueryErrorResponse
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { validateDashboardQueryInput } from "./analytics.service.js";
import type { AnalyticsSupervisor } from "./analytics-supervisor.js";

type ValidatedRequest = FastifyRequest & {
  validationError?: unknown;
};

function safeError(code: DashboardQueryErrorResponse["error"]["code"]): DashboardQueryErrorResponse {
  return { kind: "error", error: { code } };
}

/**
 * Fastify's default AJV configuration removes additional properties. This
 * route-local compiler validates the canonical TypeBox union without mutating
 * the parsed request, keeping runtime and OpenAPI contracts aligned.
 */
function canonicalTypeBoxValidator({ schema }: { schema: unknown }) {
  return (data: unknown) => Value.Check(schema as TSchema, data)
    ? { value: data }
    : { error: new Error("Invalid dashboard query") };
}

/**
 * Stage one intentionally has no analytics transport. Keeping this route
 * isolated ensures future supervisor failures can only affect this endpoint.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext, supervisor: AnalyticsSupervisor | null = null) {
  app.post(
    "/api/analytics/internal/signal",
    {
      attachValidation: true,
      validatorCompiler: canonicalTypeBoxValidator,
      schema: { hide: true, body: AnalyticsProducerSignalSchema, response: { 200: AnalyticsSignalResultSchema, 401: AnalyticsSignalResultSchema } }
    },
    async (request, reply) => {
      if (request.headers["x-awb-agent-internal-token"] !== ctx.agentInternalToken) return reply.code(401).send({ accepted: false, receipt: null });
      const signal = request.body as unknown;
      if ((request as ValidatedRequest).validationError || !isCanonicalAnalyticsSignal(signal) || !supervisor) return { accepted: false, receipt: null };
      return await supervisor.signal(signal as AnalyticsSignal);
    }
  );

  app.post(
    "/api/analytics/dashboard/query",
    {
      attachValidation: true,
      validatorCompiler: canonicalTypeBoxValidator,
      schema: {
        tags: ["analytics"],
        body: DashboardQueryRequestSchema,
        response: {
          200: DashboardQuerySuccessResponseSchema,
          400: DashboardQueryErrorResponseSchema,
          503: DashboardQueryErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      // The route-local compiler preserves the parsed body. Canonical input
      // validation owns the public semantic error codes after the structural
      // discriminated union has been checked without mutation.
      const validated = validateDashboardQueryInput(request.body);
      if (!validated.ok) return reply.code(400).send(safeError(validated.code));
      if ((request as ValidatedRequest).validationError) {
        return reply.code(400).send(safeError("ANALYTICS_RANGE_INVALID"));
      }

      // The API process only validates public request syntax. The child owns
      // the reporting anchor, snapshot timestamp, range ID and SQLite access.
      const response = await supervisor?.query(validated.request) ?? safeError("ANALYTICS_UNAVAILABLE");
      if (response.kind === "error") {
        const status = response.error.code === "ANALYTICS_RANGE_NOT_READY" ? 400 : 503;
        return reply.code(status).send(response);
      }
      // The child validates the Shared response contract. Avoid compiling
      // Fastify's very large success schema on the first user Dashboard hit.
      reply.serializer((value) => JSON.stringify(value));
      return reply.code(200).send(response);
    }
  );
}
