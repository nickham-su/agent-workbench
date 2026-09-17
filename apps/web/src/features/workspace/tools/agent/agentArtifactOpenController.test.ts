import assert from "node:assert/strict";
import test from "node:test";
import { runAgentArtifactOpenRequest } from "./agentArtifactOpenController";
import { createAgentArtifactRequestGuard } from "./agentArtifactRequestGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("ApplyPatch 卡片接线：scope 切换后的普通晚到错误静默丢弃", async () => {
  const guard = createAgentArtifactRequestGuard({ workspaceId: "ws-a", sessionId: "s-a", executionId: "e-a" });
  const result = deferred<string>();
  let opened = 0;
  let errors = 0;
  const opening = runAgentArtifactOpenRequest({
    guard,
    fetchArtifact: async () => result.promise,
    onArtifact: () => { opened += 1; },
    onError: () => { errors += 1; },
  });
  guard.update({ workspaceId: "ws-b", sessionId: "s-b", executionId: "e-b" });
  result.reject(new Error("ordinary late error"));
  assert.equal(await opening, false);
  assert.equal(opened, 0);
  assert.equal(errors, 0);
});

test("Write 卡片接线：卸载后的普通晚到错误静默丢弃", async () => {
  const guard = createAgentArtifactRequestGuard({ workspaceId: "ws", sessionId: "s", executionId: "e" });
  const result = deferred<string>();
  let opened = 0;
  let errors = 0;
  const opening = runAgentArtifactOpenRequest({
    guard,
    fetchArtifact: async () => result.promise,
    onArtifact: () => { opened += 1; },
    onError: () => { errors += 1; },
  });
  guard.dispose();
  result.reject(new Error("ordinary late error"));
  assert.equal(await opening, false);
  assert.equal(opened, 0);
  assert.equal(errors, 0);
});

test("current scope 的 artifact 错误仍交由卡片展示", async () => {
  const guard = createAgentArtifactRequestGuard({ workspaceId: "ws", sessionId: "s", executionId: "e" });
  let errors = 0;
  const accepted = await runAgentArtifactOpenRequest({
    guard,
    fetchArtifact: async () => { throw new Error("current error"); },
    onArtifact: () => assert.fail("不应打开编辑器"),
    onError: () => { errors += 1; },
  });
  assert.equal(accepted, false);
  assert.equal(errors, 1);
});
