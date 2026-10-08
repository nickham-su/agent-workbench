import { ApiError } from "@/shared/api";

export type PendingAgentCompactAttempt = {
  fingerprint: string;
  clientRequestId: string;
};

/**
 * `/compact` 的请求结果未知时保留同一 clientRequestId；只有命令上下文改变后
 * 才生成新 ID，避免 response-loss retry 重复调度压缩。
 */
export function createAgentCompactAttemptFingerprint(input: {
  sessionId: string;
  workspaceId: string;
  agentId?: string;
  locale?: string;
}) {
  return JSON.stringify({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId ?? "",
    locale: input.locale ?? "",
  });
}

export function resolveAgentCompactAttempt(input: {
  attempt: PendingAgentCompactAttempt | null;
  fingerprint: string;
  makeClientRequestId: () => string;
}): PendingAgentCompactAttempt {
  return input.attempt?.fingerprint === input.fingerprint
    ? input.attempt
    : { fingerprint: input.fingerprint, clientRequestId: input.makeClientRequestId() };
}

/**
 * 结果未知（网络、超时、5xx）必须保留 ID；明确的请求前置失败或 worker enqueue
 * 拒绝说明本次不会由该 dedup key 创建可继续等待的 Run，允许用户下一次新尝试。
 */
export function shouldClearPendingAgentCompactAttempt(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "AGENT_WORKER_ENQUEUE_REJECTED") return true;
  if (typeof error.status !== "number") return false;
  // 5xx 是结果未知；其余 4xx 由 API 明确拒绝本次前置请求。
  return error.status >= 400 && error.status < 500;
}
