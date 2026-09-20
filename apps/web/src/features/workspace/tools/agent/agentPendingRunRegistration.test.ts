import assert from "node:assert/strict";
import test from "node:test";
import { registerPendingAgentRun } from "./agentPendingRunRegistration.js";

test("普通文本、multipart 与 manual compaction 均登记正确的 Run kind", () => {
  const registrations: Array<{ workspaceId: string; sessionId: string; runId: string; runKind: string }> = [];
  const registrar = { register: (input: { workspaceId: string; sessionId: string; runId: string; runKind: "user" | "manual_compaction" }) => registrations.push(input) };
  registerPendingAgentRun(registrar, { workspaceId: "ws", sessionId: "session", runId: "text", runKind: "user" });
  registerPendingAgentRun(registrar, { workspaceId: "ws", sessionId: "session", runId: "multipart", runKind: "user" });
  registerPendingAgentRun(registrar, { workspaceId: "ws", sessionId: "session", runId: "compact", runKind: "manual_compaction" });
  assert.deepEqual(registrations.map((item) => [item.runId, item.runKind]), [
    ["text", "user"], ["multipart", "user"], ["compact", "manual_compaction"],
  ]);
});
