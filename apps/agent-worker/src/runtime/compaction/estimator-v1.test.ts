import assert from "node:assert/strict";
import test from "node:test";
import { estimatePrimaryMaterializedBlock, estimatePrimaryMaterializedBlocks } from "./estimator-v1.js";
import { materializePrimaryBlocks } from "./primary-materializer.js";
import { testProfile, testSource } from "./test-fixtures.js";
import type { PrimaryMaterializedBlock } from "./types.js";

function block(messages: PrimaryMaterializedBlock["messages"]): PrimaryMaterializedBlock {
  return {
    sourceBlockId: "source",
    sourceMessageType: "user",
    messages,
    isProjectionEmpty: messages.length === 0,
    canStartRetainedTail: true,
    containsTriggerMedia: false,
  };
}

function assertGolden(messages: PrimaryMaterializedBlock["messages"], expected: {
  canonicalMessages: unknown;
  canonicalJson: string;
  utf8Bytes: number;
  textTokens: number;
  messageCount: number;
  contentPartCount: number;
  toolCallCount: number;
  toolResultCount: number;
  attachmentCount: number;
  replayEncryptedExtra: number;
  fixedCosts: number;
  estimatedTokens: number;
}) {
  const actual = estimatePrimaryMaterializedBlock(block(messages));
  assert.deepEqual(actual.canonicalMessages, expected.canonicalMessages);
  assert.equal(actual.canonicalJson, expected.canonicalJson);
  assert.deepEqual({
    utf8Bytes: actual.utf8Bytes,
    textTokens: actual.textTokens,
    messageCount: actual.messageCount,
    contentPartCount: actual.contentPartCount,
    toolCallCount: actual.toolCallCount,
    toolResultCount: actual.toolResultCount,
    attachmentCount: actual.attachmentCount,
    replayEncryptedExtra: actual.replayEncryptedExtra,
    fixedCosts: actual.fixedCosts,
    estimatedTokens: actual.estimatedTokens,
  }, {
    utf8Bytes: expected.utf8Bytes,
    textTokens: expected.textTokens,
    messageCount: expected.messageCount,
    contentPartCount: expected.contentPartCount,
    toolCallCount: expected.toolCallCount,
    toolResultCount: expected.toolResultCount,
    attachmentCount: expected.attachmentCount,
    replayEncryptedExtra: expected.replayEncryptedExtra,
    fixedCosts: expected.fixedCosts,
    estimatedTokens: expected.estimatedTokens,
  });
}

test("EstimatorV1 golden matrix maps simple roles, assistant forms, Unicode and attachment metadata", () => {
  const cases: Array<Parameters<typeof assertGolden>> = [
    [[{ role: "system", content: "You are helpful." }], {
      canonicalMessages: [{ role: "system", content: "You are helpful." }],
      canonicalJson: '[{"content":"You are helpful.","role":"system"}]', utf8Bytes: 48, textTokens: 16,
      messageCount: 1, contentPartCount: 0, toolCallCount: 0, toolResultCount: 0, attachmentCount: 0, replayEncryptedExtra: 0, fixedCosts: 8, estimatedTokens: 27,
    }],
    [[{ role: "user", content: "修复 build error" }], {
      canonicalMessages: [{ role: "user", content: "修复 build error" }],
      canonicalJson: '[{"content":"修复 build error","role":"user"}]', utf8Bytes: 48, textTokens: 16,
      messageCount: 1, contentPartCount: 0, toolCallCount: 0, toolResultCount: 0, attachmentCount: 0, replayEncryptedExtra: 0, fixedCosts: 8, estimatedTokens: 27,
    }],
    [[{ role: "user", content: [
      { type: "text", text: "请看截图" },
      { type: "attachment_ref", workspaceId: "ws", attachmentId: "secret", mediaType: "image/png", filename: "private.png" },
      { type: "attachment_ref", workspaceId: "ws", attachmentId: "another", mediaType: "image/jpeg", filename: "other.jpg" },
    ] }], {
      canonicalMessages: [{ role: "user", content: [
        { type: "text", text: "请看截图" },
        { type: "attachment_ref", mediaType: "image/png", filename: "<filename>" },
        { type: "attachment_ref", mediaType: "image/jpeg", filename: "<filename>" },
      ] }],
      canonicalJson: '[{"content":[{"text":"请看截图","type":"text"},{"filename":"<filename>","mediaType":"image/png","type":"attachment_ref"},{"filename":"<filename>","mediaType":"image/jpeg","type":"attachment_ref"}],"role":"user"}]', utf8Bytes: 216, textTokens: 72,
      messageCount: 1, contentPartCount: 3, toolCallCount: 0, toolResultCount: 0, attachmentCount: 2, replayEncryptedExtra: 0, fixedCosts: 2068, estimatedTokens: 2354,
    }],
    [[{ role: "assistant", content: "answer" }], {
      canonicalMessages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }],
      canonicalJson: '[{"content":[{"text":"answer","type":"text"}],"role":"assistant"}]', utf8Bytes: 66, textTokens: 22,
      messageCount: 1, contentPartCount: 1, toolCallCount: 0, toolResultCount: 0, attachmentCount: 0, replayEncryptedExtra: 0, fixedCosts: 12, estimatedTokens: 38,
    }],
    [[{ role: "assistant", content: [] }], {
      canonicalMessages: [{ role: "assistant", content: [] }],
      canonicalJson: '[{"content":[],"role":"assistant"}]', utf8Bytes: 35, textTokens: 12,
      messageCount: 1, contentPartCount: 0, toolCallCount: 0, toolResultCount: 0, attachmentCount: 0, replayEncryptedExtra: 0, fixedCosts: 8, estimatedTokens: 22,
    }],
    [[{ role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "error-text", value: "坏了" } }] }], {
      canonicalMessages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "error-text", value: "坏了" } }] }],
      canonicalJson: '[{"content":[{"output":{"type":"error-text","value":"坏了"},"toolCallId":"call_1","toolName":"read","type":"tool-result"}],"role":"tool"}]', utf8Bytes: 140, textTokens: 47,
      messageCount: 1, contentPartCount: 1, toolCallCount: 0, toolResultCount: 1, attachmentCount: 0, replayEncryptedExtra: 0, fixedCosts: 20, estimatedTokens: 74,
    }],
  ];
  for (const [messages, expected] of cases) assertGolden(messages, expected);
});

test("EstimatorV1 golden matrix canonicalizes every compatible replay form without summaryIndex", () => {
  const provider = { npm: "@ai-sdk/openai" as const, api: "responses" as const, providerId: "openai", model: "gpt-5" };
  const messages: PrimaryMaterializedBlock["messages"] = [{ role: "assistant", content: [
    { type: "reasoning", text: "先检查类型。", providerReplay: { provider, item: { type: "reasoning", itemId: "rs_1", encryptedContent: "密文🔒", summaryIndex: 3 } } },
    { type: "text", text: "开始读取。", providerReplay: { provider, item: { type: "text", itemId: "txt_1", phase: "commentary" } } },
    { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { z: [3, "值"], a: { nested: true } }, providerReplay: { provider, item: { type: "function_call", itemId: "fc_1" } } },
  ] }];
  const expectedCanonicalMessages = [{ role: "assistant", content: [
    { type: "reasoning", text: "先检查类型。", replay: { provider, item: { type: "reasoning", itemId: "rs_1", encryptedContent: "<encrypted>" } } },
    { type: "text", text: "开始读取。", replay: { provider, item: { type: "text", itemId: "txt_1", phase: "commentary" } } },
    { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { a: { nested: true }, z: [3, "值"] }, replay: { provider, item: { type: "function_call", itemId: "fc_1" } } },
  ] }];
  assertGolden(messages, {
    canonicalMessages: expectedCanonicalMessages,
    canonicalJson: '[{"content":[{"replay":{"item":{"encryptedContent":"<encrypted>","itemId":"rs_1","type":"reasoning"},"provider":{"api":"responses","model":"gpt-5","npm":"@ai-sdk/openai","providerId":"openai"}},"text":"先检查类型。","type":"reasoning"},{"replay":{"item":{"itemId":"txt_1","phase":"commentary","type":"text"},"provider":{"api":"responses","model":"gpt-5","npm":"@ai-sdk/openai","providerId":"openai"}},"text":"开始读取。","type":"text"},{"input":{"a":{"nested":true},"z":[3,"值"]},"replay":{"item":{"itemId":"fc_1","type":"function_call"},"provider":{"api":"responses","model":"gpt-5","npm":"@ai-sdk/openai","providerId":"openai"}},"toolCallId":"call_1","toolName":"read","type":"tool-call"}],"role":"assistant"}]',
    utf8Bytes: 724, textTokens: 242, messageCount: 1, contentPartCount: 3, toolCallCount: 1, toolResultCount: 0,
    attachmentCount: 0, replayEncryptedExtra: 67, fixedCosts: 95, estimatedTokens: 371,
  });
  const estimate = estimatePrimaryMaterializedBlock(block(messages));
  assert.equal(estimate.canonicalJson.includes("summaryIndex"), false);
  assert.equal(estimate.canonicalJson.includes("密文"), false);
});

test("EstimatorV1 canonicalizes an array root and calculates one block ceiling", () => {
  const fixture = block([{
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } }],
  }, {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "ok" } }],
  }]);
  const result = estimatePrimaryMaterializedBlock(fixture);
  assert.equal(result.canonicalJson, '[{"content":[{"input":{"path":"a.ts"},"toolCallId":"call_1","toolName":"read","type":"tool-call"}],"role":"assistant"},{"content":[{"output":{"type":"text","value":"ok"},"toolCallId":"call_1","toolName":"read","type":"tool-result"}],"role":"tool"}]');
  assert.equal(result.utf8Bytes, 248);
  assert.equal(result.textTokens, 83);
  assert.equal(result.fixedCosts, 40);
  assert.equal(result.estimatedTokens, 136);
});

test("EstimatorV1 counts attachments from metadata without reading bytes", () => {
  const result = estimatePrimaryMaterializedBlock(block([{
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "attachment_ref", workspaceId: "ws", attachmentId: "secret-attachment", mediaType: "image/png", filename: "private.png" },
    ],
  }]));
  assert.match(result.canonicalJson, /"filename":"<filename>"/);
  assert.equal(result.canonicalJson.includes("secret-attachment"), false);
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.fixedCosts, 8 + 2 * 4 + 1024);
});

test("EstimatorV1 only prices compatible replay and never emits encrypted content", () => {
  const replay = {
    provider: { npm: "@ai-sdk/openai" as const, api: "responses" as const, providerId: "openai", model: "gpt-5" },
    item: { type: "reasoning" as const, itemId: "rs_1", encryptedContent: "actual-encrypted-secret" },
  };
  const result = estimatePrimaryMaterializedBlock(block([{
    role: "assistant",
    content: [{ type: "reasoning", text: "think", providerReplay: replay }],
  }]));
  assert.equal(result.canonicalJson.includes("actual-encrypted-secret"), false);
  assert.match(result.canonicalJson, /"encryptedContent":"<encrypted>"/);
  assert.equal(result.replayEncryptedExtra, 64 + Math.ceil(new TextEncoder().encode("actual-encrypted-secret").byteLength / 4));
});

test("EstimatorV1 ignores unknown provider options because Primary has no generic provider options", () => {
  const first = block([{ role: "assistant", content: [{ type: "text", text: "answer" }] }]);
  const second = structuredClone(first) as PrimaryMaterializedBlock;
  assert.deepEqual(estimatePrimaryMaterializedBlock(first), estimatePrimaryMaterializedBlock(second));
});

test("EstimatorV1 rejects non JSON tool inputs and sums independently rounded blocks", () => {
  assert.throws(() => estimatePrimaryMaterializedBlock(block([{
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: { invalid: Number.NaN } }],
  }])));
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => estimatePrimaryMaterializedBlock(block([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: { cyclic } }] }])));
  for (const invalid of [undefined, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, () => null, Symbol("tool"), new Date()] as const) {
    assert.throws(() => estimatePrimaryMaterializedBlock(block([{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: { invalid } as Record<string, unknown> }],
    }])));
  }
  const ordered = block([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: { z: ["first", "second"], a: 1 } }] }]);
  assert.match(estimatePrimaryMaterializedBlock(ordered).canonicalJson, /"input":\{"a":1,"z":\["first","second"\]\}/);
  const first = block([{ role: "user", content: "a" }]);
  const second = block([{ role: "user", content: "b" }]);
  assert.equal(
    estimatePrimaryMaterializedBlocks([first, second]),
    estimatePrimaryMaterializedBlock(first).estimatedTokens + estimatePrimaryMaterializedBlock(second).estimatedTokens,
  );
});

test("EstimatorV1 gives projection-empty blocks exactly zero cost", () => {
  const result = estimatePrimaryMaterializedBlock({
    sourceBlockId: "empty",
    sourceMessageType: "assistant",
    messages: [],
    isProjectionEmpty: true,
    canStartRetainedTail: false,
    containsTriggerMedia: false,
  });
  assert.equal(result.estimatedTokens, 0);
  assert.equal(result.fixedCosts, 0);
  assert.equal(result.canonicalJson, "[]");
});

test("EstimatorV1 gives an empty text replay-only Primary block zero cost for official and non-OpenAI profiles", () => {
  const source = testSource({ texts: [""], types: ["assistant"] });
  source.blocks[0]!.message.parts = [{ id: "empty", messageId: "m1", position: 0, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  source.blocks[0]!.providerReplay = [{
    partId: "empty",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "empty-item" } },
  }];
  for (const profile of [testProfile, { ...testProfile, provider: { ...testProfile.provider, npm: "@ai-sdk/openai-compatible" as const } }]) {
    const primary = materializePrimaryBlocks({ source, profile })[0]!;
    const result = estimatePrimaryMaterializedBlock(primary);
    assert.equal(primary.isProjectionEmpty, true);
    assert.equal(result.estimatedTokens, 0);
  }
});
