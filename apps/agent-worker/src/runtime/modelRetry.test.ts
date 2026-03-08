import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkStartsVisibleOutput,
  shouldRetryAfterPartialText,
  buildRetryMessages
} from "./modelRetry.js";

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

test("shouldRetryAfterPartialText: 有部分文本且无 tool-call 时允许续写重试", () => {
  assert.equal(shouldRetryAfterPartialText({ text: "半截输出", toolCalls: 0, retryCount: 0, maxRetries: 3 }), true);
});

test("shouldRetryAfterPartialText: 空文本或重试耗尽时不允许", () => {
  assert.equal(shouldRetryAfterPartialText({ text: "   ", toolCalls: 0, retryCount: 0, maxRetries: 3 }), false);
  assert.equal(shouldRetryAfterPartialText({ text: "半截输出", toolCalls: 0, retryCount: 3, maxRetries: 3 }), false);
});

test("shouldRetryAfterPartialText: 含 tool-call 时不允许", () => {
  assert.equal(shouldRetryAfterPartialText({ text: "前缀", toolCalls: 1, retryCount: 0, maxRetries: 3 }), false);
});

test("buildRetryMessages: partial text retry 时会把当前前缀作为 assistant 历史注入", () => {
  const baseMessages = [{ role: "user", content: "hello" } as Record<string, unknown>];
  const next = buildRetryMessages({ baseMessages, text: "半截输出", toolCalls: 0, retryCount: 0, maxRetries: 3 });
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { role: "assistant", content: "半截输出" });

  const unchanged = buildRetryMessages({ baseMessages, text: "半截输出", toolCalls: 1, retryCount: 0, maxRetries: 3 });
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged, baseMessages);
});
