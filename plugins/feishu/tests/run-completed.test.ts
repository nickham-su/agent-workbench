import assert from "node:assert/strict";
import test from "node:test";
import { shouldBroadcastToChat } from "../src/run-events.js";

test("run_map 命中时不应广播 send", () => {
  assert.equal(shouldBroadcastToChat({ policy: "self_only", hasRunMap: true }), false);
  assert.equal(shouldBroadcastToChat({ policy: "session_all", hasRunMap: true }), false);
});

test("session_all 且 run_map 未命中时广播 send", () => {
  assert.equal(shouldBroadcastToChat({ policy: "session_all", hasRunMap: false }), true);
});

test("self_only 且 run_map 未命中时不广播", () => {
  assert.equal(shouldBroadcastToChat({ policy: "self_only", hasRunMap: false }), false);
});
