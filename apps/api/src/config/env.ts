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
  const dataDir = processEnv.DATA_DIR?.trim() || ".data";
  const host = processEnv.HOST?.trim() || "127.0.0.1";
  const portRaw = processEnv.PORT?.trim() || processEnv.API_PORT?.trim() || "4310";
  const fileMaxBytesRaw = processEnv.FILE_MAX_BYTES?.trim() || "1048576";
  const serveWebRaw = processEnv.SERVE_WEB?.trim() || "";
  const webDistDirRaw = processEnv.WEB_DIST_DIR?.trim() || "";
  const authTokenRaw = processEnv.AUTH_TOKEN?.trim() || "";
  const authCookieSecureRaw = processEnv.AUTH_COOKIE_SECURE?.trim() || "";

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT/API_PORT: ${portRaw}`);
  }

  const fileMaxBytes = Number.parseInt(fileMaxBytesRaw, 10);
  if (!Number.isFinite(fileMaxBytes) || fileMaxBytes <= 0) {
    throw new Error(`Invalid FILE_MAX_BYTES: ${fileMaxBytesRaw}`);
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
