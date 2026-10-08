import assert from "node:assert/strict";
import test from "node:test";
import { registerPendingAgentRun } from "./agentPendingRunRegistration.js";

test("普通文本、multipart 与 manual compaction 均登记正确的 Run kind", () => {
  const registrations: Array<{ workspaceId: string; sessionId: string; runId: string; runKind: string }> = [];
  const pollHints: Array<{ sessionId: string; opts: { immediate: true; warmup: true } }> = [];
  const registrar = { register: (input: { workspaceId: string; sessionId: string; runId: string; runKind: "user" | "manual_compaction" }) => registrations.push(input) };
  const runStatePollHint = {
    bumpPollHint: (sessionId: string, opts: { immediate: true; warmup: true }) => pollHints.push({ sessionId, opts }),
  };
  registerPendingAgentRun(registrar, { workspaceId: "ws", sessionId: "session", runId: "text", runKind: "user" }, runStatePollHint);
  registerPendingAgentRun(registrar, { workspaceId: "ws", sessionId: "session", runId: "multipart", runKind: "user" }, runStatePollHint);
  registerPendingAgentRun(registrar, { workspaceId: "ws", sessionId: "session", runId: "compact", runKind: "manual_compaction" }, runStatePollHint);
  assert.deepEqual(registrations.map((item) => [item.runId, item.runKind]), [
    ["text", "user"], ["multipart", "user"], ["compact", "manual_compaction"],
  ]);
  assert.deepEqual(pollHints, [
    { sessionId: "session", opts: { immediate: true, warmup: true } },
    { sessionId: "session", opts: { immediate: true, warmup: true } },
    { sessionId: "session", opts: { immediate: true, warmup: true } },
  ]);
});

test("未提供 run-state poll hint 时保持兼容", () => {
  const registrations: string[] = [];
  registerPendingAgentRun(
    { register: (input) => registrations.push(input.runId) },
    { workspaceId: "ws", sessionId: "session", runId: "run", runKind: "user" },
  );
  assert.deepEqual(registrations, ["run"]);
});
