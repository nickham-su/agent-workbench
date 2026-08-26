import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentContextItemOutputSchema,
  AgentMessageImageAttachmentSchema,
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
