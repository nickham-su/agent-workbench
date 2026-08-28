import path from "node:path";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const PREVIEW_BOOTSTRAP_TTL_MS = 60_000;

export const APP_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type AppLogLevel = typeof APP_LOG_LEVELS[number];

export type PreviewConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      origin: string;
      originUrl: URL;
      host: string;
      port: number;
      sessionTtlMs: number;
      bootstrapTtlMs: typeof PREVIEW_BOOTSTRAP_TTL_MS;
    }>;

export type Env = {
  dataDir: string;
  host: string;
  port: number;
  fileMaxBytes: number;
  logLevel: AppLogLevel;
  serveWeb: boolean;
  webDistDir: string | null;
  authToken: string | null;
  authCookieSecure: boolean;
  agentWorkerEnabled: boolean;
  agentWorkerHost: string;
  agentWorkerPort: number;
  agentWorkerSocketPath: string;
  agentWorkerConcurrency: number;
  agentInternalToken: string;
  agentWorkerResponseValidation: "strict" | "warn";
  agentApiOrigin: string;
  agentStartupRecoveryMode: "fail" | "recover";
  agentPluginHostEnabled: boolean;
  agentPluginHostSocketPath: string;
  agentPluginServicesEnabled: boolean;
  preview: PreviewConfig;
};

function parsePositiveInt(raw: string, name: string) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseBool(raw: string, fallback: boolean) {
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseLogLevel(raw: string) {
  const level = raw.trim().toLowerCase() || "info";
  if (!(APP_LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(
      `Invalid AWB_LOG_LEVEL: ${level}. Expected one of: ${APP_LOG_LEVELS.join(", ")}.`
    );
  }
  return level as AppLogLevel;
}

function normalizeApiOriginHost(host: string) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

function parsePreviewPort(raw: string) {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid AWB_PREVIEW_PORT: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid AWB_PREVIEW_PORT: ${raw}`);
  }
  return value;
}

function parsePreviewSessionTtlSeconds(raw: string) {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid AWB_PREVIEW_SESSION_TTL_SECONDS: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60 || value > 86_400) {
    throw new Error(`Invalid AWB_PREVIEW_SESSION_TTL_SECONDS: ${raw}`);
  }
  return value;
}

function parsePreviewHost(raw: string) {
  const host = raw.trim();
  if (!host) throw new Error(`Invalid AWB_PREVIEW_HOST: ${raw}`);

  const ipVersion = isIP(host);
  const urlHost = ipVersion === 6 ? `[${host}]` : host;
  let parsed: URL;
  try {
    parsed = new URL(`http://${urlHost}`);
  } catch {
    throw new Error(`Invalid AWB_PREVIEW_HOST: ${raw}`);
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Invalid AWB_PREVIEW_HOST: ${raw}`);
  }
  return host;
}

function parsePreviewOrigin(raw: string, mainOrigin: string) {
  if (!raw) throw new Error("Invalid AWB_PREVIEW_ORIGIN: value is required when preview is enabled");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid AWB_PREVIEW_ORIGIN: ${raw}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid AWB_PREVIEW_ORIGIN: ${raw}`);
  }
  if (url.origin === mainOrigin) {
    throw new Error("Invalid AWB_PREVIEW_ORIGIN: preview origin must differ from the main origin");
  }
  return { origin: url.origin, originUrl: url };
}

export function loadEnv(processEnv: NodeJS.ProcessEnv): Env {
  // 注意: 本项目统一使用 AWB_* 前缀,避免污染用户工作区终端里的常见变量名(PORT/HOST/NODE_ENV 等)。
  const dataDir = processEnv.AWB_DATA_DIR?.trim() || ".data";
  const host = processEnv.AWB_HOST?.trim() || "127.0.0.1";
  const portRaw = processEnv.AWB_PORT?.trim() || "4310";
  const fileMaxBytesRaw = processEnv.AWB_FILE_MAX_BYTES?.trim() || "1048576";
  const logLevelRaw = processEnv.AWB_LOG_LEVEL || "";
  const serveWebRaw = processEnv.AWB_SERVE_WEB?.trim() || "";
  const webDistDirRaw = processEnv.AWB_WEB_DIST_DIR?.trim() || "";
  const authTokenRaw = processEnv.AWB_AUTH_TOKEN?.trim() || "";
  const authCookieSecureRaw = processEnv.AWB_AUTH_COOKIE_SECURE?.trim() || "";
  const workerEnabledRaw = processEnv.AWB_AGENT_WORKER_ENABLED?.trim() || "";
  const workerHost = processEnv.AWB_AGENT_WORKER_HOST?.trim() || "127.0.0.1";
  const workerPortRaw = processEnv.AWB_AGENT_WORKER_PORT?.trim() || "4312";
  const workerSocketRaw = processEnv.AWB_AGENT_WORKER_SOCKET?.trim() || "";
  const workerConcurrencyRaw = processEnv.AWB_AGENT_WORKER_CONCURRENCY?.trim() || "2";
  const internalTokenRaw = processEnv.AWB_AGENT_INTERNAL_TOKEN?.trim() || "";
  const responseValidationRaw = processEnv.AWB_INTERNAL_RPC_RESPONSE_VALIDATION?.trim().toLowerCase() || "strict";
  const apiOriginRaw = processEnv.AWB_AGENT_API_ORIGIN?.trim() || "";
  const startupRecoveryModeRaw = processEnv.AWB_AGENT_STARTUP_RECOVERY_MODE?.trim() || "";
  const pluginHostEnabledRaw = processEnv.AWB_AGENT_PLUGIN_HOST_ENABLED?.trim() || "";
  const pluginHostSocketRaw = processEnv.AWB_AGENT_PLUGIN_HOST_SOCKET?.trim() || "";
  const pluginServicesEnabledRaw = processEnv.AWB_AGENT_PLUGIN_SERVICES_ENABLED?.trim() || "";
  const previewEnabledRaw = processEnv.AWB_PREVIEW_ENABLED?.trim() || "";
  const previewOriginRaw = processEnv.AWB_PREVIEW_ORIGIN?.trim() || "";
  const previewHostRaw = processEnv.AWB_PREVIEW_HOST?.trim() || "127.0.0.1";
  const previewPortRaw = processEnv.AWB_PREVIEW_PORT?.trim() || "4311";
  const previewSessionTtlSecondsRaw = processEnv.AWB_PREVIEW_SESSION_TTL_SECONDS?.trim() || "3600";

  const mainPort = parsePositiveInt(portRaw, "AWB_PORT");
  const fileMaxBytes = parsePositiveInt(fileMaxBytesRaw, "AWB_FILE_MAX_BYTES");
  const agentWorkerPort = parsePositiveInt(workerPortRaw, "AWB_AGENT_WORKER_PORT");
  const agentWorkerConcurrency = parsePositiveInt(workerConcurrencyRaw, "AWB_AGENT_WORKER_CONCURRENCY");

  const logLevel = parseLogLevel(logLevelRaw);
  const serveWeb = parseBool(serveWebRaw, false);
  const webDistDir = webDistDirRaw ? path.resolve(webDistDirRaw) : null;
  const authToken = authTokenRaw ? authTokenRaw : null;
  const authCookieSecure = parseBool(authCookieSecureRaw, false);
  const agentWorkerEnabled = parseBool(workerEnabledRaw, true);
  const agentInternalToken = internalTokenRaw || randomBytes(24).toString("hex");
  if (responseValidationRaw !== "strict" && responseValidationRaw !== "warn") {
    throw new Error(
      `Invalid AWB_INTERNAL_RPC_RESPONSE_VALIDATION: ${responseValidationRaw}. Expected "strict" or "warn".`
    );
  }
  const resolvedDataDir = path.resolve(dataDir);
  const agentWorkerSocketPath = path.resolve(workerSocketRaw || path.join(resolvedDataDir, "agent-worker.sock"));
  const agentPluginHostSocketPath = path.resolve(pluginHostSocketRaw || path.join(resolvedDataDir, "agent-plugin-host.sock"));
  const apiHost = normalizeApiOriginHost(host);
  const agentApiOrigin = apiOriginRaw || `http://${apiHost}:${mainPort}`;
  const agentPluginHostEnabled = parseBool(pluginHostEnabledRaw, false);
  const agentPluginServicesEnabled = parseBool(pluginServicesEnabledRaw, false);
  const previewEnabled = parseBool(previewEnabledRaw, false);
  const normalizedMainHost = normalizeApiOriginHost(host);
  const mainOrigin = new URL(`http://${isIP(normalizedMainHost) === 6 ? `[${normalizedMainHost}]` : normalizedMainHost}:${mainPort}`).origin;
  const preview: PreviewConfig = !previewEnabled
    ? { enabled: false }
    : (() => {
        const host = parsePreviewHost(previewHostRaw);
        const port = parsePreviewPort(previewPortRaw);
        if (port === mainPort) throw new Error("Invalid AWB_PREVIEW_PORT: must differ from AWB_PORT");
        const { origin, originUrl } = parsePreviewOrigin(previewOriginRaw, mainOrigin);
        const sessionTtlSeconds = parsePreviewSessionTtlSeconds(previewSessionTtlSecondsRaw);
        return { enabled: true, origin, originUrl, host, port, sessionTtlMs: sessionTtlSeconds * 1000, bootstrapTtlMs: PREVIEW_BOOTSTRAP_TTL_MS };
      })();

  const agentStartupRecoveryMode = (startupRecoveryModeRaw || "fail").toLowerCase();
  if (agentStartupRecoveryMode !== "fail" && agentStartupRecoveryMode !== "recover") {
    throw new Error(
      `Invalid AWB_AGENT_STARTUP_RECOVERY_MODE: ${startupRecoveryModeRaw}. Expected "fail" or "recover".`
    );
  }

  return {
    dataDir: resolvedDataDir,
    host,
    port: mainPort,
    fileMaxBytes,
    logLevel,
    serveWeb,
    webDistDir,
    authToken,
    authCookieSecure,
    agentWorkerEnabled,
    agentWorkerHost: workerHost,
    agentWorkerPort,
    agentWorkerSocketPath,
    agentWorkerConcurrency,
    agentInternalToken,
    agentWorkerResponseValidation: responseValidationRaw,
    agentApiOrigin,
    agentStartupRecoveryMode: agentStartupRecoveryMode as "fail" | "recover",
    agentPluginHostEnabled,
    agentPluginHostSocketPath,
    agentPluginServicesEnabled,
    preview
  };
}
