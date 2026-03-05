import assert from "node:assert/strict";
import test from "node:test";
import { chunkStartsVisibleOutput } from "./modelRetry.js";

test("chunkStartsVisibleOutput: error chunk 不应阻止重试", () => {
  const available = new Set(["bash", "read", "write"]);
  assert.equal(chunkStartsVisibleOutput({ type: "error", error: "502 Bad Gateway" }, available), false);
});

test("chunkStartsVisibleOutput: 非空 text-delta 视为已开始输出", () => {
  const available = new Set(["bash", "read", "write"]);
  assert.equal(chunkStartsVisibleOutput({ type: "text-delta", text: "hi" }, available), true);
  assert.equal(chunkStartsVisibleOutput({ type: "text-delta", text: "" }, available), false);
});

test("chunkStartsVisibleOutput: 有效 tool-call 视为已开始输出", () => {
  const available = new Set(["bash", "read", "write"]);
  assert.equal(chunkStartsVisibleOutput({ type: "tool-call", toolName: "bash" }, available), true);
  assert.equal(chunkStartsVisibleOutput({ type: "tool-call", toolName: "unknown_tool" }, available), false);
  assert.equal(chunkStartsVisibleOutput({ type: "tool-call", toolName: "" }, available), false);
});
