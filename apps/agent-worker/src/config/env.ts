export type WorkerEnv = {
  host: string;
  port: number;
  socketPath: string | null;
  apiOrigin: string;
  internalToken: string;
  responseValidation: "strict" | "warn";
  concurrency: number;
  pidFilePath: string | null;
};

function parsePositiveInt(raw: string, name: string) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

export function loadWorkerEnv(processEnv: NodeJS.ProcessEnv): WorkerEnv {
  const host = (processEnv.AWB_AGENT_WORKER_HOST || "127.0.0.1").trim();
  const port = parsePositiveInt((processEnv.AWB_AGENT_WORKER_PORT || "4312").trim(), "AWB_AGENT_WORKER_PORT");
  const socketPathRaw = (processEnv.AWB_AGENT_WORKER_SOCKET || "").trim();
  const apiOrigin = (processEnv.AWB_AGENT_API_ORIGIN || "http://127.0.0.1:4310").trim();
  const internalToken = (processEnv.AWB_AGENT_INTERNAL_TOKEN || "").trim();
  if (!internalToken) {
    throw new Error("AWB_AGENT_INTERNAL_TOKEN is required");
  }
  const responseValidation = (processEnv.AWB_INTERNAL_RPC_RESPONSE_VALIDATION || "strict").trim().toLowerCase();
  if (responseValidation !== "strict" && responseValidation !== "warn") {
    throw new Error(
      `Invalid AWB_INTERNAL_RPC_RESPONSE_VALIDATION: ${responseValidation}. Expected "strict" or "warn".`
    );
  }
  const concurrency = parsePositiveInt(
    (processEnv.AWB_AGENT_WORKER_CONCURRENCY || "2").trim(),
    "AWB_AGENT_WORKER_CONCURRENCY"
  );
  const pidFileRaw = (processEnv.AWB_AGENT_WORKER_PID_FILE || "").trim();

  return {
    host,
    port,
    socketPath: socketPathRaw || null,
    apiOrigin,
    internalToken,
    responseValidation,
    concurrency,
    pidFilePath: pidFileRaw || null
  };
}
