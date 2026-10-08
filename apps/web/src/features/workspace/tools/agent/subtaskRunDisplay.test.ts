import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsedDuration } from "./subtaskRunDisplay.js";

test("formatElapsedDuration 拒绝负数和非有限值", () => {
  assert.equal(formatElapsedDuration(-1), "");
  assert.equal(formatElapsedDuration(Number.NaN), "");
  assert.equal(formatElapsedDuration(Number.POSITIVE_INFINITY), "");
});

test("formatElapsedDuration 覆盖零、秒、分钟与小时", () => {
  assert.equal(formatElapsedDuration(0), "0s");
  assert.equal(formatElapsedDuration(999), "0s");
  assert.equal(formatElapsedDuration(1_000), "1s");
  assert.equal(formatElapsedDuration(61_999), "1min 1s");
  assert.equal(formatElapsedDuration(3_661_000), "1h 1min 1s");
});
