import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContextItemRecord } from "@agent-workbench/shared";
import {
  formatElapsedDuration,
  formatSubtaskDuration,
  formatSubtaskStartedAt,
  hasSubtaskRunChanged,
  resolveSubtaskDisplayStatus,
  subtaskRunForDisplay,
  upsertAgentContextItem
} from "./subtaskRunDisplay";

function contextItem(overrides: Partial<AgentContextItemRecord> = {}): AgentContextItemRecord {
  return {
    id: 1,
    workspaceId: "workspace_1",
    sessionId: "session_1",
    runId: "parent_run_1",
    turnId: null,
    step: 1,
    prevId: null,
    kind: "tool",
    status: "running",
    archiveAt: null,
    boundaryReason: null,
    output: {
      type: "tool",
      toolName: "subtask",
      args: { description: "test" }
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

const runningSubtaskRun = {
  runId: "child_run_1",
  status: "running" as const,
  startedAt: 100,
  endedAt: null,
  durationMs: null
};

test("formatElapsedDuration 保持会话头部的时长格式", () => {
  assert.equal(formatElapsedDuration(0), "0s");
  assert.equal(formatElapsedDuration(12_999), "12s");
  assert.equal(formatElapsedDuration(3 * 60_000 + 8_999), "3min 8s");
  assert.equal(formatElapsedDuration(2 * 3_600_000 + 5 * 60_000 + 9_000), "2h 5min 9s");
  assert.equal(formatElapsedDuration(-1), "");
  assert.equal(formatElapsedDuration(Number.NaN), "");
});

test("formatSubtaskDuration 对非法终态时长降级为空文本", () => {
  assert.equal(formatSubtaskDuration(null), "");
  assert.equal(formatSubtaskDuration(-1), "");
  assert.equal(formatSubtaskDuration(Number.NaN), "");
  assert.equal(formatSubtaskDuration(0), "0s");
});

test("formatSubtaskStartedAt 对展示时区中的今天只显示小时和分钟", () => {
  assert.equal(
    formatSubtaskStartedAt(Date.UTC(2026, 2, 12, 14, 5, 8), {
      timeZone: "UTC",
      now: Date.UTC(2026, 2, 12, 23, 59, 59)
    }),
    "14:05"
  );
});

test("formatSubtaskStartedAt 对非今天的开始时间显示月日和小时分钟", () => {
  assert.equal(
    formatSubtaskStartedAt(Date.UTC(2026, 0, 2, 4, 5, 8), {
      timeZone: "UTC",
      now: Date.UTC(2026, 0, 3, 0, 0, 0)
    }),
    "01-02 04:05"
  );
});

test("formatSubtaskStartedAt 在展示时区中跨午夜判断今天，并处理夏令时", () => {
  const startedAt = Date.UTC(2026, 2, 13, 0, 5, 0);
  const now = Date.UTC(2026, 2, 12, 23, 55, 0);

  assert.equal(
    formatSubtaskStartedAt(startedAt, { timeZone: "UTC", now }),
    "03-13 00:05"
  );
  assert.equal(
    formatSubtaskStartedAt(startedAt, { timeZone: "America/Los_Angeles", now }),
    "17:05"
  );
  assert.equal(
    formatSubtaskStartedAt(Date.UTC(2026, 2, 8, 10, 5, 0), {
      timeZone: "America/Los_Angeles",
      now: Date.UTC(2026, 2, 8, 10, 30, 0)
    }),
    "03:05"
  );
});

test("formatSubtaskStartedAt 对非今天的月日时分补零", () => {
  assert.equal(
    formatSubtaskStartedAt(Date.UTC(2026, 0, 2, 4, 5, 0), {
      timeZone: "UTC",
      now: Date.UTC(2026, 1, 1, 0, 0, 0)
    }),
    "01-02 04:05"
  );
});

test("formatSubtaskStartedAt 对无效 now 安全按非今天格式展示", () => {
  assert.equal(
    formatSubtaskStartedAt(Date.UTC(2026, 2, 12, 14, 5, 0), {
      timeZone: "UTC",
      now: Number.NaN
    }),
    "03-12 14:05"
  );
});

test("formatSubtaskStartedAt 对无效开始时间或时区返回空文本", () => {
  assert.equal(formatSubtaskStartedAt(0, { timeZone: "UTC" }), "");
  assert.equal(formatSubtaskStartedAt(-1, { timeZone: "UTC" }), "");
  assert.equal(formatSubtaskStartedAt(Number.NaN, { timeZone: "UTC" }), "");
  assert.equal(
    formatSubtaskStartedAt(Date.UTC(2026, 2, 12, 14, 5, 0), {
      timeZone: "Invalid/Time_Zone",
      now: Date.UTC(2026, 2, 12, 15, 0, 0)
    }),
    ""
  );
});

test("resolveSubtaskDisplayStatus 优先使用 child run 状态并在缺失时回退父 item", () => {
  assert.equal(
    resolveSubtaskDisplayStatus("running", {
      runId: "run_completed",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1
    }),
    "completed"
  );
  assert.equal(
    resolveSubtaskDisplayStatus("failed", {
      runId: "run_running",
      status: "running",
      startedAt: 1,
      endedAt: null,
      durationMs: null
    }),
    "running"
  );
  assert.equal(resolveSubtaskDisplayStatus("cancelled"), "cancelled");
});

test("subtaskRunForDisplay 仅向 subtask DisplayItem 透传 API 摘要", () => {
  const subtask = contextItem({ subtaskRun: runningSubtaskRun });
  assert.deepEqual(subtaskRunForDisplay(subtask), runningSubtaskRun);

  const nonSubtask = contextItem({
    output: { type: "tool", toolName: "bash", args: { command: "pwd" } },
    subtaskRun: runningSubtaskRun
  });
  assert.equal(subtaskRunForDisplay(nonSubtask), undefined);
});

test("hasSubtaskRunChanged 识别 running 到 terminal 和仅 durationMs 的变化", () => {
  const terminal = {
    runId: "child_run_1",
    status: "completed" as const,
    startedAt: 100,
    endedAt: 200,
    durationMs: 100
  };
  assert.equal(hasSubtaskRunChanged(runningSubtaskRun, terminal), true);
  assert.equal(hasSubtaskRunChanged(terminal, { ...terminal, durationMs: 101 }), true);
  assert.equal(hasSubtaskRunChanged(terminal, { ...terminal }), false);
});

test("upsertAgentContextItem 整体替换同一 item 并保留最新 subtaskRun", () => {
  const original = contextItem({ subtaskRun: runningSubtaskRun });
  const terminal = {
    runId: "child_run_1",
    status: "cancelled" as const,
    startedAt: 100,
    endedAt: 300,
    durationMs: 200
  };
  const replacement = contextItem({
    status: "completed",
    updatedAt: 2,
    subtaskRun: terminal
  });
  const upserted = upsertAgentContextItem([original], replacement);

  assert.equal(upserted.length, 1);
  assert.equal(upserted[0], replacement);
  assert.deepEqual(upserted[0]?.subtaskRun, terminal);
});
