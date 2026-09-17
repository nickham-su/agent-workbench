import assert from "node:assert/strict";
import test from "node:test";
import { createAgentMessageMutationState } from "./agentMessageMutationState";
import { runAgentSessionMessageMutation } from "./agentMessageMutationAction";

test("Revert/Compact structural snapshot 达到重试上限后，实际 mutation 编排释放 pending", async () => {
  const state = createAgentMessageMutationState();
  const errors: unknown[] = [];
  for (const sessionId of ["revert-session", "compact-session"]) {
    const accepted = await runAgentSessionMessageMutation({
      state,
      sessionId,
      // Revert 与 Compact 均在结构刷新 reject 后通过 finally 释放自身 pending。
      mutate: async () => { throw new Error("structural snapshot retry exhausted"); },
      onError: (error) => errors.push(error),
    });
    assert.equal(accepted, false);
    assert.equal(state.isPending(sessionId), false);
  }
  assert.equal(errors.length, 2);
  assert.equal(state.begin("session-a"), true);
});
