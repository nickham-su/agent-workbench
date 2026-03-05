import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTodolistArgs, toTodolistResult } from "./todolist.js";

test("todolist 允许多个 in_progress 并按顺序保留", () => {
  const parsed = parseTodolistArgs({
    todos: [
      { content: "  设计接口  ", status: "in_progress" },
      { content: "实现核心逻辑", status: "in_progress" },
      { content: "补充测试", status: "pending" },
      { content: "同步文档", status: "completed" }
    ]
  });

  assert.deepEqual(parsed.todos, [
    { content: "设计接口", status: "in_progress" },
    { content: "实现核心逻辑", status: "in_progress" },
    { content: "补充测试", status: "pending" },
    { content: "同步文档", status: "completed" }
  ]);

  const result = toTodolistResult(parsed);
  assert.deepEqual(result.summary, {
    total: 4,
    pending: 1,
    inProgress: 2,
    completed: 1,
    cancelled: 0
  });
});

test("todolist content trim 后不能为空", () => {
  assert.throws(
    () =>
      parseTodolistArgs({
        todos: [{ content: "   ", status: "pending" }]
      }),
    /content must be a non-empty string/
  );
});
