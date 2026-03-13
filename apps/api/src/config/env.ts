import path from "node:path";
import { randomBytes } from "node:crypto";

export type Env = {
  dataDir: string;
  host: string;
  port: number;
  fileMaxBytes: number;
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
  agentApiOrigin: string;
  agentStartupRecoveryMode: "fail" | "recover";
  agentPluginHostEnabled: boolean;
  agentPluginHostSocketPath: string;
  agentPluginServicesEnabled: boolean;
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

function normalizeApiOriginHost(host: string) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

export function loadEnv(processEnv: NodeJS.ProcessEnv): Env {
  // 注意: 本项目统一使用 AWB_* 前缀,避免污染用户工作区终端里的常见变量名(PORT/HOST/NODE_ENV 等)。
  const dataDir = processEnv.AWB_DATA_DIR?.trim() || ".data";
  const host = processEnv.AWB_HOST?.trim() || "127.0.0.1";
  const portRaw = processEnv.AWB_PORT?.trim() || "4310";
  const fileMaxBytesRaw = processEnv.AWB_FILE_MAX_BYTES?.trim() || "1048576";
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
  const apiOriginRaw = processEnv.AWB_AGENT_API_ORIGIN?.trim() || "";
  const startupRecoveryModeRaw = processEnv.AWB_AGENT_STARTUP_RECOVERY_MODE?.trim() || "";
  const pluginHostEnabledRaw = processEnv.AWB_AGENT_PLUGIN_HOST_ENABLED?.trim() || "";
  const pluginHostSocketRaw = processEnv.AWB_AGENT_PLUGIN_HOST_SOCKET?.trim() || "";
  const pluginServicesEnabledRaw = processEnv.AWB_AGENT_PLUGIN_SERVICES_ENABLED?.trim() || "";

  const port = parsePositiveInt(portRaw, "AWB_PORT");
  const fileMaxBytes = parsePositiveInt(fileMaxBytesRaw, "AWB_FILE_MAX_BYTES");
  const agentWorkerPort = parsePositiveInt(workerPortRaw, "AWB_AGENT_WORKER_PORT");
  const agentWorkerConcurrency = parsePositiveInt(workerConcurrencyRaw, "AWB_AGENT_WORKER_CONCURRENCY");

  const serveWeb = parseBool(serveWebRaw, false);
  const webDistDir = webDistDirRaw ? path.resolve(webDistDirRaw) : null;
  const authToken = authTokenRaw ? authTokenRaw : null;
  const authCookieSecure = parseBool(authCookieSecureRaw, false);
  const agentWorkerEnabled = parseBool(workerEnabledRaw, true);
  const agentInternalToken = internalTokenRaw || randomBytes(24).toString("hex");
  const resolvedDataDir = path.resolve(dataDir);
  const agentWorkerSocketPath = path.resolve(workerSocketRaw || path.join(resolvedDataDir, "agent-worker.sock"));
  const agentPluginHostSocketPath = path.resolve(pluginHostSocketRaw || path.join(resolvedDataDir, "agent-plugin-host.sock"));
  const apiHost = normalizeApiOriginHost(host);
  const agentApiOrigin = apiOriginRaw || `http://${apiHost}:${port}`;
  const agentPluginHostEnabled = parseBool(pluginHostEnabledRaw, false);
  const agentPluginServicesEnabled = parseBool(pluginServicesEnabledRaw, false);

  const agentStartupRecoveryMode = (startupRecoveryModeRaw || "fail").toLowerCase();
  if (agentStartupRecoveryMode !== "fail" && agentStartupRecoveryMode !== "recover") {
    throw new Error(
      `Invalid AWB_AGENT_STARTUP_RECOVERY_MODE: ${startupRecoveryModeRaw}. Expected "fail" or "recover".`
    );
  }

  return {
    dataDir: resolvedDataDir,
    host,
    port,
    fileMaxBytes,
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
    agentApiOrigin,
    agentStartupRecoveryMode: agentStartupRecoveryMode as "fail" | "recover",
    agentPluginHostEnabled,
    agentPluginHostSocketPath,
    agentPluginServicesEnabled
  };
}
