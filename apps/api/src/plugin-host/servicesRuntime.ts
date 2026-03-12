import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Db } from "../infra/db/db.js";
import { listPluginRuntimeSnapshots } from "../modules/plugins/plugin.service.js";

type PluginServiceRuntime = {
  stop: () => Promise<void> | void;
  // Optional outbound channel operations.
  // For feishu, we need replyText(chatId,messageId,text).
  replyText?: (params: { chatId: string; messageId: string; text: string }) => Promise<void> | void;
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
  const services = toRecord((def as any).services);
  if (!services) return null;
  const gateway = toRecord((services as any).gateway);
  if (!gateway) return null;
  const start = (gateway as any).start;
  if (typeof start !== "function") return null;
  return def as any;
}

function fingerprintFeishuConfig(config: FeishuPluginConfig | undefined): string {
  if (!config) return "";
  // Use a non-reversible hash for internal restart decision.
  // IMPORTANT: never expose fingerprint via RPC responses.
  const raw = [config.appId || "", config.appSecret || "", config.botOpenId || "", config.domain || ""].join("\n");
  return createHash("sha256").update(raw).digest("hex");
}

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createPluginServicesRuntime(params: { db: Db; dataDir: string; apiOrigin: string; internalToken: string; repoRoot: string }) {
  let running: PluginServiceRuntime | null = null;
  let runningFingerprint = "";
  let lastError: { message: string; code?: string } | null = null;

  let inFlight: Promise<void> | null = null;
  let queued = false;

  async function stopRunning() {
    if (!running) return;
    try {
      await running.stop();
    } catch {
      // ignore stop error
    } finally {
      running = null;
      runningFingerprint = "";
    }
  }

  async function startFeishuGatewayFromSnapshot(snapshot: any): Promise<PluginServiceRuntime | null> {
    if (!snapshot?.entryPath) return null;
    if (!(await fileExists(snapshot.entryPath))) return null;

    const moduleUrl = pathToFileURL(snapshot.entryPath).href;
    const moduleExports = await import(moduleUrl);
    const def = resolveFeishuDefinition(moduleExports);
    if (!def?.services?.gateway) return null;

    const config = snapshot.config as FeishuPluginConfig | undefined;
    if (!config?.appId || !config?.appSecret) {
      throw new Error("feishu config missing: appId/appSecret");
    }

    return await def.services.gateway.start({
      config,
      apiOrigin: params.apiOrigin,
      internalToken: params.internalToken,
      logger: {
        info: (msg) => console.log(`[agent-plugin-host][feishu] ${msg}`),
        warn: (msg) => console.warn(`[agent-plugin-host][feishu] ${msg}`),
        error: (msg) => console.error(`[agent-plugin-host][feishu] ${msg}`)
      }
    });
  }

  async function reconcileOnce() {
    const snapshots = await listPluginRuntimeSnapshots({
      db: params.db,
      dataDir: params.dataDir,
      repoRoot: params.repoRoot
    } as any);
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
      await stopRunning();
    }
    if (running) return;

    running = await startFeishuGatewayFromSnapshot(feishu);
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
        lastError = null;
        await reconcileOnce();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = typeof (err as any)?.code === "string" ? String((err as any).code) : undefined;
        lastError = code ? { message, code } : { message };
        await stopRunning();
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
    if (queued) {
      void reconcile();
    }
  }

  return {
    async reconcile(_bodyRaw: unknown) {
      await reconcile();
      return { running: Boolean(running), lastError };
    },
    getStatus() {
      return { running: Boolean(running), lastError };
    },
    async feishuReplyText(input: { chatId: string; messageId: string; text: string }) {
      if (!running || typeof running.replyText !== "function") {
        const err: any = new Error("feishu gateway is not running");
        err.statusCode = 503;
        err.code = "FEISHU_GATEWAY_NOT_RUNNING";
        throw err;
      }
      const chatId = String(input.chatId || "").trim();
      const messageId = String(input.messageId || "").trim();
      let text = typeof input.text === "string" ? input.text : String(input.text ?? "");
      if (!chatId || !messageId) {
        const err: any = new Error("chatId/messageId is required");
        err.statusCode = 400;
        err.code = "FEISHU_REPLY_ARGS_INVALID";
        throw err;
      }

      // Avoid Feishu rejecting overlong text.
      // Keep this limit conservative; upstream callers may also truncate.
      const MAX_CHARS = 6000;
      const suffix = "\n\n（已截断，超过长度限制）";
      if (text.length > MAX_CHARS) {
        const headLen = Math.max(0, MAX_CHARS - suffix.length);
        text = text.slice(0, headLen) + suffix;
      }

      await running.replyText({ chatId, messageId, text });
      return { ok: true } as const;
    },
    async stop() {
      await stopRunning();
    }
  };
}
