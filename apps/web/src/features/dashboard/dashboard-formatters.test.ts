import assert from "node:assert/strict";
import test from "node:test";
import { formatChartAxisCount, formatChartDuration, formatComparison, formatDuration, resultReason } from "./dashboard-formatters";

test("比较值严格使用服务端 status、delta 和 kind", () => {
  assert.equal(formatComparison({ status: "previous_zero", kind: null, delta: null }), "previous_zero");
  assert.equal(formatComparison({ status: "not_applicable", kind: null, delta: null }), "not_applicable");
  assert.equal(formatComparison({ status: "available", kind: "percentage_points", delta: 0.1 }), "+10.0pp");
  assert.equal(formatComparison({ status: "available", kind: "percentage_points", delta: -0.125 }), "-12.5pp");
  assert.equal(formatComparison({ status: "available", kind: "percentage_points", delta: 0 }), "+0.0pp");
  assert.equal(formatComparison({ status: "available", kind: "relative", delta: 0.1 }, "en-US"), "+10%");
});
test("短时长卡片保留秒和毫秒，零不与未知混淆，分钟与小时保持原样", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(20), "20ms");
  assert.equal(formatDuration(17_000), "17s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(3_600_000), "1h 0m");
});
test("不可用和 Git partial 原因可供受控 UI 映射", () => {
  assert.equal(resultReason({ status: "partial", partialReason: "repo_not_ready" }), "repo_not_ready");
  assert.equal(resultReason({ status: "unavailable", unavailableReason: "no_ready_repo" }), "no_ready_repo");
  assert.equal(formatDuration(null), "—");
});

test("纵轴缩写大计数，原有完整版计数不变", () => {
  assert.equal(formatChartAxisCount(1_500_000, "en-US"), "1.5M");
  assert.equal(formatChartAxisCount(500_000, "en-US"), "500k");
  assert.equal(formatChartAxisCount(1, "en-US"), "1");
  assert.equal(formatChartAxisCount(9_000_000_000_000_000, "en-US"), "9P");
});

test("短时长纵轴保留毫秒和秒，不误写为 0m", () => {
  assert.equal(formatChartDuration(20, "en-US"), "20ms");
  assert.equal(formatChartDuration(500, "en-US"), "500ms");
  assert.equal(formatChartDuration(1_500, "en-US"), "1.5s");
  assert.equal(formatChartDuration(30_000, "en-US"), "30s");
  assert.equal(formatChartDuration(90_000, "en-US"), "1.5m");
});
