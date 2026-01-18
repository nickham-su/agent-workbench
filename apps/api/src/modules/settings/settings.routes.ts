import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  ErrorResponseSchema,
  ClearAllGitIdentityResponseSchema,
  GitGlobalIdentitySchema,
  NetworkSettingsSchema,
  ResetKnownHostRequestSchema,
  SearchSettingsSchema,
  SecurityStatusSchema,
  UpdateGitGlobalIdentityRequestSchema,
  UpdateNetworkSettingsRequestSchema,
  UpdateSearchSettingsRequestSchema
} from "@agent-workbench/shared";
import {
  clearAllGitIdentity,
  getGitGlobalIdentity,
  getNetworkSettings,
  getSearchSettings,
  getSecurityStatus,
  resetKnownHost,
  updateGitGlobalIdentity,
  updateNetworkSettings,
  updateSearchSettings
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
    "/api/settings/search",
    {
      schema: {
        tags: ["settings"],
        response: { 200: SearchSettingsSchema }
      }
    },
    async () => getSearchSettings(ctx)
  );

  app.put(
    "/api/settings/search",
    {
      schema: {
        tags: ["settings"],
        body: UpdateSearchSettingsRequestSchema,
        response: { 200: SearchSettingsSchema, 400: ErrorResponseSchema }
      }
    },
    async (req) => updateSearchSettings(ctx, app.log, req.body)
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

  app.get(
    "/api/settings/git/identity",
    {
      schema: {
        tags: ["settings"],
        response: { 200: GitGlobalIdentitySchema }
      }
    },
    async () => getGitGlobalIdentity(ctx)
  );

  app.put(
    "/api/settings/git/identity",
    {
      schema: {
        tags: ["settings"],
        body: UpdateGitGlobalIdentityRequestSchema,
        response: { 200: GitGlobalIdentitySchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => updateGitGlobalIdentity(ctx, app.log, req.body)
  );

  app.post(
    "/api/settings/git/identity/clear-all",
    {
      schema: {
        tags: ["settings"],
        response: { 200: ClearAllGitIdentityResponseSchema }
      }
    },
    async () => clearAllGitIdentity(ctx, app.log)
  );
}
