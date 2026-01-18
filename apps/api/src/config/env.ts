import path from "node:path";

export type Env = {
  dataDir: string;
  host: string;
  port: number;
  fileMaxBytes: number;
  serveWeb: boolean;
  webDistDir: string | null;
  authToken: string | null;
  authCookieSecure: boolean;
};

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

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid AWB_PORT: ${portRaw}`);
  }

  const fileMaxBytes = Number.parseInt(fileMaxBytesRaw, 10);
  if (!Number.isFinite(fileMaxBytes) || fileMaxBytes <= 0) {
    throw new Error(`Invalid AWB_FILE_MAX_BYTES: ${fileMaxBytesRaw}`);
  }

  const serveWeb = ["1", "true", "yes", "on"].includes(serveWebRaw.toLowerCase());
  const webDistDir = webDistDirRaw ? path.resolve(webDistDirRaw) : null;
  const authToken = authTokenRaw ? authTokenRaw : null;
  const authCookieSecure = ["1", "true", "yes", "on"].includes(authCookieSecureRaw.toLowerCase());

  return {
    dataDir: path.resolve(dataDir),
    host,
    port,
    fileMaxBytes,
    serveWeb,
    webDistDir,
    authToken,
    authCookieSecure
  };
}
