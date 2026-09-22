import assert from "node:assert/strict";
import test from "node:test";
import { estimatePrimaryMaterializedBlock } from "./estimator-v1.js";
import { COMPACTION_MODE_POLICIES, computeCompactionProfileFingerprint, planCompaction, SummaryPlanningBudget } from "./planner.js";
import { materializePrimaryBlocks } from "./primary-materializer.js";
import { testProfile, testSource } from "./test-fixtures.js";

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
  assert.equal(result.plan.containsTriggerMedia, false);
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

test("planner forces trigger media into B and reports resend when its suffix cannot fit", () => {
  const small = planCompaction({
    source: testSource({ texts: ["old ".repeat(14_000), "recent", "trigger"], mediaTrigger: true }),
    profile: testProfile,
    mode: "manual",
  });
  assert.equal(small.kind, "planned");
  if (small.kind === "planned") {
    assert.equal(small.plan.containsTriggerMedia, true);
    assert.equal(small.plan.retainedSourceBlockIds.includes("m3"), true);
  }
  const oversized = testSource({ texts: ["old", "trigger ".repeat(15_000)], mediaTrigger: true });
  assert.deepEqual(planCompaction({ source: oversized, profile: testProfile, mode: "manual" }), {
    kind: "media_requires_resend",
    triggerMessageId: "m2",
  });
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

test("summary planning budget enforces partition, candidate-primary, retry and total request bounds", () => {
  const policy = COMPACTION_MODE_POLICIES.manual;
  const budget = new SummaryPlanningBudget({ attemptedPartitionCount: 14, finalLeafCount: 7, logicalProviderCallCount: 28, networkRequestCount: 58 });
  const partition = budget.beginPartition();
  budget.finalizeLeaf();
  const candidate = budget.beginLogicalCall(partition);
  budget.beginNetworkRequest(candidate, policy);
  budget.beginNetworkRequest(candidate, policy);
  assert.throws(() => budget.beginNetworkRequest(candidate, policy), /logical call network/);
  const primary = budget.beginLogicalCall(partition, candidate);
  assert.throws(() => budget.beginLogicalCall(partition, primary), /partition logical/);
  assert.throws(() => budget.beginNetworkRequest(primary, policy), /network request limit/);
  assert.throws(() => budget.beginPartition(), /partition/);
  assert.throws(() => budget.finalizeLeaf(), /leaf/);
  const globalLimit = new SummaryPlanningBudget({ logicalProviderCallCount: 30 });
  const freshPartition = globalLimit.beginPartition();
  assert.throws(() => globalLimit.beginLogicalCall(freshPartition), /logical provider/);
  assert.equal(Object.isFrozen(partition), true);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.prototype.hasOwnProperty.call(candidate, "networkRequestCount"), false);
  assert.deepEqual(budget.splitForContextLimit([1, 2, 3, 4, 5]), [[1, 2], [3, 4, 5]]);
  assert.throws(() => budget.splitForContextLimit([1]), /split/);
  assert.throws(() => budget.beginLogicalCall({ id: 999 }), /handle is unknown/);
  const forged = { id: partition.id };
  assert.throws(() => budget.beginLogicalCall(forged), /handle is unknown/);
  const unregisteredCall = { partitionId: partition.id, ordinal: 1 as const };
  assert.throws(() => budget.beginNetworkRequest(unregisteredCall, policy), /call handle is unknown/);
});

test("summary planning budget rejects invalid initial counters before reserving work", () => {
  for (const initial of [
    { finalLeafCount: -1 },
    { attemptedPartitionCount: 15.5 },
    { logicalProviderCallCount: Number.POSITIVE_INFINITY },
    { finalLeafCount: 9 },
    { attemptedPartitionCount: 16 },
    { logicalProviderCallCount: 31 },
    { networkRequestCount: -1 },
  ]) {
    assert.throws(() => new SummaryPlanningBudget(initial), /initial .+ outside/);
  }
  assert.deepEqual(new SummaryPlanningBudget({ networkRequestCount: 60 }).snapshot(), {
    finalLeafCount: 0, attemptedPartitionCount: 0, logicalProviderCallCount: 0, networkRequestCount: 60,
  });
});
