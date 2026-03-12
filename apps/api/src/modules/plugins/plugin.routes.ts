import type { FastifyInstance } from "fastify";
import {
  AgentPluginSettingsSchema,
  PluginRuntimeSnapshotsResponseSchema,
  UpdateAgentPluginSettingsRequestSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import { getAgentPluginSettings, listPluginRuntimeSnapshots, updateAgentPluginSettings } from "./plugin.service.js";
import type { AppContext } from "../../app/context.js";

function maskPluginConfigBySensitiveKeys(config: unknown, sensitiveKeys: string[]): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  if (!sensitiveKeys || sensitiveKeys.length === 0) return config;
  const src = config as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  for (const key of sensitiveKeys) {
    if (key in out) {
      const v = out[key];
      if (typeof v === "string" && v.trim()) {
        out[key] = "***";
      }
    }
  }
  return out;
}

async function getSensitiveKeysByPluginId(ctx: AppContext): Promise<Map<string, string[]>> {
  const snapshots = await listPluginRuntimeSnapshots(ctx);
  const map = new Map<string, string[]>();
  for (const p of snapshots.plugins) {
    const keys = p.manifest?.uiHints?.sensitiveKeys ?? [];
    if (keys.length > 0) map.set(p.id, keys);
  }
  return map;
}

export async function registerPluginRoutes(app: FastifyInstance, params: { ctx: AppContext }) {
  app.get(
    "/api/settings/agent/plugins",
    {
      schema: {
        tags: ["settings"],
        response: { 200: AgentPluginSettingsSchema }
      }
    },
    async () => {
      const settings = await getAgentPluginSettings(params.ctx);
      const sensitiveKeysById = await getSensitiveKeysByPluginId(params.ctx);
      return {
        ...settings,
        plugins: settings.plugins.map((item) => {
          const keys = sensitiveKeysById.get(item.id) ?? [];
          if (!item.config || keys.length === 0) return item;
          return {
            ...item,
            config: maskPluginConfigBySensitiveKeys(item.config, keys)
          };
        })
      };
    }
  );

  app.get(
    "/api/settings/agent/plugins/runtime-snapshots",
    {
      schema: {
        tags: ["settings"],
        response: { 200: PluginRuntimeSnapshotsResponseSchema }
      }
    },
    async () => {
      const snapshots = await listPluginRuntimeSnapshots(params.ctx);
      return {
        ...snapshots,
        plugins: snapshots.plugins.map((p) => {
          const keys = p.manifest?.uiHints?.sensitiveKeys ?? [];
          if (!p.config || keys.length === 0) return p;
          return {
            ...p,
            config: maskPluginConfigBySensitiveKeys(p.config, keys)
          };
        })
      };
    }
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
    async (req) => {
      const res = await updateAgentPluginSettings(params.ctx, req.body);
      // Let runtime hook observe plugin enable/disable changes.
      const bus = (app as any).awbPluginEvents as { emit: (event: string, payload: unknown) => void } | undefined;
      bus?.emit("awb:plugins:updated", res);
      return res;
    }
  );
}
