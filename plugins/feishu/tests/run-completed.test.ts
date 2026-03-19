import assert from "node:assert/strict";
import test from "node:test";
import { shouldBroadcastToChat } from "../src/run-events.js";
import { buildTodoReplyText, findLatestTodolistToolItem, formatTodolistResult, formatTodolistToolOutput } from "../src/index.js";

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

test("formatTodolistToolOutput：优先 result，result 不可用时回退到 text", () => {
  const fromResult = formatTodolistToolOutput({
    type: "tool",
    toolName: "todolist",
    result: { goal: "g", todos: [{ content: "x", status: "pending" }] },
    text: "should not use"
  });
  assert.equal(fromResult, ["目标：g", "○ x"].join("\n"));

  const fromText = formatTodolistToolOutput({
    type: "tool",
    toolName: "todolist",
    // result 缺失 -> 回退 text
    text: "raw text"
  });
  assert.equal(fromText, "raw text");
});

test("findLatestTodolistToolItem：倒序命中最后一条 todolist tool item", () => {
  const items = [
    { kind: "assistant", output: { type: "assistant_text", text: "hi" } },
    { kind: "tool", output: { type: "tool", toolName: "todolist", result: { goal: "g1", todos: [] } } },
    { kind: "tool", output: { type: "tool", toolName: "bash", text: "x" } },
    { kind: "tool", output: { type: "tool", toolName: "todolist", result: { goal: "g2", todos: [{ content: "x", status: "pending" }] } } }
  ];
  const it = findLatestTodolistToolItem(items);
  assert.equal(it?.output?.toolName, "todolist");
  assert.equal(it?.output?.result?.goal, "g2");
});

test("findLatestTodolistToolItem：kind 存在且非 tool 时不应误命中", () => {
  const items = [
    { kind: "assistant", output: { type: "tool", toolName: "todolist", result: { goal: "bad", todos: [] } } },
    { kind: "tool", output: { type: "tool", toolName: "todolist", result: { goal: "ok", todos: [] } } }
  ];
  const it = findLatestTodolistToolItem(items);
  assert.equal(it?.output?.result?.goal, "ok");
});

test("buildTodoReplyText：running 时追加提示，非 running 保持不变", () => {
  const base = ["目标：g", "○ x"].join("\n");

  const nonRunning = buildTodoReplyText({ isRunning: false, todolistText: base });
  assert.equal(nonRunning, base);

  const running = buildTodoReplyText({ isRunning: true, todolistText: base });
  assert.equal(
    running,
    ["当前会话正在运行中，以下为最近一次已记录的 todolist（可能不是最新）", base].join("\n")
  );
});

test("buildTodoReplyText：保留原文本首尾空白，仅全空白时兜底 (empty)", () => {
  const baseWithSpaces = "  hi  \n";
  assert.equal(buildTodoReplyText({ isRunning: false, todolistText: baseWithSpaces }), baseWithSpaces);

  const whitespaceOnly = " \n\n  \t";
  assert.equal(buildTodoReplyText({ isRunning: false, todolistText: whitespaceOnly }), "(empty)");
});
