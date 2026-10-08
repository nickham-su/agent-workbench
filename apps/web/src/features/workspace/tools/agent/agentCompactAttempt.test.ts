import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/shared/api";
import {
  createAgentCompactAttemptFingerprint,
  resolveAgentCompactAttempt,
  shouldClearPendingAgentCompactAttempt,
} from "./agentCompactAttempt";

test("/compact 响应丢失重试复用同一 clientRequestId", () => {
  const fingerprint = createAgentCompactAttemptFingerprint({
    sessionId: "session", workspaceId: "workspace", agentId: "agent", locale: "zh-CN",
  });
  const first = resolveAgentCompactAttempt({
    attempt: null, fingerprint, makeClientRequestId: () => "request-1",
  });
  // 服务端已调度但 response 丢失：pending attempt 未清，下一次点击必须使用同 ID。
  const retry = resolveAgentCompactAttempt({
    attempt: first, fingerprint, makeClientRequestId: () => "request-2",
  });
  assert.equal(retry.clientRequestId, "request-1");
});

test("Session 或命令上下文变化时 /compact 生成新 clientRequestId", () => {
  const first = resolveAgentCompactAttempt({
    attempt: null,
    fingerprint: createAgentCompactAttemptFingerprint({ sessionId: "a", workspaceId: "ws" }),
    makeClientRequestId: () => "request-1",
  });
  const next = resolveAgentCompactAttempt({
    attempt: first,
    fingerprint: createAgentCompactAttemptFingerprint({ sessionId: "b", workspaceId: "ws" }),
    makeClientRequestId: () => "request-2",
  });
  assert.equal(next.clientRequestId, "request-2");
});

test("/compact 未知网络或 5xx 错误保留同一 pending attempt", () => {
  assert.equal(shouldClearPendingAgentCompactAttempt(new Error("network timeout")), false);
  assert.equal(
    shouldClearPendingAgentCompactAttempt(new ApiError({ message: "server error", status: 503 })),
    false,
  );
});

test("/compact worker enqueue 明确拒绝或前置 4xx 后允许新 ID", () => {
  assert.equal(
    shouldClearPendingAgentCompactAttempt(new ApiError({ message: "rejected", status: 400, code: "AGENT_WORKER_ENQUEUE_REJECTED" })),
    true,
  );
  assert.equal(
    shouldClearPendingAgentCompactAttempt(new ApiError({ message: "empty", status: 400, code: "AGENT_COMPACTION_EMPTY" })),
    true,
  );
});
