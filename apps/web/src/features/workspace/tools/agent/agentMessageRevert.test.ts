import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessageRevertItem } from "./agentMessageRevert.js";
import { resolveAgentMessageRevertTarget } from "./agentMessageRevert.js";

test("user_text reverts to its previous item and restores the draft", () => {
  const result = resolveAgentMessageRevertTarget({
    id: 12,
    prevId: 11,
    kind: "user",
    output: { type: "user_text", text: "plain text" }
  } satisfies AgentMessageRevertItem);

  assert.deepEqual(result, { toItemId: 11, revertDraft: "plain text", isUserTarget: true });
});

test("user_message reverts to its previous item and restores the text draft", () => {
  const result = resolveAgentMessageRevertTarget({
    id: 22,
    prevId: 21,
    kind: "user",
    output: {
      type: "user_message",
      text: "message with image",
      attachments: [{ attachmentId: "att_1", kind: "image", filename: "screen.png", mediaType: "image/png", size: 8 }]
    }
  } satisfies AgentMessageRevertItem);

  assert.deepEqual(result, { toItemId: 21, revertDraft: "message with image", isUserTarget: true });
});

test("image-only user_message explicitly restores an empty draft", () => {
  const result = resolveAgentMessageRevertTarget({
    id: 23,
    prevId: 22,
    kind: "user",
    output: {
      type: "user_message",
      text: "",
      attachments: [{ attachmentId: "att_2", kind: "image", filename: "only-image.png", mediaType: "image/png", size: 8 }]
    }
  } satisfies AgentMessageRevertItem);

  assert.deepEqual(result, { toItemId: 22, revertDraft: "", isUserTarget: true });
});

test("first user_message retains the reset-to-draft target and its text", () => {
  const result = resolveAgentMessageRevertTarget({
    id: 1,
    prevId: null,
    kind: "user",
    output: {
      type: "user_message",
      text: "first message with image",
      attachments: [{ attachmentId: "att_1", kind: "image", filename: "screen.webp", mediaType: "image/webp", size: 8 }]
    }
  } satisfies AgentMessageRevertItem);

  assert.deepEqual(result, { toItemId: null, revertDraft: "first message with image", isUserTarget: true });
});

test("assistant_text continues to revert to itself without restoring a draft", () => {
  const result = resolveAgentMessageRevertTarget({
    id: 32,
    prevId: 31,
    kind: "assistant",
    output: { type: "assistant_text", text: "assistant response" }
  } satisfies AgentMessageRevertItem);

  assert.deepEqual(result, { toItemId: 32, revertDraft: "", isUserTarget: false });
});
