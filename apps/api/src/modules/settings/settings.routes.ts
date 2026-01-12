import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  ErrorResponseSchema,
  NetworkSettingsSchema,
  ResetKnownHostRequestSchema,
  SecurityStatusSchema,
  UpdateNetworkSettingsRequestSchema
} from "@agent-workbench/shared";
import {
  getNetworkSettings,
  getSecurityStatus,
  resetKnownHost,
  updateNetworkSettings
} from "./settings.service.js";

export async function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/settings/network",
    {
      schema: {
        tags: ["settings"],
        response: { 200: NetworkSettingsSchema }
      }
    },
    async () => getNetworkSettings(ctx)
  );

  app.put(
    "/api/settings/network",
    {
      schema: {
        tags: ["settings"],
        body: UpdateNetworkSettingsRequestSchema,
        response: { 200: NetworkSettingsSchema, 400: ErrorResponseSchema }
      }
    },
    async (req) => updateNetworkSettings(ctx, app.log, req.body)
  );

  app.get(
    "/api/settings/security",
    {
      schema: {
        tags: ["settings"],
        response: { 200: SecurityStatusSchema }
      }
    },
    async () => getSecurityStatus(ctx)
  );

  app.post(
    "/api/settings/security/ssh/known-hosts/reset",
    {
      schema: {
        tags: ["settings"],
        body: ResetKnownHostRequestSchema,
        response: { 204: { type: "null" }, 400: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      await resetKnownHost(ctx, app.log, req.body);
      return reply.code(204).send();
    }
  );
}
