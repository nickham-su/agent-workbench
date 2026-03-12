import path from "node:path";

export type PluginHostEnv = {
  dataDir: string;
  socketPath: string;
  internalToken: string;
  apiOrigin: string;
  pidFilePath: string | null;
  repoRoot: string;
};

export function loadPluginHostEnv(processEnv: NodeJS.ProcessEnv): PluginHostEnv {
  const dataDir = processEnv.AWB_DATA_DIR?.trim() || ".data";
  const socketRaw = processEnv.AWB_AGENT_PLUGIN_HOST_SOCKET?.trim() || "";
  const internalToken = processEnv.AWB_AGENT_INTERNAL_TOKEN?.trim() || "";
  const apiOrigin = processEnv.AWB_AGENT_API_ORIGIN?.trim() || "";
  const pidFileRaw = processEnv.AWB_AGENT_PLUGIN_HOST_PID_FILE?.trim() || "";

  if (!internalToken) {
    throw new Error("AWB_AGENT_INTERNAL_TOKEN is required");
  }
  if (!socketRaw) {
    throw new Error("AWB_AGENT_PLUGIN_HOST_SOCKET is required");
  }
  if (!apiOrigin) {
    throw new Error("AWB_AGENT_API_ORIGIN is required");
  }

  const resolvedDataDir = path.resolve(dataDir);
  const socketPath = path.resolve(socketRaw);
  // plugin-host 进程由 API 以 repoRoot 作为 cwd 启动，这里直接使用 process.cwd()。
  const repoRoot = path.resolve(process.cwd());

  return {
    dataDir: resolvedDataDir,
    socketPath,
    internalToken,
    apiOrigin,
    pidFilePath: pidFileRaw ? path.resolve(pidFileRaw) : null,
    repoRoot
  };
}
