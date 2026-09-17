import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentMessagePartSchema,
  AgentMessageSchema,
  AgentTimelineDeltaResponseSchema,
  AgentTimelineToolExecutionSchema,
  AgentToolExecutionSchema
} from "../src/contracts/agent-message.js";
import {
  AgentSendMessageMultipartPayloadSchema,
  AgentSendMessageRequestSchema
} from "../src/contracts/agent.js";

const partBase = { id: "part-1", messageId: "message-1", position: 0, updatedRevision: 0, createdAt: 1, updatedAt: 1 };

test("Agent Message Part schema limits persisted content to four supported Part types", () => {
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "text", text: "hello" }), true);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "reasoning", text: "think" }), true);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "image", attachmentId: "attachment-1", mediaType: "image/png", filename: "image.png" }), true);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "tool_call", toolName: "bash", input: { command: "pwd" }, providerToolCallId: null }), true);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "tool_result", text: "not supported" }), false);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "tool_call", toolName: "bash", input: ["not", "an", "object"], providerToolCallId: null }), false);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...partBase, type: "tool_call", toolName: "bash", input: null, providerToolCallId: null }), false);
});

test("Message and ToolExecution schemas expose stable graph and execution references", () => {
  assert.equal(Value.Check(AgentMessageSchema, {
    id: "message-1", workspaceId: "workspace-1", previousMessageId: null, replacesMessageId: null,
    depth: 0, type: "assistant", status: "completed", originSessionId: "session-1", originRunId: "run-1",
    updatedRevision: 2, createdAt: 1, updatedAt: 2, parts: [{ ...partBase, type: "text", text: "hello" }]
  }), true);
  assert.equal(Value.Check(AgentToolExecutionSchema, {
    id: "execution-1", callPartId: "part-1", originSessionId: "session-1", originRunId: "run-1",
    status: "unknown", resultPreview: null, resultTruncated: false, resultArtifactPath: null,
    structuredResult: null, error: null, updatedRevision: 2, createdAt: 1, updatedAt: 2,
    startedAt: 1, completedAt: 2
  }), true);
});

test("JSON send schema requires non-empty text and rejects unknown properties", () => {
  const base = { workspaceId: "workspace-1", clientRequestId: "request-1" };
  assert.equal(Value.Check(AgentSendMessageRequestSchema, { ...base, text: "hello" }), true);
  assert.equal(Value.Check(AgentSendMessageRequestSchema, { ...base, text: "" }), false);
  assert.equal(Value.Check(AgentSendMessageRequestSchema, { ...base, text: "hello", images: [] }), false);
  assert.equal(Value.Check(AgentSendMessageRequestSchema, { ...base, text: "hello", extra: true }), false);
});

test("multipart send schema allows omitted or empty text but rejects unknown properties", () => {
  const base = { workspaceId: "workspace-1", clientRequestId: "request-1" };
  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, base), true);
  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, { ...base, text: "" }), true);
  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, { ...base, text: "with image" }), true);
  assert.equal(Value.Check(AgentSendMessageMultipartPayloadSchema, { ...base, extra: true }), false);
});

test("timeline ToolExecution view excludes structured result and artifact details", () => {
  const view = {
    id: "execution-1", callPartId: "part-1", status: "completed", resultPreview: "done", resultTruncated: false,
    error: null, updatedRevision: 2, startedAt: 1, completedAt: 2
  };
  assert.equal(Value.Check(AgentTimelineToolExecutionSchema, view), true);
  assert.equal(Value.Check(AgentTimelineToolExecutionSchema, { ...view, structuredResult: { secret: "no" } }), false);
  assert.equal(Value.Check(AgentTimelineToolExecutionSchema, { ...view, resultArtifactPath: "/not-in-timeline" }), false);
  assert.equal(Value.Check(AgentTimelineToolExecutionSchema, { ...view, resultPreview: "x".repeat(3_001) }), false);
  assert.equal(Value.Check(AgentTimelineDeltaResponseSchema, {
    session: { id: "session-1", workspaceId: "workspace-1", title: "Session", kind: "primary", headMessageId: null, contextRootMessageId: null, revision: 0, forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1 },
    timelineReset: false, messages: [], toolExecutions: [view]
  }), true);
});


test("user Message image Part carries only attachment metadata through timeline", () => {
  const image = { ...partBase, type: "image" as const, attachmentId: "attachment-1", mediaType: "image/webp" as const, filename: "capture.webp" };
  const userMessage = {
    id: "message-user", workspaceId: "workspace-1", previousMessageId: null, replacesMessageId: null,
    depth: 0, type: "user" as const, status: "completed" as const, originSessionId: "session-1", originRunId: null,
    updatedRevision: 1, createdAt: 1, updatedAt: 1,
    parts: [{ ...partBase, id: "part-text", messageId: "message-user", type: "text" as const, text: "inspect this" }, { ...image, id: "part-image", messageId: "message-user", position: 1 }]
  };
  assert.equal(Value.Check(AgentMessageSchema, userMessage), true);
  assert.equal(Value.Check(AgentMessagePartSchema, { ...image, mediaType: "image/svg+xml" }), false);
  assert.equal(Value.Check(AgentTimelineDeltaResponseSchema, {
    session: { id: "session-1", workspaceId: "workspace-1", title: "Session", kind: "primary", headMessageId: "message-user", contextRootMessageId: "message-user", revision: 1, forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1 },
    messages: [userMessage], toolExecutions: [], timelineReset: false
  }), true);
});
