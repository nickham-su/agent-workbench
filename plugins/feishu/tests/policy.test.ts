import assert from "node:assert/strict";
import test from "node:test";
import { policyLabel, togglePolicyValue } from "../src/policy.js";

test("togglePolicyValue 在 self_only 与 session_all 间循环", () => {
  assert.equal(togglePolicyValue("self_only"), "session_all");
  assert.equal(togglePolicyValue("session_all"), "self_only");
});

test("policyLabel 输出中文策略文案", () => {
  assert.equal(policyLabel("self_only"), "仅飞书触发的消息");
  assert.equal(policyLabel("session_all"), "所有消息");
});
