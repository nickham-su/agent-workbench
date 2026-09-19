import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@agent-workbench/shared";
import {
  CANCELLED_TOOL_EXECUTION_RESULT,
  EMPTY_COMPLETED_TOOL_EXECUTION_RESULT,
  FAILED_TOOL_EXECUTION_RESULT,
  RuntimeTranscriptProjector,
  UNKNOWN_TOOL_EXECUTION_RESULT
} from "./runtime-transcript-projector.js";

function message(input: Partial<AgentMessage> & Pick<AgentMessage, "id" | "type" | "status" | "parts">): AgentMessage {
  return {
    workspaceId: "ws", previousMessageId: null, replacesMessageId: null, depth: 0,
    originSessionId: "session", originRunId: "run", updatedRevision: 1, createdAt: 1, updatedAt: 1,
    ...input
  };
}

const projector = new RuntimeTranscriptProjector();

test("RuntimeTranscriptProjector filters reasoning and projects historical images as placeholders", () => {
  const result = projector.project({
    workspaceId: "ws", triggerMessageId: "trigger", executions: [], messages: [
      message({ id: "history", type: "user", status: "completed", parts: [
        { id: "h-text", messageId: "history", position: 0, type: "text", text: "old", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        { id: "h-image", messageId: "history", position: 1, type: "image", attachmentId: "a-old", mediaType: "image/png", filename: "old.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
      ] }),
      message({ id: "assistant", type: "assistant", status: "completed", parts: [
        { id: "reasoning", messageId: "assistant", position: 0, type: "reasoning", text: "private chain", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        { id: "text", messageId: "assistant", position: 1, type: "text", text: "answer", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
      ] }),
      message({ id: "trigger", type: "user", status: "completed", parts: [
        { id: "trigger-image", messageId: "trigger", position: 0, type: "image", attachmentId: "a-new", mediaType: "image/jpeg", filename: "new.jpg", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
      ] })
    ]
  });
  assert.deepEqual(result, [
    { role: "user", content: "old\n\n[This user message included 1 image attachment(s). Their image contents are not included in this run.]" },
    { role: "assistant", content: "answer" },
    { role: "user", content: [
      { type: "text", text: "[The user sent 1 image attachment(s) without accompanying text.]" },
      { type: "attachment_ref", workspaceId: "ws", attachmentId: "a-new", mediaType: "image/jpeg", filename: "new.jpg" }
    ] }
  ]);
});

test("RuntimeTranscriptProjector preserves interleaved visible Text and ToolCall order while omitting Reasoning", () => {
  const result = projector.project({
    workspaceId: "ws",
    triggerMessageId: "user",
    executions: [{ callPartId: "call", status: "completed", resultPreview: "ok", error: null }],
    messages: [
      message({ id: "assistant", type: "assistant", status: "completed", parts: [
        { id: "text-before", messageId: "assistant", position: 0, type: "text", text: "before", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        { id: "reasoning", messageId: "assistant", position: 1, type: "reasoning", text: "private", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        { id: "call", messageId: "assistant", position: 2, type: "tool_call", toolName: "bash", input: { command: "pwd" }, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        { id: "text-after", messageId: "assistant", position: 3, type: "text", text: "after", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      ] }),
      message({ id: "user", type: "user", status: "completed", parts: [] }),
    ],
  });
  assert.deepEqual(result[0], { role: "assistant", content: [
    { type: "text", text: "before" },
    { type: "tool-call", toolCallId: "call", toolName: "bash", input: { command: "pwd" } },
    { type: "text", text: "after" },
  ] });
});

test("RuntimeTranscriptProjector creates exactly one ordered envelope for each terminal ToolCallPart", () => {
  const assistant = message({ id: "assistant", type: "assistant", status: "completed", parts: [
    { id: "call-b", messageId: "assistant", position: 3, type: "tool_call", toolName: "bash", input: { command: "b" }, providerToolCallId: "provider-b", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    { id: "call-a", messageId: "assistant", position: 1, type: "tool_call", toolName: "read", input: { filePath: "a" }, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  const result = projector.project({ workspaceId: "ws", triggerMessageId: null, messages: [assistant], executions: [
    { callPartId: "call-b", status: "completed", resultPreview: null, error: null },
    { callPartId: "call-a", status: "failed", resultPreview: null, error: null }
  ] });
  assert.deepEqual(result, [
    { role: "assistant", content: [
      { type: "tool-call", toolCallId: "call-a", toolName: "read", input: { filePath: "a" } },
      { type: "tool-call", toolCallId: "provider-b", toolName: "bash", input: { command: "b" } }
    ] },
    { role: "tool", content: [
      { type: "tool-result", toolCallId: "call-a", toolName: "read", output: { type: "error-text", value: FAILED_TOOL_EXECUTION_RESULT } },
      { type: "tool-result", toolCallId: "provider-b", toolName: "bash", output: { type: "text", value: EMPTY_COMPLETED_TOOL_EXECUTION_RESULT } }
    ] }
  ]);
});

test("RuntimeTranscriptProjector follows terminal result projection rules without structured results or artifacts", () => {
  const statuses = ["unknown", "cancelled", "failed", "completed"] as const;
  const calls = statuses.map((status, position) => ({
    id: `call-${status}`, messageId: "assistant", position, type: "tool_call" as const, toolName: "bash" as const,
    input: { status }, providerToolCallId: status, updatedRevision: 1, createdAt: 1, updatedAt: 1
  }));
  const result = projector.project({
    workspaceId: "ws", triggerMessageId: null,
    messages: [message({ id: "assistant", type: "assistant", status: "completed", parts: calls })],
    executions: [
      { callPartId: "call-unknown", status: "unknown", resultPreview: "maybe", error: null },
      { callPartId: "call-cancelled", status: "cancelled", resultPreview: null, error: null },
      { callPartId: "call-failed", status: "failed", resultPreview: "preview", error: "error first" },
      { callPartId: "call-completed", status: "completed", resultPreview: "success preview", error: "ignored" }
    ]
  });
  const tools = result[1] as { role: "tool"; content: Array<{ output: { value: string; type: string } }> };
  assert.deepEqual(tools.content.map((entry) => entry.output), [
    { type: "error-text", value: `${UNKNOWN_TOOL_EXECUTION_RESULT}\n\nReliable result preview:\nmaybe` },
    { type: "text", value: CANCELLED_TOOL_EXECUTION_RESULT },
    { type: "error-text", value: "error first" },
    { type: "text", value: "success preview" }
  ]);
});

test("RuntimeTranscriptProjector rejects non-terminal or missing executions instead of silently projecting an incomplete turn", () => {
  const assistant = message({ id: "assistant", type: "assistant", status: "completed", parts: [
    { id: "call", messageId: "assistant", position: 0, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  for (const executions of [[], [{ callPartId: "call", status: "queued" as const, resultPreview: null, error: null }]]) {
    assert.throws(() => projector.project({ workspaceId: "ws", triggerMessageId: null, messages: [assistant], executions }), /tool execution/);
  }
});

test("RuntimeTranscriptProjector excludes superseded, failed, cancelled assistants and runtime messages", () => {
  const result = projector.project({ workspaceId: "ws", triggerMessageId: null, executions: [], messages: [
    message({ id: "superseded", type: "assistant", status: "superseded", parts: [] }),
    message({ id: "failed", type: "assistant", status: "failed", parts: [] }),
    message({ id: "cancelled", type: "assistant", status: "cancelled", parts: [] }),
    message({ id: "runtime", type: "runtime", status: "completed", parts: [{ id: "rt", messageId: "runtime", position: 0, type: "text", text: "hidden", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] })
  ] });
  assert.deepEqual(result, []);
});

test("RuntimeTranscriptProjector 仅在 detailed 私有调用显式要求时保留空 Assistant ordinal", () => {
  const assistant = message({
    id: "replay-only",
    type: "assistant",
    status: "completed",
    parts: [],
  });

  assert.deepEqual(projector.project({
    workspaceId: "ws",
    triggerMessageId: null,
    executions: [],
    messages: [assistant],
  }), []);

  const detailed = projector.projectDetailed({
    workspaceId: "ws",
    triggerMessageId: null,
    executions: [],
    messages: [assistant],
    includeEmptyAssistantMessageIds: new Set([assistant.id]),
  });
  assert.deepEqual(detailed.messages, [{ role: "assistant", content: [] }]);
  assert.equal(detailed.assistantMessageIndexes.get(assistant.id), 0);
});


test("RuntimeTranscriptProjector excludes the incomplete Assistant turn at an explicit pending boundary", () => {
  const result = projector.project({
    workspaceId: "ws", triggerMessageId: null, executions: [],
    stopBeforeAssistantMessageIds: new Set(["pending-assistant"]),
    messages: [
      message({ id: "user", type: "user", status: "completed", parts: [{ id: "user-text", messageId: "user", position: 0, type: "text", text: "before", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
      message({ id: "pending-assistant", type: "assistant", status: "completed", parts: [{ id: "call", messageId: "pending-assistant", position: 0, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }] })
    ]
  });
  assert.deepEqual(result, [{ role: "user", content: "before" }]);
});

test("RuntimeTranscriptProjector pending boundaries keep completed history and stop at the earliest incomplete Assistant", () => {
  const historyUser = message({ id: "history-user", type: "user", status: "completed", parts: [
    { id: "history-text", messageId: "history-user", position: 0, type: "text", text: "history", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  const terminalAssistant = message({ id: "terminal-assistant", type: "assistant", status: "completed", parts: [
    { id: "terminal-call", messageId: "terminal-assistant", position: 0, type: "tool_call", toolName: "bash", input: { command: "printf terminal" }, providerToolCallId: "terminal-call-id", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  const pendingAssistant = message({ id: "pending-assistant", type: "assistant", status: "completed", parts: [
    { id: "pending-completed-call", messageId: "pending-assistant", position: 0, type: "tool_call", toolName: "bash", input: { command: "printf completed" }, providerToolCallId: "pending-completed-id", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    { id: "pending-call", messageId: "pending-assistant", position: 1, type: "tool_call", toolName: "bash", input: { command: "printf pending" }, providerToolCallId: "pending-call-id", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  const laterAssistant = message({ id: "later-assistant", type: "assistant", status: "completed", parts: [
    { id: "later-text", messageId: "later-assistant", position: 0, type: "text", text: "must not leak", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  const laterPendingAssistant = message({ id: "later-pending-assistant", type: "assistant", status: "completed", parts: [
    { id: "later-pending-call", messageId: "later-pending-assistant", position: 0, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: "later-pending-id", updatedRevision: 1, createdAt: 1, updatedAt: 1 }
  ] });
  const cases = [
    {
      name: "历史 terminal 工具轮次保留，含一个 terminal 与一个 queued 的 Assistant 整体排除，后续 completed 不泄漏",
      stopBeforeAssistantMessageIds: new Set(["pending-assistant"]),
      messages: [historyUser, terminalAssistant, pendingAssistant, laterAssistant],
      executions: [
        { callPartId: "terminal-call", status: "completed" as const, resultPreview: "terminal result", error: null },
        { callPartId: "pending-completed-call", status: "completed" as const, resultPreview: "completed result", error: null },
        { callPartId: "pending-call", status: "queued" as const, resultPreview: null, error: null }
      ]
    },
    {
      name: "多个 pending Assistant 选择链上最早边界",
      stopBeforeAssistantMessageIds: new Set(["later-pending-assistant", "pending-assistant"]),
      messages: [historyUser, terminalAssistant, pendingAssistant, laterAssistant, laterPendingAssistant],
      executions: [
        { callPartId: "terminal-call", status: "completed" as const, resultPreview: "terminal result", error: null },
        { callPartId: "pending-completed-call", status: "completed" as const, resultPreview: "completed result", error: null },
        { callPartId: "pending-call", status: "running" as const, resultPreview: null, error: null },
        { callPartId: "later-pending-call", status: "queued" as const, resultPreview: null, error: null }
      ]
    }
  ];

  for (const scenario of cases) {
    const result = projector.project({ workspaceId: "ws", triggerMessageId: null, ...scenario });
    assert.deepEqual(result, [
      { role: "user", content: "history" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "terminal-call-id", toolName: "bash", input: { command: "printf terminal" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "terminal-call-id", toolName: "bash", output: { type: "text", value: "terminal result" } }] }
    ], scenario.name);
  }
});

test("RuntimeTranscriptProjector keeps System text beginning with [run] and filters only runtime Messages", () => {
  const result = projector.project({ workspaceId: "ws", triggerMessageId: null, executions: [], messages: [
    message({ id: "system", type: "system", status: "completed", parts: [{ id: "system-text", messageId: "system", position: 0, type: "text", text: "[run] user-authored system instruction", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    message({ id: "runtime", type: "runtime", status: "completed", parts: [{ id: "runtime-text", messageId: "runtime", position: 0, type: "text", text: "[run] hidden notice", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] })
  ] });
  assert.deepEqual(result, [{ role: "system", content: "[run] user-authored system instruction" }]);
});
