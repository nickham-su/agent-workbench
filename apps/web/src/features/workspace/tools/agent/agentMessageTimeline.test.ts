import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCompactionMessage, AgentOrdinaryMessage, AgentMessage, AgentTimelineDeltaResponse, AgentTimelineToolExecution } from "@agent-workbench/shared";
import {
  agentUserMessageDraftText,
  applyAgentTimelineDelta,
  buildConversationParts,
  canMutateAgentTimelineMessage,
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

test("当前结构操作区间之前的 Timeline 历史不提供 Fork 或回退等操作", () => {
  const textPart = {
    id: "part", messageId: "assistant", position: 0, type: "text" as const,
    text: "answer", updatedRevision: 1, createdAt: 1, updatedAt: 1,
  };
  assert.equal(canMutateAgentTimelineMessage(message({
    id: "old-user", type: "user", inCurrentOperationRange: false,
  })), false);
  assert.equal(canMutateAgentTimelineMessage(message({
    id: "old-assistant", type: "assistant", inCurrentOperationRange: false, parts: [textPart],
  })), false);
  assert.equal(canMutateAgentTimelineMessage(message({
    id: "unmarked-user", type: "user",
  })), false);
  assert.equal(canMutateAgentTimelineMessage(message({
    id: "current-user", type: "user", inCurrentOperationRange: true,
  })), true);
  assert.equal(canMutateAgentTimelineMessage(message({
    id: "current-assistant", type: "assistant", inCurrentOperationRange: true, parts: [textPart],
  })), true);
  assert.equal(canMutateAgentTimelineMessage(compactionMessage({
    id: "compaction", type: "compaction", inCurrentOperationRange: true,
  })), false);
});

test("Conversation 保持 Part.position 且 ToolCall 用 callPartId 显式关联 ToolExecution", () => {
  const assistant = message({
    id: "assistant", parts: [
      { id: "text", messageId: "assistant", position: 2, type: "text", text: "after", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "call", messageId: "assistant", position: 1, type: "tool_call", toolName: "bash", input: { command: "pwd" }, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason", messageId: "assistant", position: 0, type: "reasoning", text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ],
  });
  const rows = buildConversationParts({ revision: 1, messages: [assistant], toolExecutions: [execution({ id: "execution", callPartId: "call", resultPreview: "ok" })] });
  assert.deepEqual(rows.map((row) => row.part?.id), ["reason", "call", "text"]);
  assert.equal(rows[1]?.execution?.id, "execution");
  assert.equal(rows[0]?.execution, null);
});
