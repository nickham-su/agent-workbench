import assert from "node:assert/strict";
import test from "node:test";
import {
  beginContextLimitRecovery,
  completeContextLimitRecovery,
  isStandardBusinessNoProgress,
  nextContextLimitRecoveryMode,
  type ContextLimitRecoveryState,
} from "./recovery-state.js";

const states: ContextLimitRecoveryState[] = ["none", "standard_committed", "full_attempted", "full_committed"];

test("context-limit recovery state machine selects exactly one legal next compaction mode", () => {
  assert.deepEqual(states.map(nextContextLimitRecoveryMode), ["recovery-standard", "recovery-full", null, null]);
  assert.equal(beginContextLimitRecovery("standard_committed", "recovery-full"), "full_attempted");
  assert.equal(completeContextLimitRecovery("recovery-standard"), "standard_committed");
  assert.equal(completeContextLimitRecovery("recovery-full"), "full_committed");
});

test("only non-media standard business no-progress admits immediate full recovery", () => {
  for (const reason of ["no_prefix", "no_progress", "oversized_tail"] as const) {
    assert.equal(isStandardBusinessNoProgress({ kind: "skipped", reason }), true);
  }
  assert.equal(isStandardBusinessNoProgress({ kind: "skipped", reason: "cas_conflict" }), false);
  assert.equal(isStandardBusinessNoProgress({ kind: "summary_input_limit" }), false);
  assert.equal(isStandardBusinessNoProgress({ kind: "media_requires_resend" }), false);
  assert.equal(isStandardBusinessNoProgress({ kind: "unavailable", reason: "transient" }), false);
  assert.equal(isStandardBusinessNoProgress({ kind: "failed", reason: "control" }), false);
});
