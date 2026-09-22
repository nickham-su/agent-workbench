import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentMessageTimestamp } from "./agentMessageMetadata.js";

test("formatAgentMessageTimestamp：今天只展示时分秒", () => {
  const now = new Date(2025, 2, 15, 18, 0, 0).getTime();
  const timestamp = new Date(2025, 2, 15, 9, 8, 7).getTime();
  assert.equal(formatAgentMessageTimestamp(timestamp, now), "09:08:07");
});

test("formatAgentMessageTimestamp：非今天补充月-日", () => {
  const now = new Date(2025, 2, 15, 18, 0, 0).getTime();
  const timestamp = new Date(2025, 1, 3, 9, 8, 7).getTime();
  assert.equal(formatAgentMessageTimestamp(timestamp, now), "02-03 09:08:07");
});

test("formatAgentMessageTimestamp：拒绝无效时间", () => {
  assert.equal(formatAgentMessageTimestamp(Number.NaN), "");
  assert.equal(formatAgentMessageTimestamp(0, Number.POSITIVE_INFINITY), "");
});
