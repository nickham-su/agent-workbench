import type { FastifyInstance } from "fastify";
import {
  AgentPluginSettingsSchema,
  PluginRuntimeSnapshotsResponseSchema,
  UpdateAgentPluginSettingsRequestSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import { getAgentPluginSettings, listPluginRuntimeSnapshots, updateAgentPluginSettings } from "./plugin.service.js";
import type { AppContext } from "../../app/context.js";

export async function registerPluginRoutes(app: FastifyInstance, params: { ctx: AppContext }) {
  app.get(
    "/api/settings/agent/plugins",
    {
      schema: {
        tags: ["settings"],
        response: { 200: AgentPluginSettingsSchema }
      }
    },
    async () => getAgentPluginSettings(params.ctx)
  );

  app.get(
    "/api/settings/agent/plugins/runtime-snapshots",
    {
      schema: {
        tags: ["settings"],
        response: { 200: PluginRuntimeSnapshotsResponseSchema }
      }
    },
    async () => listPluginRuntimeSnapshots(params.ctx)
  );

  app.put(
    "/api/settings/agent/plugins",
    {
      schema: {
        tags: ["settings"],
        body: UpdateAgentPluginSettingsRequestSchema,
        response: { 200: AgentPluginSettingsSchema, 400: ErrorResponseSchema }
      }
    },
    async (req) => updateAgentPluginSettings(params.ctx, req.body)
  );
}
