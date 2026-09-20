import assert from "node:assert/strict";
import test from "node:test";
import { materializeSummaryInputBlock, materializeSummaryInputBlocks } from "./summary-input-materializer.js";
import { testSource } from "./test-fixtures.js";

function assistantSource(status: "completed" | "failed" | "cancelled" | "unknown" | "queued" | "running" = "completed") {
  const source = testSource({ texts: [""], types: ["assistant"] });
  const block = source.blocks[0]!;
  block.message.parts = [
    { id: "reason", messageId: "m1", position: 0, type: "reasoning", text: "reasoning text", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    { id: "text", messageId: "m1", position: 1, type: "text", text: "answer", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    { id: "call", messageId: "m1", position: 2, type: "tool_call", toolName: "read_file", input: { path: "private.ts" }, providerToolCallId: "provider-call", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
  ];
  block.toolExecutions = [{ id: "execution", callPartId: "call", status, resultPreview: status === "completed" ? "result" : null, error: status === "failed" ? "error" : null, startedAt: null, completedAt: null }] as typeof block.toolExecutions;
  block.providerReplay = [{
    partId: "reason",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "reasoning", itemId: "private-item", encryptedContent: "encrypted-secret" } },
  }];
  return source;
}

test("Summary input retains visible semantic content but strips private replay and attachment identity", () => {
  const source = testSource({ texts: ["look"], mediaTrigger: true });
  const result = materializeSummaryInputBlock(source.blocks[0]!);
  assert.deepEqual(result.messages, [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "attachment", mediaType: "image/png", filename: "screen.png" },
  ] }]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("attachmentId"), false);
  assert.equal(serialized.includes("workspaceId"), false);
  assert.equal(serialized.includes("providerReplay"), false);
});

test("Summary input preserves assistant reasoning/tool semantics and all terminal result forms", () => {
  for (const status of ["completed", "failed", "cancelled", "unknown"] as const) {
    const result = materializeSummaryInputBlock(assistantSource(status).blocks[0]!);
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages[0], {
      role: "assistant",
      content: [
        { type: "reasoning", text: "reasoning text" },
        { type: "text", text: "answer" },
        { type: "tool-call", toolName: "read_file", input: { path: "private.ts" } },
      ],
    });
    assert.equal(result.messages[1]!.role, "tool");
    assert.equal(JSON.stringify(result).includes("encrypted-secret"), false);
    assert.equal(JSON.stringify(result).includes("private-item"), false);
  }
});

test("Summary tool results preserve the transcript's preview and error fallback semantics", () => {
  const cases = [
    { status: "completed", error: null, preview: " ", expected: { type: "text", value: "工具调用已成功完成，但未返回文本结果。" } },
    { status: "failed", error: null, preview: " preview ", expected: { type: "error-text", value: "preview" } },
    { status: "failed", error: null, preview: null, expected: { type: "error-text", value: "工具调用失败，未提供额外错误信息。" } },
    { status: "cancelled", error: null, preview: " preview ", expected: { type: "text", value: "preview" } },
    { status: "cancelled", error: " error ", preview: "preview", expected: { type: "error-text", value: "error" } },
    { status: "cancelled", error: null, preview: null, expected: { type: "text", value: "工具调用在执行前被取消，未执行" } },
    { status: "unknown", error: null, preview: " preview ", expected: { type: "error-text", value: "Tool execution outcome is unknown because the runtime was interrupted.\nThe operation may or may not have completed and may have produced side effects.\nInspect the current workspace state before deciding whether to retry or take another action.\n\nReliable result preview:\npreview" } },
  ] as const;
  for (const fixture of cases) {
    const source = assistantSource(fixture.status);
    source.blocks[0]!.toolExecutions[0] = { ...source.blocks[0]!.toolExecutions[0]!, error: fixture.error, resultPreview: fixture.preview };
    const result = materializeSummaryInputBlock(source.blocks[0]!);
    const tool = result.messages[1]!;
    assert.equal(tool.role, "tool");
    const part = tool.content[0]!;
    assert.equal(part.type, "tool-result");
    if (part.type === "tool-result") assert.deepEqual(part.output, fixture.expected);
  }
});

test("Summary input emits a fixed placeholder for replay-only assistant and fails closed on incomplete tools", () => {
  const replayOnly = testSource({ texts: [""], types: ["assistant"] });
  replayOnly.blocks[0]!.message.parts = [{ id: "reason", messageId: "m1", position: 0, type: "reasoning", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  replayOnly.blocks[0]!.providerReplay = [{
    partId: "reason",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "reasoning", itemId: "item", encryptedContent: "encrypted" } },
  }];
  assert.deepEqual(materializeSummaryInputBlock(replayOnly.blocks[0]!).messages, [{
    role: "assistant",
    content: [{ type: "text", text: "[Prior assistant replay state omitted from summary input]" }],
  }]);

  const emptyTextReplay = testSource({ texts: [""], types: ["assistant"] });
  emptyTextReplay.blocks[0]!.message.parts = [{ id: "empty", messageId: "m1", position: 0, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  emptyTextReplay.blocks[0]!.providerReplay = [{
    partId: "empty",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "empty-item" } },
  }];
  const ignored = materializeSummaryInputBlock(emptyTextReplay.blocks[0]!);
  assert.deepEqual(ignored.messages, []);
  assert.equal(ignored.isProjectionEmpty, true);

  for (const status of ["queued", "running"] as const) {
    assert.throws(() => materializeSummaryInputBlock(assistantSource(status).blocks[0]!), /incomplete tool execution/);
  }
  const missing = assistantSource();
  missing.blocks[0]!.toolExecutions = [];
  assert.throws(() => materializeSummaryInputBlock(missing.blocks[0]!), /tool-call and execution set mismatch/);
  const duplicate = assistantSource();
  duplicate.blocks[0]!.toolExecutions.push({ ...duplicate.blocks[0]!.toolExecutions[0]!, id: "duplicate" });
  assert.throws(() => materializeSummaryInputBlock(duplicate.blocks[0]!), /duplicate tool execution/);
});

test("Summary input preserves source order without Worker history reads", () => {
  const source = testSource({ texts: ["first", "second"], types: ["user", "compaction"] });
  assert.deepEqual(materializeSummaryInputBlocks(source.blocks).map((block) => block.sourceBlockId), ["m1", "m2"]);
});
