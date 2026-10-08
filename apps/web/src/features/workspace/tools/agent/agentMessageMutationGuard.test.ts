import assert from "node:assert/strict";
import test from "node:test";
import { createAgentMessageMutationGuard } from "./agentMessageMutationGuard";

test("Fork/Revert 同一 Session 的任何来源消息只允许一个结构 mutation", () => {
  const guard = createAgentMessageMutationGuard();
  assert.equal(guard.begin("session"), true);
  assert.equal(guard.begin("session"), false);
  // 同 Session 不同 message 的 Fork/Revert 也必须互斥。
  assert.equal(guard.isPending("session"), true);
  // 不同 Session 仍可并发。
  assert.equal(guard.begin("another-session"), true);
  guard.end("session");
  assert.equal(guard.begin("session"), true);
});
