import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCompactionMessage, AgentOrdinaryMessage, AgentMessage, AgentMessagePart, AgentTimelineDeltaResponse, AgentTimelineToolExecution } from "@agent-workbench/shared";
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

test("未变化的 delta 复用已有消息和执行列表，避免切换 tab 时全量重建", () => {
  const state = {
    revision: 2,
    messages: [message({ id: "m", updatedRevision: 2 })],
    toolExecutions: [execution({ id: "e", callPartId: "p", updatedRevision: 2 })],
  };
  assert.equal(applyAgentTimelineDelta(state, delta({ session: { ...delta({}).session, revision: 2 } })), state);
  const advanced = applyAgentTimelineDelta(state, delta({ session: { ...delta({}).session, revision: 3 } }));
  assert.equal(advanced.revision, 3);
  assert.notEqual(advanced, state);
  assert.equal(advanced.messages, state.messages);
  assert.equal(advanced.toolExecutions, state.toolExecutions);
  assert.equal(applyAgentTimelineDelta(state, delta({ session: { ...delta({}).session, revision: 1 } })), state);

  const updated = applyAgentTimelineDelta(state, delta({
    session: { ...delta({}).session, revision: 3 },
    messages: [message({ id: "new", updatedRevision: 3 })],
  }));
  assert.deepEqual(updated.messages.map((item) => item.id), ["m", "new"]);
  assert.equal(updated.revision, 3);

  const reset = applyAgentTimelineDelta(state, delta({
    timelineReset: true,
    session: { ...delta({}).session, revision: 3 },
  }));
  assert.equal(reset.revision, 3);
  assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.toolExecutions, []);
});

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
  const rows = buildConversationParts({ messages: [assistant], toolExecutions: [execution({ id: "execution", callPartId: "call", resultPreview: "ok" })] });
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

  const rows = buildConversationParts({ messages: [assistant], toolExecutions: [] });

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

  const rows = buildConversationParts({ messages: [user], toolExecutions: [] });

  assert.deepEqual(rows.map((row) => row.part?.id), ["text", "image-a"]);
  assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), [true, false]);
  assert.deepEqual(rows[0]?.imageParts, []);
  assert.deepEqual(rows[1]?.imageParts.map((part) => part.id), ["image-a", "image-b"]);
});

for (const { name, type, texts, imageCount, hideText } of [
  { name: "空串加图片隐藏文本行", type: "user", texts: [""], imageCount: 1, hideText: true },
  { name: "纯空白加图片隐藏文本行", type: "user", texts: [" \t\n　"], imageCount: 1, hideText: true },
  { name: "多段空文本加多图仅保留聚合图片行", type: "user", texts: ["", " \n", "\t　"], imageCount: 2, hideText: true },
  { name: "无 TextPart 的纯图片保持聚合展示", type: "user", texts: [], imageCount: 2, hideText: true },
  { name: "有效正文加空白加图片保留所有文本原文", type: "user", texts: ["", "  查看\n图片  ", " \t\n　"], imageCount: 2, hideText: false },
  { name: "有效正文无图片不裁剪原文", type: "user", texts: ["  查看\n文字  "], imageCount: 0, hideText: false },
  { name: "空白用户文本无图片仍保留", type: "user", texts: ["", " \n"], imageCount: 0, hideText: false },
  { name: "Assistant 空文本加图片不受影响", type: "assistant", texts: ["", " \n"], imageCount: 2, hideText: false },
  { name: "System 空文本加图片不受影响", type: "system", texts: ["", " \n"], imageCount: 1, hideText: false },
  { name: "Runtime 空文本加图片不受影响", type: "runtime", texts: ["", " \n"], imageCount: 1, hideText: false },
] as const) {
  test(`Conversation ${name}`, () => {
    const parts: AgentMessagePart[] = [
      ...texts.map((text, position) => ({
        id: `text-${position}`, messageId: "image-message", position, type: "text" as const, text,
        updatedRevision: 1, createdAt: 1, updatedAt: 1,
      })),
      ...Array.from({ length: imageCount }, (_, index) => ({
        id: `image-${index}`, messageId: "image-message", position: texts.length + index, type: "image" as const,
        attachmentId: `attachment-${index}`, mediaType: "image/png" as const, filename: `${index}.png`,
        updatedRevision: 1, createdAt: 1, updatedAt: 1,
      })),
    ];
    const original = message({ id: "image-message", type, parts: parts.reverse() });
    const snapshot = structuredClone(original);

    const rows = buildConversationParts({ messages: [original], toolExecutions: [] });

    assert.deepEqual(rows.filter((row) => row.part?.type === "text").map((row) => row.part?.type === "text" ? row.part.text : null), hideText ? [] : [...texts]);
    assert.equal(rows.length, (hideText ? 0 : texts.length) + (imageCount > 0 ? 1 : 0));
    assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), rows.map((_, index) => index === 0));
    if (imageCount > 0) {
      const imageRow = rows.find((row) => row.part?.type === "image");
      assert.equal(imageRow?.part?.id, "image-0");
      assert.deepEqual(imageRow.imageParts.map((part) => part.id), Array.from({ length: imageCount }, (_, index) => `image-${index}`));
    }
    assert.ok(rows.every((row) => row.message === original));
    assert.deepEqual(original, snapshot, "展示过滤不得改写原始消息或 Part 顺序");
  });
}

test("Conversation 为无 Part 和非 Text Assistant 提供唯一操作锚点", () => {
  const assistants = [
    message({ id: "empty", parts: [] }),
    message({ id: "tool", parts: [{ id: "tool-call", messageId: "tool", position: 3, type: "tool_call", toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    message({ id: "reasoning", parts: [{ id: "reasoning-part", messageId: "reasoning", position: 3, type: "reasoning", text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    message({ id: "image", parts: [{ id: "image-part", messageId: "image", position: 3, type: "image", attachmentId: "attachment", mediaType: "image/png", filename: "image.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
  ];
  const rows = buildConversationParts({ messages: assistants, toolExecutions: [] });
  assert.deepEqual(rows.map((row) => row.isFirstRowForMessage), [true, true, true, true]);
  assert.equal(rows[0]?.part, null);
  assert.equal(rows.filter((row) => row.isFirstRowForMessage).length, assistants.length);
});
