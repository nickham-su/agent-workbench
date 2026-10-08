import assert from "node:assert/strict";
import test from "node:test";
import { computed, watch } from "vue";
import { createAgentMessageMutationState } from "./agentMessageMutationState";

test("Pane mutation state 以 Vue ref 驱动同 Session 全部控件 disabled", () => {
  const state = createAgentMessageMutationState();
  const currentSessionDisabled = computed(() => state.isPending("session-a"));
  const observed: boolean[] = [];
  const stop = watch(currentSessionDisabled, (value) => observed.push(value), { flush: "sync" });

  assert.equal(currentSessionDisabled.value, false);
  assert.equal(state.begin("session-a"), true);
  assert.equal(currentSessionDisabled.value, true);
  // 同一 Session 的另一条消息的 Revert/Fork 必须被阻止。
  assert.equal(state.begin("session-a"), false);
  // 另一 Session 仍可独立发起 mutation。
  assert.equal(state.begin("session-b"), true);
  state.end("session-a");
  assert.equal(currentSessionDisabled.value, false);
  assert.deepEqual(observed, [true, false]);
  stop();
});
