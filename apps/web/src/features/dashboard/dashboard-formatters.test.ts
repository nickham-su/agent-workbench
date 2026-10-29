import assert from "node:assert/strict";
import test from "node:test";
import { formatChartAxisCount, formatChartDuration, formatComparison, formatCount, formatDuration, formatTokenCount, resultReason } from "./dashboard-formatters";

test("Token 卡片使用 K/M/B 缩写，最多一位小数，零与未知保持原样", () => {
  assert.equal(formatTokenCount(null), "—");
  assert.equal(formatTokenCount(undefined), "—");
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  for (const locale of ["zh-CN", "en-US"]) {
    assert.equal(formatTokenCount(1_000, locale), "1K");
    assert.equal(formatTokenCount(1_250, locale), "1.3K");
    assert.equal(formatTokenCount(1_000_000, locale), "1M");
    assert.equal(formatTokenCount(788_108_165, locale), "788.1M");
    assert.equal(formatTokenCount(3_677_857, locale), "3.7M");
    assert.equal(formatTokenCount(1_000_000_000, locale), "1B");
    assert.equal(formatTokenCount(1_280_000_000, locale), "1.3B");
    assert.equal(formatCount(788_108_165, locale), "788,108,165");
  }
  assert.equal(formatTokenCount(1_250, "de-DE"), "1,3K");
});

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
test("可用性原因可供受控 UI 映射", () => {
  assert.equal(resultReason({ status: "partial", partialReason: "coverage_gap" }), "coverage_gap");
  assert.equal(resultReason({ status: "unavailable", unavailableReason: "domain_unavailable" }), "domain_unavailable");
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
