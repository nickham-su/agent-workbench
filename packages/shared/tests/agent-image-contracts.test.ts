import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AgentCallableContextToolNameSchema, AgentContextToolNameSchema } from "../src/contracts/agent-primitives.js";
import { AgentToolCallPartSchema } from "../src/contracts/agent-message.js";
import {
  AgentToolResultOutputSchema,
  AgentViewImageResultSchema,
  AgentWorkspaceImagePathSchema
} from "../src/internal-contracts/agent-image.js";
import {
  AgentApiCompactionSourceResponseSchema,
  AgentApiPromptAttachmentRefPartSchema,
  AgentApiPromptContextResponseSchema
} from "../src/internal-contracts/agent-api-read.js";

test("historical visual_analyze calls remain readable without joining the new callable name set", () => {
  assert.equal(Value.Check(AgentCallableContextToolNameSchema, "view_image"), true);
  assert.equal(Value.Check(AgentCallableContextToolNameSchema, "visual_analyze"), false);
  assert.equal(Value.Check(AgentContextToolNameSchema, "visual_analyze"), true);
  const historicalCall = { id: "part", messageId: "message", position: 0, updatedRevision: 0,
    createdAt: 1, updatedAt: 1, type: "tool_call", toolName: "visual_analyze", input: {}, providerToolCallId: null };
  assert.equal(Value.Check(AgentToolCallPartSchema, historicalCall), true);
});

test("workspace image paths and completed view_image results have a narrow strict wire shape", () => {
  const imageRef = { type: "image_ref", path: ".awb/agent/attachments/att_abc.png" };
  assert.equal(Value.Check(AgentViewImageResultSchema, imageRef), true);
  for (const path of ["", "/tmp/a.png", "../a.png", "a/./b.png", "a/../b.png", "a//b.png", "C:/a.png", "a\\b.png", "a\nb.png", "file://image.png"]) {
    assert.equal(Value.Check(AgentWorkspaceImagePathSchema, path), false, path);
  }
  for (const path of ["截图/页面 1.png", "images/café.webp", "报告/图像_日本語.jpg", ".awb/agent/attachments/a.png"]) {
    assert.equal(Value.Check(AgentWorkspaceImagePathSchema, path), true, path);
  }
  // C1 controls, Unicode line/paragraph separators, zero-width and bidi format controls.
  for (const codePoint of [0x0085, 0x009b, 0x00ad, 0x034f, 0x061c, 0x180e, 0x200b, 0x200d,
    0x2028, 0x2029, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfff9]) {
    const path = `images/a${String.fromCodePoint(codePoint)}b.png`;
    assert.equal(Value.Check(AgentWorkspaceImagePathSchema, path), false, `U+${codePoint.toString(16)}`);
  }
  for (const bad of [
    { ...imageRef, bytes: "base64" },
    { ...imageRef, value: "base64" },
    { ...imageRef, path: "../secret.png" },
    { type: "image_ref", path: [imageRef.path] },
    { type: "text", value: imageRef.path },
    [imageRef],
  ]) {
    assert.equal(Value.Check(AgentViewImageResultSchema, bad), false);
  }
});

test("tool output allows standalone text/error/image or a nonempty flat success array only", () => {
  const text = { type: "text", value: "caption" };
  const error = { type: "error-text", value: "unavailable" };
  const image = { type: "image_ref", path: "screenshots/page.webp" };
  for (const output of [text, error, image, [text], [text, text], [image], [image, image], [text, image], [image, text, image]]) {
    assert.equal(Value.Check(AgentToolResultOutputSchema, output), true);
  }
  for (const output of [[], [error], [text, error], [image, error], [[image]], [[text]], [{ ...text, data: "base64" }], [{ ...image, data: "base64" }], { ...image, data: "base64" }]) {
    assert.equal(Value.Check(AgentToolResultOutputSchema, output), false);
  }
  const prompt = {
    headMessageId: null, sessionRevision: 0, system: "", tools: [], pendingTools: [],
    lastResponseTotalTokens: null, uiLocale: null, externalSkills: [],
    messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "view_image", output: [text, image] }] }]
  };
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, prompt), true);
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, {
    ...prompt, messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "view_image", output: [text, text] }] }]
  }), true);
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, {
    ...prompt, messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "view_image", output: [error] }] }]
  }), false);
});

test("current upload references require paths, compaction source exposes only trusted narrow paths", () => {
  const attachment = { type: "attachment_ref", workspaceId: "w", attachmentId: "att", filename: "name.png", mediaType: "image/png" };
  assert.equal(Value.Check(AgentApiPromptAttachmentRefPartSchema, attachment), false);
  assert.equal(Value.Check(AgentApiPromptAttachmentRefPartSchema, { ...attachment, path: ".awb/agent/attachments/att.png" }), true);
  assert.equal(Value.Check(AgentApiPromptAttachmentRefPartSchema, { ...attachment, path: "../bad.png" }), false);
  const source = {
    workspaceId: "w", sessionId: "s", runId: "r", runKind: "user", triggerMessageId: null,
    agentId: "a", providerId: "p", modelId: "m", subtaskDepth: null, headMessageId: "msg",
    contextRootMessageId: null, sessionRevision: 0, uiLocale: null, oneShotSystem: "", pendingBoundary: null,
    blocks: [{
      sourceMessageId: "msg", physical: { previousMessageId: null, depth: 0, originSessionId: null, originRunId: null, updatedRevision: 0 },
      message: { id: "msg", workspaceId: "w", previousMessageId: null, replacesMessageId: null, depth: 0,
        type: "user", status: "completed", originSessionId: "s", originRunId: "r", updatedRevision: 0,
        createdAt: 1, updatedAt: 1, parts: [] },
      toolExecutions: [{ id: "exe", callPartId: "call", status: "completed", resultPreview: null, error: null,
        startedAt: 1, completedAt: 2, originRunId: "r", imageRef: { type: "image_ref", path: "screenshots/page.png" } }],
      attachments: [{ partId: "part", attachmentId: "att", mediaType: "image/png", filename: "name.png", relativePath: null }],
      providerReplay: []
    }]
  };
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, source), true);
  for (const invalidExecution of [
    { ...source.blocks[0].toolExecutions[0], originRunId: null },
    { ...source.blocks[0].toolExecutions[0], originRunId: undefined },
    { ...source.blocks[0].toolExecutions[0], status: "failed" },
    { ...source.blocks[0].toolExecutions[0], imageRef: { type: "image_ref", path: "screenshots/page.png", data: "base64" } }
  ]) {
    assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...source, blocks: [{ ...source.blocks[0], toolExecutions: [invalidExecution] }] }), false);
  }
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...source, blocks: [{ ...source.blocks[0], toolExecutions: [
    { ...source.blocks[0].toolExecutions[0], imageRef: { type: "image_ref", path: "../bad.png" } }
  ] }] }), false);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...source, blocks: [{ ...source.blocks[0], attachments: [
    { ...source.blocks[0].attachments[0], relativePath: "/abs.png" }
  ] }] }), false);
});
