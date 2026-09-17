import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApplyPatchDisplay,
  parseSubtaskDisplay,
  parseSubtaskSessionId,
  parseTodoDisplay,
  parseWriteDisplay,
} from "./agentToolExecutionDisplay.js";

test("富卡只接受 detail structuredResult 的结构化字段", () => {
  assert.deepEqual(
    parseTodoDisplay({
      goal: "迁移",
      todos: [{ content: "实现", status: "in_progress" }],
    })?.summary,
    {
      total: 1,
      pending: 0,
      inProgress: 1,
      completed: 0,
      cancelled: 0,
    },
  );
  assert.equal(
    parseApplyPatchDisplay({
      summary: { fileCount: 1 },
      files: [{ path: "a.ts", type: "add", additions: 2, deletions: 0 }],
    })?.files[0]?.path,
    "a.ts",
  );
  assert.equal(
    parseWriteDisplay({ filePath: "a.ts", summary: { bytesWritten: 4 } })
      ?.bytesWritten,
    4,
  );
});

test("子任务只使用 explicit structuredResult.subtaskSessionId，不从任意文本推断", () => {
  assert.equal(
    parseSubtaskSessionId({ subtaskSessionId: "sess_child" }),
    "sess_child",
  );
  assert.equal(parseSubtaskSessionId({ sessionId: "sess_wrong" }), null);
  assert.equal(parseSubtaskSessionId("subtaskSessionId=sess_wrong"), null);
});

test("子任务卡仅组合 ToolCall input、执行状态与 structuredResult", () => {
  assert.deepEqual(
    parseSubtaskDisplay(
      {
        description: "检查实现",
        agent: "reviewer",
        mode: "legacy",
        session: { mode: "read-only" },
      },
      { subtaskSessionId: "child", resultText: "已完成" },
    ),
    {
      description: "检查实现",
      agent: "reviewer",
      mode: "read-only",
      subtaskSessionId: "child",
      resultText: "已完成",
    },
  );
  assert.equal(
    parseSubtaskDisplay(
      { description: "x" },
      { resultPreview: "session=wrong" },
    ).subtaskSessionId,
    null,
  );
});

test("子任务 mode 在 session.mode 缺失时才兼容顶层 mode", () => {
  assert.equal(
    parseSubtaskDisplay({ session: { mode: "delegated" }, mode: "legacy" }, {})
      .mode,
    "delegated",
  );
  assert.equal(parseSubtaskDisplay({ mode: "legacy" }, {}).mode, "legacy");
});
