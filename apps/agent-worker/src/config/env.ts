import path from "node:path";
import { parseAnalyticsProducerGeneration } from "./analytics-generation.js";

export type WorkerEnv = {
  dataDir: string;
  host: string;
  port: number;
  socketPath: string | null;
  apiOrigin: string;
  internalToken: string;
  responseValidation: "strict" | "warn";
  concurrency: number;
  internalRpcTimeoutMs: number;
  pidFilePath: string | null;
  analyticsProducerGeneration?: string;
  runtimeInstanceId?: string;
};

function parsePositiveInt(raw: string, name: string) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

function parseStrictPositiveInt(raw: string, name: string) {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return parsePositiveInt(raw, name);
}

function parseRuntimeInstanceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid AWB_AGENT_RUNTIME_INSTANCE_ID: expected a UUID v4");
  return value;
}

export function loadWorkerEnv(processEnv: NodeJS.ProcessEnv): WorkerEnv {
  const dataDir = path.resolve((processEnv.AWB_DATA_DIR || ".data").trim() || ".data");
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
  const internalRpcTimeoutMs = parseStrictPositiveInt(
    processEnv.AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS?.trim() || "15000",
    "AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS"
  );
  const pidFileRaw = (processEnv.AWB_AGENT_WORKER_PID_FILE || "").trim();

  return {
    dataDir,
    host,
    port,
    socketPath: socketPathRaw || null,
    apiOrigin,
    internalToken,
    responseValidation,
    concurrency,
    internalRpcTimeoutMs,
    runtimeInstanceId: parseRuntimeInstanceId(processEnv.AWB_AGENT_RUNTIME_INSTANCE_ID),
    analyticsProducerGeneration: parseAnalyticsProducerGeneration(processEnv.AWB_AGENT_ANALYTICS_GENERATION),
    pidFilePath: pidFileRaw || null
  };
}
