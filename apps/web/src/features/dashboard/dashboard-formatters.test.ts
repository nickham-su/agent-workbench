import assert from "node:assert/strict";
import test from "node:test";
import { formatComparison, formatDuration, resultReason } from "./dashboard-formatters";

test("比较值严格使用服务端 status、delta 和 kind", () => {
  assert.equal(formatComparison({ status: "previous_zero", kind: null, delta: null }), "previous_zero");
  assert.equal(formatComparison({ status: "not_applicable", kind: null, delta: null }), "not_applicable");
  assert.equal(formatComparison({ status: "available", kind: "percentage_points", delta: 1.2 }), "+1.2pp");
});
test("不可用和 Git partial 原因可供受控 UI 映射", () => {
  assert.equal(resultReason({ status: "partial", partialReason: "repo_not_ready" }), "repo_not_ready");
  assert.equal(resultReason({ status: "unavailable", unavailableReason: "no_ready_repo" }), "no_ready_repo");
  assert.equal(formatDuration(null), "—");
});
