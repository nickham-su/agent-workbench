import assert from "node:assert/strict";
import test from "node:test";
import { materializePrimaryBlocks } from "./primary-materializer.js";
import { planCompaction } from "./planner.js";
import { materializeSummaryInputBlock } from "./summary-input-materializer.js";
import { summaryInputToModelMessages } from "./summary-input-to-model-messages.js";
import { testProfile, testSource } from "./test-fixtures.js";

function imageSource(originRunId = "run") {
  const source = testSource({ texts: ["question", "", "latest text"], types: ["user", "assistant", "user"], triggerIndex: null });
  const block = source.blocks[1]!;
  block.message.originRunId = originRunId;
  block.physical.originRunId = originRunId;
  block.message.parts = [{
    id: "call", messageId: block.message.id, position: 0, type: "tool_call", toolName: "view_image",
    input: { path: "repo/screenshot.png" }, providerToolCallId: "provider-call", updatedRevision: 2, createdAt: 2, updatedAt: 2,
  }];
  block.toolExecutions = [{
    id: "execution", callPartId: "call", status: "completed", originRunId,
    imageRef: { type: "image_ref", path: "repo/screenshot.png" },
    resultPreview: "truncated preview must not be used", error: null, startedAt: 2, completedAt: 2,
  }];
  return source;
}

test("compaction plans image tool tail as an authorized path reference, summary prefix only as text", () => {
  const source = imageSource();
  const [first, assistant] = materializePrimaryBlocks({ source, profile: testProfile });
  assert.equal(first!.containsTriggerMedia, false);
  assert.equal(assistant!.containsTriggerMedia, false);
  assert.deepEqual(assistant!.messages.at(-1), { role: "tool", content: [{
    type: "tool-result", toolCallId: "provider-call", toolName: "view_image",
    output: { type: "image_ref", path: "repo/screenshot.png" },
  }] });
  const summary = materializeSummaryInputBlock(source.blocks[1]!);
  const wire = summaryInputToModelMessages([summary]);
  assert.match(JSON.stringify(wire), /provider-call.*repo\/screenshot\.png/);
  assert.equal(JSON.stringify(wire).includes("truncated preview"), false);
  assert.equal(JSON.stringify(wire).includes("image_ref"), false);
  const plan = planCompaction({ source, profile: testProfile, mode: "manual" });
  assert.equal(plan.kind, "no_prefix");
});

test("prior Run tool image becomes path text with the original callId", () => {
  const source = imageSource("earlier-run");
  const assistant = materializePrimaryBlocks({ source, profile: testProfile })[1]!;
  const result = assistant.messages.at(-1);
  assert.match(JSON.stringify(result), /provider-call.*repo\/screenshot\.png/);
  assert.equal(JSON.stringify(result).includes('"image_ref"'), false);
});

test("oversized earlier tool image call enters the summary prefix, never a user-media resend", () => {
  const source = imageSource();
  const block = source.blocks[1]!;
  const part = block.message.parts[0]!;
  if (part.type !== "tool_call") throw new Error("invalid test fixture");
  part.input = { path: "repo/screenshot.png", longDescription: "x".repeat(110_000) };
  const plan = planCompaction({ source, profile: testProfile, mode: "manual" });
  assert.equal(plan.kind, "planned");
  if (plan.kind === "planned") {
    assert.equal(plan.plan.containsTriggerMedia, false);
    assert.ok(plan.plan.prefixSourceBlockIds.includes(block.sourceMessageId));
    assert.match(JSON.stringify(plan.summaryBlocks), /repo\/screenshot\.png/);
    assert.equal(JSON.stringify(plan.summaryBlocks).includes('"image_ref"'), false);
  }
});

test("historical uploaded image is only a trusted path in primary and summary contexts", () => {
  const source = testSource({ texts: ["old", "new"], mediaTrigger: true, triggerIndex: 0 });
  source.triggerMessageId = "m2";
  const historical = materializePrimaryBlocks({ source, profile: testProfile })[0]!;
  assert.match(JSON.stringify(historical.messages), /repo\/screen\.png/);
  assert.equal(JSON.stringify(historical.messages).includes("attachment_ref"), false);
  assert.equal(historical.containsTriggerMedia, false);
  const summary = summaryInputToModelMessages([materializeSummaryInputBlock(source.blocks[0]!)]);
  assert.match(JSON.stringify(summary), /repo\/screen\.png/);
  assert.equal(JSON.stringify(summary).includes("attachment_ref"), false);
});

test("historical uploaded image without a trusted new path never invents one", () => {
  const source = testSource({ texts: ["old", "new"], mediaTrigger: true, triggerIndex: 0 });
  source.triggerMessageId = "m2";
  source.blocks[0]!.attachments[0]!.relativePath = null;
  const primary = materializePrimaryBlocks({ source, profile: testProfile })[0]!;
  assert.match(JSON.stringify(primary), /Historical image 1 has no available Workspace path/);
  const summary = materializeSummaryInputBlock(source.blocks[0]!);
  assert.match(JSON.stringify(summary), /no Workspace path is available/);
  assert.equal(JSON.stringify(summary).includes("repo/screen.png"), false);
});

test("mixed images and failures retain original call positions and only summarize paths", () => {
  const source = imageSource();
  const block = source.blocks[1]!;
  block.message.parts = [...block.message.parts,
    { id: "failed-call", messageId: block.message.id, position: 1, type: "tool_call", toolName: "view_image",
      input: { path: "repo/missing.png" }, providerToolCallId: "failed-id", updatedRevision: 2, createdAt: 2, updatedAt: 2 },
    { id: "second-call", messageId: block.message.id, position: 2, type: "tool_call", toolName: "view_image",
      input: { path: "repo/second.webp" }, providerToolCallId: "second-id", updatedRevision: 2, createdAt: 2, updatedAt: 2 },
  ] as typeof block.message.parts;
  block.toolExecutions.push(
    { id: "failed-execution", callPartId: "failed-call", status: "failed", resultPreview: null, error: "unreadable file", startedAt: 2, completedAt: 2 },
    { id: "second-execution", callPartId: "second-call", status: "completed", originRunId: source.runId,
      imageRef: { type: "image_ref", path: "repo/second.webp" }, resultPreview: "irrelevant", error: null, startedAt: 2, completedAt: 2 },
  );
  const tool = materializePrimaryBlocks({ source, profile: testProfile })[1]!.messages.at(-1);
  if (tool?.role !== "tool") throw new Error("invalid test fixture");
  assert.deepEqual(tool.content.map((part) => [part.toolCallId, part.output.type]), [
    ["provider-call", "image_ref"], ["failed-id", "error-text"], ["second-id", "image_ref"],
  ]);
  const summary = JSON.stringify(summaryInputToModelMessages([materializeSummaryInputBlock(block)]));
  assert.match(summary, /provider-call.*unreadable file.*second-id/);
  assert.equal(summary.includes('"image_ref"'), false);
});

test("legacy visual_analyze text executions remain readable without image media", () => {
  const source = imageSource();
  const block = source.blocks[1]!;
  const call = block.message.parts[0]!;
  if (call.type !== "tool_call") throw new Error("invalid test fixture");
  call.toolName = "visual_analyze";
  block.toolExecutions = [{ id: "execution", callPartId: "call", status: "completed", resultPreview: "old textual description", error: null, startedAt: 2, completedAt: 2 }];
  const result = materializePrimaryBlocks({ source, profile: testProfile })[1]!.messages.at(-1);
  assert.match(JSON.stringify(result), /old textual description/);
  assert.equal(JSON.stringify(result).includes('"image_ref"'), false);
});

test("compaction rejects forged image paths and execution ownership before planning", () => {
  for (const mutate of [
    (source: ReturnType<typeof imageSource>) => { source.blocks[1]!.toolExecutions[0]!.originRunId = "other"; },
    (source: ReturnType<typeof imageSource>) => {
      const execution = source.blocks[1]!.toolExecutions[0]!;
      if (!("imageRef" in execution)) throw new Error("invalid test fixture");
      execution.imageRef = { type: "image_ref", path: "repo/other.png" };
    },
    (source: ReturnType<typeof imageSource>) => { const part = source.blocks[1]!.message.parts[0]!; if (part.type === "tool_call") part.toolName = "read_file"; },
  ]) {
    const source = imageSource();
    mutate(source);
    assert.throws(() => planCompaction({ source, profile: testProfile, mode: "manual" }), /image metadata/);
  }
});
