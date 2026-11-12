import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_QUEUE_INPUT_POLICY_VERSION } from "@agent-workbench/shared";
import { estimatePrimaryMaterializedBlock } from "./estimator-v1.js";
import { COMPACTION_MODE_POLICIES, computeCompactionProfileFingerprint, planCompaction } from "./planner.js";
import { materializePrimaryBlocks } from "./primary-materializer.js";
import { addAssistantReplay, testProfile, testSource } from "./test-fixtures.js";

function plannedSource() {
  return testSource({ texts: ["old ".repeat(14_000), "recent ".repeat(6_000), "trigger"] });
}

test("planner freezes the complete source split, costs, coordinates and non-wire plan identity", () => {
  const result = planCompaction({ source: plannedSource(), profile: testProfile, mode: "manual" });
  assert.equal(result.kind, "planned");
  if (result.kind !== "planned") return;
  assert.equal(result.plan.planId.length > 0, true);
  assert.equal(result.plan.estimatorVersion, "estimator-v1");
  assert.equal(result.plan.primaryMaterializerVersion, "primary-materializer-v1");
  assert.equal(result.plan.summaryInputMaterializerVersion, "summary-input-materializer-v1");
  assert.equal(result.plan.expectedHeadMessageId, "m3");
  assert.equal(result.plan.expectedRevision, 7);
  assert.deepEqual(result.plan.resolvedSourceBlockIds, ["m1", "m2", "m3"]);
  assert.deepEqual(result.plan.prefixSourceBlockIds, ["m1"]);
  assert.deepEqual(result.plan.retainedSourceBlockIds, ["m2", "m3"]);
  assert.equal(result.plan.retainedFromMessageId, "m2");
  assert.equal(result.plan.estimatedBeforeCost, result.plan.estimatedPrefixCost + result.plan.estimatedRetainedCost);
  assert.equal(result.plan.profileFingerprint.includes("secret"), false);
  assert.equal(result.plan.profileFingerprint.length, 64);
  assert.equal(result.plan.modePolicy, COMPACTION_MODE_POLICIES.manual);
  assert.equal(JSON.stringify(result.plan).includes("providerOptions"), false);
  assert.equal(JSON.stringify(result.plan).includes("attachment_ref"), false);
});

test("planner enforces exact 20k boundary and rejects 20,001 tail", () => {
  const exact = testSource({ texts: ["prefix", "x".repeat(54_489)] });
  const exactTail = materializePrimaryBlocks({ source: exact, profile: testProfile })[1]!;
  assert.equal(estimatePrimaryMaterializedBlock(exactTail).estimatedTokens, 20_000);
  const exactResult = planCompaction({ source: exact, profile: testProfile, mode: "manual" });
  assert.equal(exactResult.kind, "planned");
  if (exactResult.kind === "planned") assert.deepEqual(exactResult.plan.retainedSourceBlockIds, ["m2"]);

  const oversizedTail = testSource({ texts: ["prefix", "x".repeat(54_490)] });
  const oversizedPrimary = materializePrimaryBlocks({ source: oversizedTail, profile: testProfile })[1]!;
  assert.equal(estimatePrimaryMaterializedBlock(oversizedPrimary).estimatedTokens, 20_001);
  assert.deepEqual(planCompaction({ source: oversizedTail, profile: testProfile, mode: "manual" }), {
    kind: "retained_tail_unavailable",
    reason: "budget",
  });
});

test("planner blocks pending source before materialization", () => {
  const result = planCompaction({ source: testSource({ pending: true }), profile: testProfile, mode: "manual" });
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "pending_tool_execution",
    pendingBoundary: { reason: "pending_tool_execution", assistantMessageId: "pending", toolExecutionIds: ["execution"] },
  });
});

test("planner retains a recent user image under the ordinary tail budget", () => {
  const small = planCompaction({
    source: testSource({ texts: ["old ".repeat(14_000), "recent", "trigger"], mediaTrigger: true }),
    profile: testProfile,
    mode: "manual",
  });
  assert.equal(small.kind, "planned");
  if (small.kind === "planned") {
    assert.equal(small.plan.retainedSourceBlockIds.includes("m3"), true);
    assert.match(JSON.stringify(small.retainedBlocks), /attachment_ref/);
  }
});

test("planner can summarize a user image before a long completed tool loop", () => {
  const source = testSource({
    texts: ["question with image", ...Array(4).fill("x".repeat(18_000))],
    types: ["user", "assistant", "assistant", "assistant", "assistant"],
    triggerIndex: 0,
    mediaTrigger: true,
  });
  for (const block of source.blocks.slice(1)) addAssistantReplay(block, "@ai-sdk/openai");
  for (const mode of ["manual", "proactive"] as const) {
    const result = planCompaction({ source, profile: testProfile, mode });
    assert.equal(result.kind, "planned");
    if (result.kind !== "planned") continue;
    assert.deepEqual(result.plan.prefixSourceBlockIds, ["m1", "m2", "m3"]);
    assert.deepEqual(result.plan.retainedSourceBlockIds, ["m4", "m5"]);
    assert.ok(result.plan.estimatedRetainedCost <= 20_000);
    const imageSummary = result.summaryBlocks.find(block => block.sourceBlockId === "m1");
    assert.match(JSON.stringify(imageSummary), /Image path: repo\/screen\.png; contents not included in summary/);
    assert.equal(JSON.stringify(imageSummary).includes("attachment_ref"), false);
  }
  source.interactiveInput = { version: AGENT_QUEUE_INPUT_POLICY_VERSION, interactive: true, inputReceiptIds: ["receipt"],
    inputs: [{ receiptId: "receipt", messageId: "m1", currentRunInput: true, attachments: [] }] };
  assert.equal(planCompaction({ source, profile: testProfile, mode: "proactive" }).kind, "planned");
  assert.equal(planCompaction({ source, profile: testProfile, mode: "proactive" }).kind, "planned");
});

test("planner handles an oversized latest block identically with or without a user image", () => {
  for (const mediaTrigger of [false, true]) {
    const oversized = testSource({ texts: ["old", "trigger ".repeat(15_000)], mediaTrigger });
    assert.deepEqual(planCompaction({ source: oversized, profile: testProfile, mode: "manual" }), {
      kind: "retained_tail_unavailable",
      reason: "budget",
    });
  }
});

test("planner gives zero cost and no retained eligibility to projection-empty blocks", () => {
  const onlySummary = testSource({ texts: ["summary", "new"], types: ["compaction", "user"] });
  assert.deepEqual(planCompaction({ source: onlySummary, profile: testProfile, mode: "manual" }), {
    kind: "no_prefix",
    reason: "no_effective_prefix",
  });
  const empty = testSource({ texts: [""], types: ["user"] });
  assert.deepEqual(planCompaction({ source: empty, profile: testProfile, mode: "manual" }), {
    kind: "no_prefix",
    reason: "projection_empty",
  });
  const emptyTextReplay = testSource({ texts: ["", "new"], types: ["assistant", "user"] });
  emptyTextReplay.blocks[0]!.message.parts = [{ id: "empty", messageId: "m1", position: 0, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1 }];
  emptyTextReplay.blocks[0]!.providerReplay = [{
    partId: "empty",
    envelope: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "gpt-5" }, item: { type: "text", itemId: "empty-item" } },
  }];
  const planned = planCompaction({ source: emptyTextReplay, profile: testProfile, mode: "manual" });
  assert.equal(planned.kind, "no_prefix");
  assert.deepEqual(planned, { kind: "no_prefix", reason: "no_effective_prefix" });
  const compatible = planCompaction({ source: emptyTextReplay, profile: { ...testProfile, provider: { ...testProfile.provider, npm: "@ai-sdk/openai-compatible" as const } }, mode: "manual" });
  assert.deepEqual(compatible, { kind: "no_prefix", reason: "no_effective_prefix" });
});

test("assistant retained-start capability is derived from profile adapter semantics", () => {
  const source = testSource({ texts: ["old ".repeat(14_000), "assistant output"], types: ["user", "assistant"] });
  const official = planCompaction({ source, profile: testProfile, mode: "manual" });
  assert.equal(official.kind, "planned");
  const compatibleProfile = { ...testProfile, provider: { ...testProfile.provider, npm: "@ai-sdk/openai-compatible" as const } };
  const compatible = planCompaction({ source, profile: compatibleProfile, mode: "manual" });
  assert.equal(compatible.kind, "retained_tail_unavailable");
});

test("profile fingerprint changes only with normalized profile semantics", () => {
  const baseline = computeCompactionProfileFingerprint(testProfile);
  const noSecretChange = computeCompactionProfileFingerprint({
    ...testProfile,
    provider: { ...testProfile.provider, options: { baseURL: "https://other.example.test", apiKey: "other-secret" } },
  });
  const modelChange = computeCompactionProfileFingerprint({ ...testProfile, model: { ...testProfile.model, providerModelId: "gpt-6" } });
  const windowChange = computeCompactionProfileFingerprint({ ...testProfile, model: { ...testProfile.model, contextWindowTokens: 256_000 } });
  assert.equal(noSecretChange, baseline);
  assert.notEqual(modelChange, baseline);
  assert.notEqual(windowChange, baseline);
});


test("current Run receipt ownership does not pin ordinary historical input before the fixed tail", () => {
  const source = plannedSource();
  source.interactiveInput = { version: AGENT_QUEUE_INPUT_POLICY_VERSION, interactive: true, inputReceiptIds: ["receipt"],
    inputs: [{ receiptId: "receipt", messageId: "m1", currentRunInput: true, attachments: [] }] };
  assert.equal(planCompaction({ source, profile: testProfile, mode: "proactive" }).kind, "planned");
  const confirmed = planCompaction({ source, profile: testProfile, mode: "proactive" });
  assert.equal(confirmed.kind, "planned");
  if (confirmed.kind === "planned") assert.deepEqual(confirmed.plan.prefixSourceBlockIds, ["m1"]);
});

test("all ordinary visible inputs are included in compaction planning", () => {
  const source = testSource({ texts: ["old ".repeat(14_000), "ordinary history", "recent ".repeat(6_000), "trigger"] });
  source.interactiveInput = { version: AGENT_QUEUE_INPUT_POLICY_VERSION, interactive: true, inputReceiptIds: [],
    inputs: [{ receiptId: "receipt", messageId: "m2", currentRunInput: false, attachments: [] }] };
  const result = planCompaction({ source, profile: testProfile, mode: "manual" });
  assert.equal(result.kind, "planned");
  if (result.kind === "planned") {
    assert.ok(result.plan.prefixSourceBlockIds.includes("m2") || result.plan.retainedSourceBlockIds.includes("m2"));
  }
});
