import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCompactionMessage, AgentOrdinaryMessage, AgentMessage, AgentTimelineDeltaResponse, AgentTimelineToolExecution } from "@agent-workbench/shared";
import {
  agentUserMessageDraftText,
  applyAgentTimelineDelta,
  buildConversationParts,
  canForkAgentTimelineMessage,
  canRevertAgentTimelineMessage,
  hasAgentMessageTextPart,
  replaceAgentTimelineSnapshot,
} from "./agentMessageTimeline.js";

function message(overrides: Partial<AgentOrdinaryMessage> & Pick<AgentOrdinaryMessage, "id">): AgentOrdinaryMessage {
  return {
    workspaceId: "workspace-a",
    previousMessageId: null,
    replacesMessageId: null,
    depth: 0,
    type: "assistant",
    status: "completed",
    originSessionId: null,
    originRunId: null,
    updatedRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    parts: [],
    ...overrides,
  };
}

function compactionMessage({ id, ...overrides }: Partial<AgentCompactionMessage> & Pick<AgentCompactionMessage, "id">): AgentCompactionMessage {
  return {
    id, workspaceId: "workspace-a", previousMessageId: "previous", replacesMessageId: null,
    retainedFromMessageId: null, depth: 1, type: "compaction", status: "completed",
    originSessionId: null, originRunId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1,
    parts: [{ id: "compaction-text", messageId: id, position: 0, type: "text", text: "summary", updatedRevision: 1, createdAt: 1, updatedAt: 1 }],
    ...overrides,
  };
}

function execution(overrides: Partial<AgentTimelineToolExecution> & Pick<AgentTimelineToolExecution, "id" | "callPartId">): AgentTimelineToolExecution {
  return {
    status: "completed",
    resultPreview: null,
    resultTruncated: false,
    error: null,
    updatedRevision: 1,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function delta(params: Partial<AgentTimelineDeltaResponse>): AgentTimelineDeltaResponse {
  return {
    session: {
      id: "session-a", workspaceId: "workspace-a", title: "Session", kind: "primary",
      headMessageId: null, contextRootMessageId: null, revision: 1,
      forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1,
    },
    timelineReset: false,
    messages: [],
    toolExecutions: [],
    ...params,
  };
}

test("普通 timeline delta 按 updatedRevision upsert Message 与 ToolExecution", () => {
  const initial = { revision: 1, messages: [message({ id: "m", status: "streaming", updatedRevision: 1 })], toolExecutions: [execution({ id: "e", callPartId: "p", status: "queued", updatedRevision: 1 })] };
  const next = applyAgentTimelineDelta(initial, delta({
    session: { ...delta({}).session, revision: 3 },
    messages: [message({ id: "m", status: "completed", updatedRevision: 2 })],
    toolExecutions: [execution({ id: "e", callPartId: "p", status: "completed", resultPreview: "done", updatedRevision: 3 })],
  }));
  assert.equal(next.revision, 3);
  assert.equal(next.messages[0]?.status, "completed");
  assert.equal(next.toolExecutions[0]?.resultPreview, "done");
});

test("滞后 delta 不得覆盖更高 updatedRevision 的 Message 或 ToolExecution", () => {
  const next = applyAgentTimelineDelta(
    {
      revision: 5,
      messages: [message({ id: "assistant", status: "completed", updatedRevision: 5 })],
      toolExecutions: [execution({ id: "execution", callPartId: "call", status: "completed", resultPreview: "authoritative", updatedRevision: 5 })],
    },
    delta({
      session: { ...delta({}).session, revision: 5 },
      messages: [message({ id: "assistant", status: "streaming", updatedRevision: 4 })],
      toolExecutions: [execution({ id: "execution", callPartId: "call", status: "running", resultPreview: "stale", updatedRevision: 4 })],
    }),
  );
  assert.equal(next.messages[0]?.status, "completed");
  assert.equal(next.toolExecutions[0]?.resultPreview, "authoritative");
});

test("timelineReset 丢弃旧分支并以服务端当前链为准", () => {
  const next = applyAgentTimelineDelta(
    { revision: 10, messages: [message({ id: "obsolete", depth: 9 })], toolExecutions: [execution({ id: "old", callPartId: "old-part" })] },
    delta({ timelineReset: true, session: { ...delta({}).session, revision: 11, headMessageId: "head" }, messages: [message({ id: "head", depth: 0 })] }),
  );
  assert.deepEqual(next.messages.map((item) => item.id), ["head"]);
  assert.deepEqual(next.toolExecutions, []);
});

test("snapshot 显式替换旧分支 Message 与 ToolExecution", () => {
  const next = replaceAgentTimelineSnapshot(
    { revision: 10, messages: [message({ id: "old", updatedRevision: 10 })], toolExecutions: [execution({ id: "old-execution", callPartId: "old-call", updatedRevision: 10 })] },
    delta({
      session: { ...delta({}).session, revision: 11, headMessageId: "new", contextRootMessageId: "new" },
      messages: [message({ id: "new", updatedRevision: 11 })],
      toolExecutions: [execution({ id: "new-execution", callPartId: "new-call", updatedRevision: 11 })],
    }),
  );
  assert.deepEqual(next.messages.map((item) => item.id), ["new"]);
  assert.deepEqual(next.toolExecutions.map((item) => item.id), ["new-execution"]);
});

test("hasAgentMessageTextPart 仅按 Message 是否包含 TextPart 判断", () => {
  const withoutText = message({
    id: "without-text",
    parts: [
      { id: "reason", messageId: "without-text", position: 0, type: "reasoning", text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "call", messageId: "without-text", position: 1, type: "tool_call", toolName: "read", input: { filePath: "a.ts" }, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ],
  });
  const withText = message({
    id: "with-text",
    parts: [...withoutText.parts, { id: "text", messageId: "with-text", position: 2, type: "text", text: "done", updatedRevision: 1, createdAt: 1, updatedAt: 1 }],
  });
  assert.equal(hasAgentMessageTextPart(withoutText), false);
  assert.equal(hasAgentMessageTextPart(withText), true);
});

test("agentUserMessageDraftText 仅还原 User 的 TextPart，并保持 Part 顺序", () => {
  const user = message({
    id: "user",
    type: "user",
    parts: [
      { id: "text-2", messageId: "user", position: 2, type: "text", text: "world", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "image", messageId: "user", position: 1, type: "image", attachmentId: "attachment", mediaType: "image/png", filename: "image.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "text-1", messageId: "user", position: 0, type: "text", text: "hello ", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ],
  });
  assert.equal(agentUserMessageDraftText(user), "hello world");
  assert.equal(agentUserMessageDraftText(message({ id: "assistant" })), null);
});

test("Fork 与 Revert 分别按历史和当前操作区间判断资格", () => {
  const historicalUser = message({
    id: "old-user", type: "user", inCurrentOperationRange: false,
  });
  const historicalAssistant = message({
    id: "old-assistant", type: "assistant", inCurrentOperationRange: false,
  });
  const currentUser = message({
    id: "current-user", type: "user", inCurrentOperationRange: true,
  });
  const currentAssistant = message({
    id: "current-assistant", type: "assistant", inCurrentOperationRange: true,
  });
  const unmarkedUser = message({
    id: "unmarked-user", type: "user",
  });
  const system = message({ id: "system", type: "system", inCurrentOperationRange: true });
  const runtime = message({ id: "runtime", type: "runtime", inCurrentOperationRange: true });
  const compaction = compactionMessage({
    id: "compaction", type: "compaction", inCurrentOperationRange: true,
  });

  assert.equal(canForkAgentTimelineMessage(historicalUser), true);
  assert.equal(canRevertAgentTimelineMessage(historicalUser), false);
  assert.equal(canForkAgentTimelineMessage(historicalAssistant), true);
  assert.equal(canRevertAgentTimelineMessage(historicalAssistant), false);
  assert.equal(canForkAgentTimelineMessage(currentUser), true);
  assert.equal(canRevertAgentTimelineMessage(currentUser), true);
  assert.equal(canForkAgentTimelineMessage(currentAssistant), true);
  assert.equal(canRevertAgentTimelineMessage(currentAssistant), false);
  assert.equal(canForkAgentTimelineMessage(unmarkedUser), true);
  assert.equal(canRevertAgentTimelineMessage(unmarkedUser), false);
  for (const unsupported of [system, runtime, compaction]) {
    assert.equal(canForkAgentTimelineMessage(unsupported), false);
    assert.equal(canRevertAgentTimelineMessage(unsupported), false);
  }
});

test("Conversation 保持 Part.position、标记唯一操作锚点，并关联 ToolExecution", () => {
  const assistant = message({
    id: "assistant", parts: [
      { id: "text", messageId: "assistant", position: 2, type: "text", text: "after", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "call", messageId: "assistant", position: 1, type: "tool_call", toolName: "bash", input: { command: "pwd" }, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason", messageId: "assistant", position: 4, type: "reasoning", text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ],
  });
  const rows = buildConversationParts({ revision: 1, messages: [assistant], toolExecutions: [execution({ id: "execution", callPartId: "call", resultPreview: "ok" })] });
  assert.deepEqual(rows.map((row) => row.part?.id), ["call", "text", "reason"]);
  assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), [true, false, false]);
  assert.equal(rows[0]?.execution?.id, "execution");
  assert.equal(rows[1]?.execution, null);
});

test("Conversation 合并连续 ReasoningPart，并在其他 Part 处断开", () => {
  const assistant = message({
    id: "assistant-reasoning",
    parts: [
      { id: "reason-1", messageId: "assistant-reasoning", position: 0, type: "reasoning", text: "first", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason-2", messageId: "assistant-reasoning", position: 1, type: "reasoning", text: "second", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "call", messageId: "assistant-reasoning", position: 2, type: "tool_call", toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason-3", messageId: "assistant-reasoning", position: 3, type: "reasoning", text: "third", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason-4", messageId: "assistant-reasoning", position: 4, type: "reasoning", text: "fourth", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "text", messageId: "assistant-reasoning", position: 5, type: "text", text: "done", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason-5", messageId: "assistant-reasoning", position: 6, type: "reasoning", text: "fifth", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ],
  });

  const rows = buildConversationParts({ revision: 1, messages: [assistant], toolExecutions: [] });

  assert.deepEqual(rows.map((row) => row.part?.id), ["reason-1", "call", "reason-3", "text", "reason-5"]);
  assert.deepEqual(rows.map((row) => row.reasoningText), [
    "first\n\nsecond",
    "",
    "third\n\nfourth",
    "",
    "fifth",
  ]);
  assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), [true, false, false, false, false]);
});

test("Conversation 将同一消息的多个 ImagePart 汇总为一个展示行", () => {
  const user = message({
    id: "user-images",
    type: "user",
    parts: [
      { id: "text", messageId: "user-images", position: 0, type: "text", text: "查看图片", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "image-a", messageId: "user-images", position: 1, type: "image", attachmentId: "attachment-a", mediaType: "image/png", filename: "a.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "image-b", messageId: "user-images", position: 2, type: "image", attachmentId: "attachment-b", mediaType: "image/jpeg", filename: "b.jpg", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ],
  });

  const rows = buildConversationParts({ revision: 1, messages: [user], toolExecutions: [] });

  assert.deepEqual(rows.map((row) => row.part?.id), ["text", "image-a"]);
  assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), [true, false]);
  assert.deepEqual(rows[0]?.imageParts, []);
  assert.deepEqual(rows[1]?.imageParts.map((part) => part.id), ["image-a", "image-b"]);
});

test("Conversation 为无 Part 和非 Text Assistant 提供唯一操作锚点", () => {
  const assistants = [
    message({ id: "empty", parts: [] }),
    message({ id: "tool", parts: [{ id: "tool-call", messageId: "tool", position: 3, type: "tool_call", toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    message({ id: "reasoning", parts: [{ id: "reasoning-part", messageId: "reasoning", position: 3, type: "reasoning", text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    message({ id: "image", parts: [{ id: "image-part", messageId: "image", position: 3, type: "image", attachmentId: "attachment", mediaType: "image/png", filename: "image.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
  ];
  const rows = buildConversationParts({ revision: 1, messages: assistants, toolExecutions: [] });
  assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), [true, true, true, true]);
  assert.equal(rows[0]?.part, null);
  assert.equal(rows.filter((row) => row.isFirstRowForMessage).length, assistants.length);
});
