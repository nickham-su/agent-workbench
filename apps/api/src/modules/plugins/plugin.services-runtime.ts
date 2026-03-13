import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { listPluginRuntimeSnapshots } from "./plugin.service.js";
import { AgentPluginHostClient } from "../agent/agent.plugin-host-client.js";

type PluginServiceRuntime = {
  stop: () => Promise<void> | void;
};

type FeishuPluginConfig = {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  domain?: string;
};

type FeishuPluginDefinition = {
  services?: {
    gateway?: {
      start: (params: {
        config: FeishuPluginConfig;
        apiOrigin: string;
        internalToken: string;
        logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
      }) => Promise<PluginServiceRuntime>;
    };
  };
};

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function toRecord(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function resolveFeishuDefinition(moduleExports: unknown): FeishuPluginDefinition | null {
  const record = toRecord(moduleExports);
  if (!record) return null;
  const candidate = (record as any).default ?? (record as any).plugin ?? moduleExports;
  const def = toRecord(candidate);
  if (!def) return null;
  const services = toRecord(def.services);
  if (!services) return null;
  const gateway = toRecord((services as any).gateway);
  if (!gateway) return null;
  const start = (gateway as any).start;
  if (typeof start !== "function") return null;
  return def as any;
}

async function startFeishuGatewayFromSnapshot(app: FastifyInstance, ctx: AppContext, snapshot: any): Promise<PluginServiceRuntime | null> {
  if (!snapshot?.entryPath) return null;
  if (!(await fileExists(snapshot.entryPath))) return null;

  try {
    const moduleUrl = pathToFileURL(snapshot.entryPath).href;
    const moduleExports = await import(moduleUrl);
    const def = resolveFeishuDefinition(moduleExports);
    if (!def?.services?.gateway) return null;

    const config = snapshot.config as FeishuPluginConfig | undefined;
    if (!config?.appId || !config?.appSecret) {
      app.log.warn({ pluginId: snapshot.id }, "plugin services runtime: feishu config missing");
      return null;
    }

    app.log.info({ pluginId: snapshot.id }, "plugin services runtime: starting feishu gateway");
    return await def.services.gateway.start({
      config,
      apiOrigin: ctx.agentApiOrigin,
      internalToken: ctx.agentInternalToken,
      logger: {
        info: (msg) => app.log.info({ pluginId: snapshot.id }, msg),
        warn: (msg) => app.log.warn({ pluginId: snapshot.id }, msg),
        error: (msg) => app.log.error({ pluginId: snapshot.id }, msg)
      }
    });
  } catch (err) {
    app.log.error({ pluginId: snapshot?.id }, `plugin services runtime: failed to start feishu gateway: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function fingerprintFeishuConfig(config: FeishuPluginConfig | undefined): string {
  if (!config) return "";
  return [config.appId || "", config.appSecret || "", config.botOpenId || "", config.domain || ""].join("\n");
}

export async function registerPluginServicesRuntime(app: FastifyInstance, params: { ctx: AppContext }) {
  if (params.ctx.agentPluginServicesEnabled !== true) return;

  const pluginHost = params.ctx.agentPluginHostEnabled
    ? new AgentPluginHostClient({
        pluginHostSocketPath: params.ctx.agentPluginHostSocketPath,
        internalToken: params.ctx.agentInternalToken,
        logger: app.log
      })
    : null;

  let running: PluginServiceRuntime | null = null;
  let runningFingerprint = "";
  let inFlight: Promise<void> | null = null;
  let queued = false;

  async function stopRunning() {
    if (!running) return;
    app.log.info("plugin services runtime: stopping feishu gateway");
    try {
      await running.stop();
    } catch (err) {
      app.log.error(`plugin services runtime: failed to stop feishu gateway: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = null;
      runningFingerprint = "";
    }
  }

  async function reconcileOnce() {
    if (pluginHost) {
      try {
        await pluginHost.reconcileServices();
      } catch (err) {
        // Do not crash API process if plugin-host is unavailable.
        app.log.error({ err }, "plugin services runtime: reconcile via plugin-host failed");
      }
      return;
    }

    const snapshots = await listPluginRuntimeSnapshots(params.ctx);
    const feishu = snapshots.plugins.find((p) => p.id === "feishu");
    const config = (feishu?.config ?? undefined) as FeishuPluginConfig | undefined;
    const hasRequiredConfig = Boolean(config?.appId && config?.appSecret);
    const shouldRun = Boolean(
      feishu &&
        feishu.enabled &&
        feishu.state === "ready" &&
        feishu.manifest?.capabilities?.includes("services") &&
        feishu.manifest?.services?.some((s: any) => s?.name === "gateway") &&
        hasRequiredConfig
    );

    if (!shouldRun) {
      await stopRunning();
      return;
    }

    const fp = fingerprintFeishuConfig(config);
    if (running && runningFingerprint && fp !== runningFingerprint) {
      // Config changed: restart.
      await stopRunning();
    }

    if (running) return;
    running = await startFeishuGatewayFromSnapshot(app, params.ctx, feishu);
    runningFingerprint = fp;
  }

  async function reconcile() {
    if (inFlight) {
      queued = true;
      return;
    }
    queued = false;
    inFlight = (async () => {
      try {
        await reconcileOnce();
      } catch (err) {
        app.log.error(`plugin services runtime: reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
    if (queued) {
      void reconcile();
    }
  }

  // Initial reconcile after app is ready.
  app.addHook("onReady", async () => {
    await reconcile();
  });

  // Reconcile on plugins settings update.
  const bus = (app as any).awbPluginEvents as { on: (event: string, cb: () => void) => void } | undefined;
  bus?.on("awb:plugins:updated", () => {
    void reconcile();
  });

  app.addHook("onClose", async () => {
    if (!pluginHost) await stopRunning();
  });
}
