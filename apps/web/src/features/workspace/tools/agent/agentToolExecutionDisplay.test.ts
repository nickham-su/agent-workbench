import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolExecutionText,
  formatToolInputPreview,
  parseSubtaskDisplay,
  parseSubtaskSessionId,
  parseTodoDisplay,
  toolExecutionStatusTextClass,
} from "./agentToolExecutionDisplay.js";

test("formatToolInputPreview 将参数压成单行并限制长度", () => {
  assert.equal(
    formatToolInputPreview({ command: "printf 'a\\nb'" }),
    '{"command":"printf \'a\\\\nb\'"}',
  );
  assert.equal(formatToolInputPreview({ content: "abcdefgh" }, 10), '{"content…');
});

test("formatToolExecutionText 展示完成、运行和失败耗时", () => {
  const execution = {
    id: "execution",
    callPartId: "call",
    status: "completed",
    resultPreview: null,
    resultTruncated: false,
    error: null,
    updatedRevision: 1,
    startedAt: 1_000,
    completedAt: 3_500,
  } as const;
  assert.equal(formatToolExecutionText(execution, 9_000), "2s");
  assert.equal(
    formatToolExecutionText(
      { ...execution, status: "running", completedAt: null },
      4_500,
    ),
    "running · 3s",
  );
  assert.equal(
    formatToolExecutionText(
      { ...execution, status: "failed", completedAt: 2_000 },
      9_000,
    ),
    "failed · 1s",
  );
});

test("普通工具状态使用浅灰、深灰、蓝色、红色四级配色", () => {
  assert.equal(toolExecutionStatusTextClass("completed"), "text-[color:var(--text-tertiary)]");
  assert.equal(toolExecutionStatusTextClass("queued"), "text-[color:var(--text-secondary)]");
  assert.equal(toolExecutionStatusTextClass("cancelled"), "text-[color:var(--text-secondary)]");
  assert.equal(toolExecutionStatusTextClass("unknown"), "text-[color:var(--text-secondary)]");
  assert.equal(toolExecutionStatusTextClass("running"), "text-blue-500");
  assert.equal(toolExecutionStatusTextClass("failed"), "text-[color:var(--danger-color)]");
});

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
