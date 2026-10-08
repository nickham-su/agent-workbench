import assert from "node:assert/strict";
import test from "node:test";
import { computeRetryBackoffMs, normalizeRetryBackoffMaxMs } from "./runner.js";

test("computeRetryBackoffMs 默认保持 60 秒上限", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => computeRetryBackoffMs(attempt)),
    [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
  );
});

test("computeRetryBackoffMs 支持超过 60 秒的配置上限", () => {
  assert.equal(computeRetryBackoffMs(5, 120_000), 64_000);
  assert.equal(computeRetryBackoffMs(6, 120_000), 120_000);
  assert.equal(computeRetryBackoffMs(7, 120_000), 120_000);
});

test("computeRetryBackoffMs 尊重较小配置上限但不低于基础退避", () => {
  assert.equal(computeRetryBackoffMs(0, 2_000), 2_000);
  assert.equal(computeRetryBackoffMs(1, 2_000), 2_000);
  assert.equal(computeRetryBackoffMs(0, 1_000), 2_000);
});

test("normalizeRetryBackoffMaxMs 对缺失和非法 profile 使用默认值", () => {
  assert.equal(normalizeRetryBackoffMaxMs(undefined), 60_000);
  assert.equal(normalizeRetryBackoffMaxMs(null), 60_000);
  assert.equal(normalizeRetryBackoffMaxMs("120000"), 60_000);
  assert.equal(normalizeRetryBackoffMaxMs(12_345.6), 60_000);
  assert.equal(normalizeRetryBackoffMaxMs(Number.NaN), 60_000);
  assert.equal(normalizeRetryBackoffMaxMs(Number.POSITIVE_INFINITY), 60_000);
  assert.equal(normalizeRetryBackoffMaxMs(1_000), 2_000);
  assert.equal(normalizeRetryBackoffMaxMs(4_000_000), 3_600_000);
});

test("computeRetryBackoffMs 对非法重试序号保持基础退避", () => {
  assert.equal(computeRetryBackoffMs(-1, 120_000), 2_000);
  assert.equal(computeRetryBackoffMs(Number.NaN, 120_000), 2_000);
});
