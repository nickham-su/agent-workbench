import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentContextItemRecordSchema,
  AgentContextItemOutputSchema,
  AgentContextItemsResponseSchema,
  AgentSubtaskRunSummarySchema,
  AgentMessageImageAttachmentSchema,
  AgentSessionContextItemsTailResponseSchema,
  AgentSendMessageMultipartPayloadSchema,
  AgentSendMessageRequestSchema,
  AgentUserMessageOutputSchema
} from "../src/contracts/agent.js";

const imageAttachment = {
  attachmentId: "att_123",
  kind: "image" as const,
  filename: "screenshot.png",
  mediaType: "image/png" as const,
  size: 1024
};

test("image message schemas preserve the existing JSON text requirement", () => {
  const common = { workspaceId: "ws-a", clientRequestId: "request-a" };

  assert.equal(Value.Check(AgentSendMessageRequestSchema, { ...common, text: "hello" }), true);
  assert.equal(Value.Check(AgentSendMessageRequestSchema, common), false);
  assert.equal(Value.Check(AgentSendMessageRequestSchema, { ...common, text: "" }), false);

  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, common), true);
  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, { ...common, text: "" }), true);
  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, { ...common, unexpected: true }), false);
});

test("image attachment read projections accept only V1 image metadata", () => {
  assert.equal(Value.Check(AgentMessageImageAttachmentSchema, imageAttachment), true);
  assert.equal(Value.Check(AgentMessageImageAttachmentSchema, { ...imageAttachment, mediaType: "image/svg+xml" }), false);
  assert.equal(Value.Check(AgentMessageImageAttachmentSchema, { ...imageAttachment, size: 0 }), false);
  assert.equal(Value.Check(AgentMessageImageAttachmentSchema, { ...imageAttachment, size: 10 * 1024 * 1024 + 1 }), false);
  assert.equal(Value.Check(AgentMessageImageAttachmentSchema, { ...imageAttachment, storageKey: "att_123" }), false);
});

test("context item output supports user messages with one through four image attachments", () => {
  const output = { type: "user_message" as const, text: "please inspect", attachments: [imageAttachment] };
  assert.equal(Value.Check(AgentUserMessageOutputSchema, output), true);
  assert.equal(Value.Check(AgentContextItemOutputSchema, output), true);
  assert.equal(Value.Check(AgentContextItemOutputSchema, { type: "user_text", text: "legacy message" }), true);

  assert.equal(Value.Check(AgentUserMessageOutputSchema, { ...output, attachments: [] }), false);
  assert.equal(
    Value.Check(AgentUserMessageOutputSchema, { ...output, attachments: Array.from({ length: 5 }, () => imageAttachment) }),
    false
  );
});

test("subtask run summaries distinguish running and terminal projections", () => {
  const running = { runId: "run-1", status: "running", startedAt: 1, endedAt: null, durationMs: null };
  const completed = { runId: "run-2", status: "completed", startedAt: 1, endedAt: 3, durationMs: 2 };
  assert.equal(Value.Check(AgentSubtaskRunSummarySchema, running), true);
  assert.equal(Value.Check(AgentSubtaskRunSummarySchema, completed), true);
  assert.equal(Value.Check(AgentSubtaskRunSummarySchema, { ...running, endedAt: 2 }), false);
  assert.equal(Value.Check(AgentSubtaskRunSummarySchema, { ...completed, durationMs: null }), false);
  assert.equal(Value.Check(AgentSubtaskRunSummarySchema, { ...completed, startedAt: 0 }), false);
  assert.equal(Value.Check(AgentSubtaskRunSummarySchema, { ...completed, endedAt: -1 }), false);
});

test("context item keeps subtaskRun optional for old and non-subtask responses", () => {
  const base = {
    id: 1, workspaceId: "ws", sessionId: "session", runId: null, turnId: null, step: null, prevId: null,
    kind: "user", status: "completed", archiveAt: null, boundaryReason: null,
    output: { type: "user_text", text: "hello" }, createdAt: 1, updatedAt: 1
  };
  assert.equal(Value.Check(AgentContextItemRecordSchema, base), true);
  assert.equal(Value.Check(AgentContextItemRecordSchema, {
    ...base,
    subtaskRun: { runId: "child", status: "failed", startedAt: 2, endedAt: 5, durationMs: 3 }
  }), true);
  assert.equal(Value.Check(AgentContextItemRecordSchema, {
    ...base,
    subtaskRun: { runId: "child", status: "running", startedAt: 2, endedAt: 5, durationMs: null }
  }), false);
});

test("public and internal context response schemas preserve optional subtaskRun", () => {
  const item = {
    id: 1, workspaceId: "ws", sessionId: "session", runId: "parent", turnId: null, step: null, prevId: null,
    kind: "tool", status: "completed", archiveAt: null, boundaryReason: null,
    output: { type: "tool", toolName: "subtask" }, createdAt: 1, updatedAt: 1
  };
  const withSummary = {
    ...item,
    subtaskRun: { runId: "child", status: "completed", startedAt: 2, endedAt: 4, durationMs: 2 }
  };
  const publicResponse = (entry: typeof item | typeof withSummary) => ({
    sessionId: "session", headItemId: 1, appliedItemId: 1, items: [entry]
  });
  const internalResponse = (entry: typeof item | typeof withSummary) => ({
    sessionId: "session", headItemId: 1, appliedItemId: 1, items: [entry]
  });

  assert.equal(Value.Check(AgentContextItemRecordSchema, item), true);
  assert.equal(Value.Check(AgentContextItemRecordSchema, withSummary), true);
  assert.equal(Value.Check(AgentContextItemsResponseSchema, publicResponse(item)), true);
  assert.equal(Value.Check(AgentContextItemsResponseSchema, publicResponse(withSummary)), true);
  assert.equal(Value.Check(AgentSessionContextItemsTailResponseSchema, internalResponse(item)), true);
  assert.equal(Value.Check(AgentSessionContextItemsTailResponseSchema, internalResponse(withSummary)), true);
});
