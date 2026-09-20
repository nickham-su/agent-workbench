import assert from "node:assert/strict";
import test from "node:test";
import { materializePrimaryBlocks } from "./primary-materializer.js";
import { testProfile, testSource } from "./test-fixtures.js";

function assistantToolSource(status: "completed" | "failed" | "cancelled" | "unknown" | "queued" | "running" = "completed") {
  const source = testSource({ texts: ["question", ""], types: ["user", "assistant"] });
  const assistant = source.blocks[1]!;
  assistant.message.parts = [
    { id: "reason", messageId: "m2", position: 0, type: "reasoning", text: "analysis", updatedRevision: 2, createdAt: 2, updatedAt: 2 },
    { id: "text", messageId: "m2", position: 1, type: "text", text: "answer", updatedRevision: 2, createdAt: 2, updatedAt: 2 },
    { id: "call", messageId: "m2", position: 2, type: "tool_call", toolName: "read_file", input: { path: "a.ts" }, providerToolCallId: "provider-call", updatedRevision: 2, createdAt: 2, updatedAt: 2 },
  ];
  assistant.toolExecutions = [{ id: "execution", callPartId: "call", status, resultPreview: status === "completed" ? "contents" : null, error: status === "failed" ? "failed" : null, startedAt: null, completedAt: null }] as typeof assistant.toolExecutions;
  return source;
}

test("Primary materializer preserves trigger attachment references without reading bytes and replaces historical images", () => {
  const source = testSource({ texts: ["older", "now"], mediaTrigger: true });
  source.blocks[0]!.message = { ...source.blocks[0]!.message, parts: [...source.blocks[0]!.message.parts,
    { id: "old-image", messageId: "m1", position: 1, type: "image", attachmentId: "old-secret", mediaType: "image/jpeg", filename: "old.jpg", updatedRevision: 1, createdAt: 1, updatedAt: 1 }],
  } as typeof source.blocks[number]["message"];
  source.blocks[0]!.attachments.push({ partId: "old-image", attachmentId: "old-secret", mediaType: "image/jpeg", filename: "old.jpg" });
  const [historical, trigger] = materializePrimaryBlocks({ source, profile: testProfile });
  assert.deepEqual(historical!.messages, [{ role: "user", content: "older\n\n[This user message included 1 image attachment(s). Their image contents are not included in this run.]" }]);
  assert.deepEqual(trigger!.messages, [{ role: "user", content: [
    { type: "text", text: "now" },
    { type: "attachment_ref", workspaceId: "ws", attachmentId: "attachment", mediaType: "image/png", filename: "screen.png" },
  ] }]);
  assert.equal(trigger!.containsTriggerMedia, true);
  assert.equal(JSON.stringify(trigger).includes("bytes"), false);
});

test("Primary matches PromptContext base visibility: plain reasoning and empty text do not enter", () => {
  const source = testSource({ texts: [""], types: ["assistant"] });
  source.blocks[0]!.message.parts = [
    { id: "reason", messageId: "m1", position: 0, type: "reasoning", text: "plain reasoning", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    { id: "empty", messageId: "m1", position: 1, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
  ];
  const privateCipher = "worker-private-cipher";
  const block = materializePrimaryBlocks({ source, profile: testProfile })[0]!;
  assert.deepEqual(block.messages, []);
  assert.equal(block.isProjectionEmpty, true);
  assert.equal(block.canStartRetainedTail, false);
  source.blocks[0]!.providerReplay = [{
    partId: "reason",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "reasoning", itemId: "item", encryptedContent: privateCipher } },
  }];
  const replayed = materializePrimaryBlocks({ source, profile: testProfile })[0]!;
  assert.equal(replayed.isProjectionEmpty, false);
  assert.equal(replayed.canStartRetainedTail, true);
  assert.equal(JSON.stringify(replayed).includes(privateCipher), true);
});

test("Primary accepts but ignores empty text replay for every profile", () => {
  const source = testSource({ texts: [""], types: ["assistant"] });
  source.blocks[0]!.message.parts = [{ id: "empty", messageId: "m1", position: 0, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  source.blocks[0]!.providerReplay = [{
    partId: "empty",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "empty-item" } },
  }];
  const profiles = [testProfile, { ...testProfile, provider: { ...testProfile.provider, npm: "@ai-sdk/openai-compatible" as const } }];
  for (const profile of profiles) {
    const block = materializePrimaryBlocks({ source, profile })[0]!;
    assert.deepEqual(block.messages, []);
    assert.equal(block.isProjectionEmpty, true);
    assert.equal(block.canStartRetainedTail, false);
  }
});

test("Primary matches RuntimeTranscript assistant string-versus-array shape", () => {
  const source = testSource({ texts: ["answer"], types: ["assistant"] });
  assert.deepEqual(materializePrimaryBlocks({ source, profile: testProfile })[0]!.messages, [{ role: "assistant", content: "answer" }]);

  source.blocks[0]!.providerReplay = [{
    partId: "p1",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "text-item" } },
  }];
  const replay = source.blocks[0]!.providerReplay[0]!.envelope;
  assert.deepEqual(materializePrimaryBlocks({ source, profile: testProfile })[0]!.messages, [{ role: "assistant", content: [{
    type: "text", text: "answer", providerReplay: { provider: replay.provider, item: replay.item },
  }] }]);

  source.blocks[0]!.message.parts = [...source.blocks[0]!.message.parts, { id: "second", messageId: "m1", position: 1, type: "text", text: "second", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  source.blocks[0]!.providerReplay = [];
  const multiPart = materializePrimaryBlocks({ source, profile: testProfile })[0]!.messages[0]!;
  assert.equal(multiPart.role, "assistant");
  assert.equal(Array.isArray(multiPart.content), true);
});

test("Primary base projection is byte-for-byte equivalent to the real RuntimeTranscriptProjector fixture", async () => {
  const source = assistantToolSource("unknown");
  const { RuntimeTranscriptProjector } = await import(new URL(
    "../../../../api/src/modules/agent/read-side/runtime-transcript-projector.ts",
    import.meta.url,
  ).href);
  const transcript = new RuntimeTranscriptProjector().project({
    workspaceId: source.workspaceId,
    triggerMessageId: source.triggerMessageId,
    messages: source.blocks.map((block) => block.message),
    executions: source.blocks.flatMap((block) => block.toolExecutions.map((execution) => ({
      callPartId: execution.callPartId,
      status: execution.status,
      resultPreview: execution.resultPreview,
      error: execution.error,
    }))),
  });
  const primary = materializePrimaryBlocks({ source, profile: testProfile }).flatMap((block) => block.messages);
  assert.deepEqual(primary, transcript);
});

test("Primary compatible replay has the same visible ordering and identity semantics as applyOpenAiResponsesReplay", async () => {
  const source = assistantToolSource();
  source.blocks[1]!.providerReplay = [
    { partId: "reason", envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "reasoning", itemId: "rs_1", encryptedContent: "cipher" } } },
    { partId: "text", envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "txt_1", phase: "final_answer" } } },
    { partId: "call", envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "function_call", itemId: "fc_1" } } },
  ];
  const { RuntimeTranscriptProjector } = await import(new URL(
    "../../../../api/src/modules/agent/read-side/runtime-transcript-projector.ts",
    import.meta.url,
  ).href);
  const { applyOpenAiResponsesReplay } = await import("../providers/openai-responses-replay.js");
  const base = new RuntimeTranscriptProjector().projectDetailed({
    workspaceId: source.workspaceId,
    triggerMessageId: source.triggerMessageId,
    messages: source.blocks.map((block) => block.message),
    executions: source.blocks.flatMap((block) => block.toolExecutions.map((execution) => ({ callPartId: execution.callPartId, status: execution.status, resultPreview: execution.resultPreview, error: execution.error }))),
  });
  const sourceReplay = [{ assistantOrdinal: base.assistantMessageIndexes.get("m2")!, parts: [
    { visibleIndex: 0, type: "reasoning" as const, text: "analysis", providerReplay: source.blocks[1]!.providerReplay[0]!.envelope },
    { visibleIndex: 0, type: "text" as const, providerReplay: source.blocks[1]!.providerReplay[1]!.envelope },
    { visibleIndex: 1, type: "tool_call" as const, providerReplay: source.blocks[1]!.providerReplay[2]!.envelope },
  ] }];
  const replayed = applyOpenAiResponsesReplay({ profile: testProfile, messages: base.messages, source: sourceReplay });
  const primaryAssistant = materializePrimaryBlocks({ source, profile: testProfile })[1]!.messages[0]!;
  assert.equal(primaryAssistant.role, "assistant");
  const replayedAssistant = replayed[1]!;
  assert.equal(replayedAssistant.role, "assistant");
  assert.equal(Array.isArray(replayedAssistant.content), true);
  if (!Array.isArray(replayedAssistant.content) || !Array.isArray(primaryAssistant.content)) return;
  assert.deepEqual(primaryAssistant.content.map((part) => part.type), ["reasoning", "text", "tool-call"]);
  assert.deepEqual(replayedAssistant.content.map((part) => part.type), ["reasoning", "text", "tool-call"]);
  const primaryItemIds = primaryAssistant.content.map((part) => "providerReplay" in part ? part.providerReplay?.item.itemId : undefined);
  assert.deepEqual(primaryItemIds, ["rs_1", "txt_1", "fc_1"]);
  const replayedItemIds = replayedAssistant.content.map((part) => {
    const options = part.providerOptions?.openai;
    return options && typeof options === "object" && "itemId" in options ? options.itemId : undefined;
  });
  assert.deepEqual(replayedItemIds, ["rs_1", "txt_1", "fc_1"]);
});

test("Primary empty text replay stays absent from real PromptContext replay", async () => {
  const source = testSource({ texts: [""], types: ["assistant"] });
  source.blocks[0]!.message.parts = [{ id: "empty", messageId: "m1", position: 0, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  source.blocks[0]!.providerReplay = [{
    partId: "empty",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "empty-item" } },
  }];
  const { RuntimeTranscriptProjector } = await import(new URL(
    "../../../../api/src/modules/agent/read-side/runtime-transcript-projector.ts",
    import.meta.url,
  ).href);
  const { applyOpenAiResponsesReplay } = await import("../providers/openai-responses-replay.js");
  const base = new RuntimeTranscriptProjector().projectDetailed({
    workspaceId: source.workspaceId, triggerMessageId: source.triggerMessageId,
    messages: [source.blocks[0]!.message], executions: [],
  });
  assert.deepEqual(base.messages, []);
  assert.deepEqual(applyOpenAiResponsesReplay({ profile: testProfile, messages: base.messages, source: [] }), []);
  assert.deepEqual(materializePrimaryBlocks({ source, profile: testProfile })[0]!.messages, []);
});

test("Primary materializer keeps assistant/tool execution atomically and projects every terminal outcome", () => {
  for (const status of ["completed", "failed", "cancelled", "unknown"] as const) {
    const block = materializePrimaryBlocks({ source: assistantToolSource(status), profile: testProfile })[1]!;
    assert.equal(block.messages.length, 2);
    assert.equal(block.messages[0]!.role, "assistant");
    assert.equal(block.messages[1]!.role, "tool");
    const tool = block.messages[1]!;
    assert.equal(tool.role, "tool");
    assert.equal(tool.content[0]!.toolCallId, "provider-call");
    assert.equal(block.canStartRetainedTail, true);
  }
});

test("Primary tool results exactly follow transcript status fallbacks", () => {
  const cases = [
    { status: "completed", error: null, preview: "  preview  ", expected: { type: "text", value: "preview" } },
    { status: "completed", error: null, preview: " ", expected: { type: "text", value: "工具调用已成功完成，但未返回文本结果。" } },
    { status: "failed", error: "  error  ", preview: "preview", expected: { type: "error-text", value: "error" } },
    { status: "failed", error: null, preview: "  preview  ", expected: { type: "error-text", value: "preview" } },
    { status: "failed", error: null, preview: null, expected: { type: "error-text", value: "工具调用失败，未提供额外错误信息。" } },
    { status: "cancelled", error: "  error  ", preview: "preview", expected: { type: "error-text", value: "error" } },
    { status: "cancelled", error: null, preview: "  preview  ", expected: { type: "text", value: "preview" } },
    { status: "cancelled", error: null, preview: null, expected: { type: "text", value: "工具调用在执行前被取消，未执行" } },
    { status: "unknown", error: null, preview: "  preview  ", expected: { type: "error-text", value: "Tool execution outcome is unknown because the runtime was interrupted.\nThe operation may or may not have completed and may have produced side effects.\nInspect the current workspace state before deciding whether to retry or take another action.\n\nReliable result preview:\npreview" } },
    { status: "unknown", error: null, preview: null, expected: { type: "error-text", value: "Tool execution outcome is unknown because the runtime was interrupted.\nThe operation may or may not have completed and may have produced side effects.\nInspect the current workspace state before deciding whether to retry or take another action." } },
  ] as const;
  for (const fixture of cases) {
    const source = assistantToolSource(fixture.status);
    source.blocks[1]!.toolExecutions[0] = { ...source.blocks[1]!.toolExecutions[0]!, error: fixture.error, resultPreview: fixture.preview };
    const tool = materializePrimaryBlocks({ source, profile: testProfile })[1]!.messages[1]!;
    assert.equal(tool.role, "tool");
    assert.deepEqual(tool.content[0]!.output, fixture.expected);
  }
});

test("Primary materializer fails closed for missing, queued, running, and duplicate tool executions", () => {
  for (const status of ["queued", "running"] as const) {
    assert.throws(() => materializePrimaryBlocks({ source: assistantToolSource(status), profile: testProfile }), /incomplete tool execution/);
  }
  const missing = assistantToolSource();
  missing.blocks[1]!.toolExecutions = [];
  assert.throws(() => materializePrimaryBlocks({ source: missing, profile: testProfile }), /tool-call and execution set mismatch/);
  const duplicate = assistantToolSource();
  duplicate.blocks[1]!.toolExecutions.push({ ...duplicate.blocks[1]!.toolExecutions[0]!, id: "second" });
  assert.throws(() => materializePrimaryBlocks({ source: duplicate, profile: testProfile }), /duplicate tool execution/);
});

test("Primary materializer requires an exact image, tool execution, and replay relation", () => {
  const unmatchedExecution = testSource();
  unmatchedExecution.blocks[0]!.toolExecutions = [{ id: "extra", callPartId: "none", status: "completed", resultPreview: null, error: null, startedAt: null, completedAt: null }];
  assert.throws(() => materializePrimaryBlocks({ source: unmatchedExecution, profile: testProfile }), /tool-call state outside/);

  const runtime = testSource();
  runtime.blocks[0]!.message = { ...runtime.blocks[0]!.message, type: "runtime" } as typeof runtime.blocks[number]["message"];
  assert.throws(() => materializePrimaryBlocks({ source: runtime, profile: testProfile }), /runtime message/);

  const badImage = testSource({ mediaTrigger: true });
  badImage.blocks[2]!.attachments[0] = { ...badImage.blocks[2]!.attachments[0]!, filename: "mismatch.png" };
  assert.throws(() => materializePrimaryBlocks({ source: badImage, profile: testProfile }), /does not match/);

  const nonAssistantReplay = testSource();
  nonAssistantReplay.blocks[0]!.providerReplay = [{
    partId: "p1",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "item" } },
  }];
  assert.throws(() => materializePrimaryBlocks({ source: nonAssistantReplay, profile: testProfile }), /provider replay outside/);

  const wrongReplayType = assistantToolSource();
  wrongReplayType.blocks[1]!.providerReplay = [{
    partId: "text",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "function_call", itemId: "item" } },
  }];
  assert.throws(() => materializePrimaryBlocks({ source: wrongReplayType, profile: testProfile }), /matching assistant part/);
});

test("Primary materializer only retains compatible official OpenAI replay", () => {
  const source = assistantToolSource();
  source.blocks[1]!.providerReplay = [{
    partId: "reason",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "reasoning", itemId: "reason-item", encryptedContent: "encrypted" } },
  }, {
    partId: "text",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "other", model: "gpt-5" }, item: { type: "text", itemId: "text-item" } },
  }, {
    partId: "call",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "function_call", itemId: "call-item" } },
  }];
  const content = materializePrimaryBlocks({ source, profile: testProfile })[1]!.messages[0]!;
  assert.equal(content.role, "assistant");
  assert.equal(Array.isArray(content.content), true);
  if (!Array.isArray(content.content)) return;
  assert.equal(content.content[0]!.type, "reasoning");
  assert.equal("providerReplay" in content.content[0]!, true);
  assert.equal("providerReplay" in content.content[1]!, false);
  assert.equal("providerReplay" in content.content[2]!, true);

  const compatibleProfile = { ...testProfile, provider: { ...testProfile.provider, npm: "@ai-sdk/openai-compatible" as const } };
  const withoutReplay = materializePrimaryBlocks({ source, profile: compatibleProfile })[1]!.messages[0]!;
  assert.equal(JSON.stringify(withoutReplay).includes("encrypted"), false);
});

test("Primary materializer refuses a source that includes its pending boundary", () => {
  const source = testSource({ pending: true });
  source.blocks[1]!.sourceMessageId = "pending";
  assert.throws(() => materializePrimaryBlocks({ source, profile: testProfile }), /pending boundary/);
});
