import assert from "node:assert/strict";
import test from "node:test";
import { createAgentArtifactRequestGuard } from "./agentArtifactRequestGuard";

test("artifact 晚到响应在 scope 切换后不可再打开 editor", () => {
  const guard = createAgentArtifactRequestGuard({
    workspaceId: "ws-a", sessionId: "session-a", executionId: "execution-a",
  });
  const request = guard.begin();
  guard.update({ workspaceId: "ws-b", sessionId: "session-b", executionId: "execution-b" });
  assert.equal(request.signal.aborted, true);
  assert.equal(guard.isCurrent(request.scope), false);
});

test("artifact 卡片卸载后 abort 且拒绝晚到响应", () => {
  const guard = createAgentArtifactRequestGuard({
    workspaceId: "ws", sessionId: "session", executionId: "execution",
  });
  const request = guard.begin();
  guard.dispose();
  assert.equal(request.signal.aborted, true);
  assert.equal(guard.isCurrent(request.scope), false);
});
