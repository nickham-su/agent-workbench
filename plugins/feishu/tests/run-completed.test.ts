import assert from "node:assert/strict";
import test from "node:test";
import { shouldBroadcastToChat } from "../src/run-events.js";
import { buildTodoReplyText, formatTodolistExecution, formatTodolistResult } from "../src/index.js";

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

test("formatTodolistResult：completed/pending/in_progress/cancelled 符号映射且符号在描述前", () => {
  const text = formatTodolistResult({
    goal: "验证符号",
    todos: [
      { content: "已完成", status: "completed" },
      { content: "等待", status: "pending" },
      { content: "进行中", status: "in_progress" },
      { content: "取消", status: "cancelled" }
    ]
  });
  assert.equal(text, ["目标：验证符号", "● 已完成", "○ 等待", "▶ 进行中", "× 取消"].join("\n"));
});

test("formatTodolistExecution：优先 ToolExecution structuredResult，缺失时回退 resultPreview", () => {
  const fromStructuredResult = formatTodolistExecution({
    structuredResult: { goal: "g", todos: [{ content: "x", status: "pending" }] },
    resultPreview: "should not use"
  });
  assert.equal(fromStructuredResult, ["目标：g", "○ x"].join("\n"));

  const fromPreview = formatTodolistExecution({
    structuredResult: { unrelated: true },
    resultPreview: "raw preview"
  });
  assert.equal(fromPreview, "raw preview");
  assert.equal(formatTodolistExecution(null), "(empty)");
});

test("buildTodoReplyText：running 时追加提示，非 running 保持不变", () => {
  const base = ["目标：g", "○ x"].join("\n");

  const nonRunning = buildTodoReplyText({ isRunning: false, todolistText: base });
  assert.equal(nonRunning, base);

  const running = buildTodoReplyText({ isRunning: true, todolistText: base });
  assert.equal(
    running,
    ["当前会话正在运行中", base].join("\n")
  );
});

test("buildTodoReplyText：保留原文本首尾空白，仅全空白时兜底 (empty)", () => {
  const baseWithSpaces = "  hi  \n";
  assert.equal(buildTodoReplyText({ isRunning: false, todolistText: baseWithSpaces }), baseWithSpaces);

  const whitespaceOnly = " \n\n  \t";
  assert.equal(buildTodoReplyText({ isRunning: false, todolistText: whitespaceOnly }), "(empty)");
});
