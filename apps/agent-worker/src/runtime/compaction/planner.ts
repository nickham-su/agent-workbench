import { createHash, randomUUID } from "node:crypto";
import type { ExecutionProfile } from "../apiClient.js";
import { ESTIMATOR_VERSION, estimatePrimaryMaterializedBlock } from "./estimator-v1.js";
import { canProfileStartRetainedTailAtAssistant, materializePrimaryBlocks, primaryMaterializerAdapterIdentity } from "./primary-materializer.js";
import { sourceBlockContainsTriggerMedia, validateCompactionSource } from "./source-block-invariants.js";
import { materializeSummaryInputBlocks } from "./summary-input-materializer.js";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_MODE_POLICIES,
  CompactionPlanningError,
  MAX_SUMMARY_ATTEMPTED_PARTITIONS,
  MAX_SUMMARY_FINAL_LEAVES,
  MAX_SUMMARY_LOGICAL_CALLS,
  PRIMARY_MATERIALIZER_VERSION,
  SUMMARY_INPUT_MATERIALIZER_VERSION,
  normalizedProviderModelId,
  type CompactionMode,
  type CompactionModePolicy,
  type CompactionPlanResult,
  type CompactionProfileFingerprint,
  type CompactionSource,
  type PrimaryMaterializedBlock,
  type SummaryBudgetState,
} from "./types.js";

export { COMPACTION_MODE_POLICIES } from "./types.js";

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CompactionPlanningError("profile_invalid", "profile fingerprint contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new CompactionPlanningError("profile_invalid", "profile fingerprint contains unsupported value");
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Profile fingerprint deliberately excludes credentials, base URLs and arbitrary provider options. */
export function computeCompactionProfileFingerprint(profile: ExecutionProfile): CompactionProfileFingerprint {
  const payload = {
    compaction: profile.compaction == null ? null : {
      providerId: profile.compaction.provider.id,
      model: normalizedProviderModelId(profile.compaction),
      npm: profile.compaction.provider.npm,
    },
    providerId: profile.resolved.providerId,
    model: normalizedProviderModelId(profile),
    npm: profile.provider.npm,
    adapter: primaryMaterializerAdapterIdentity(profile),
    contextWindowTokens: profile.model.contextWindowTokens,
    primaryMaterializerVersion: "primary-materializer-v1",
    estimatorVersion: ESTIMATOR_VERSION,
  };
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

export type SummaryPartitionHandle = Readonly<{ readonly id: number }>;
export type SummaryLogicalCallHandle = Readonly<{ readonly partitionId: number; readonly ordinal: 1 | 2 }>;

/**
 * Phase-seven execution owns Provider I/O; this class only reserves bounded
 * partitions/calls/requests, so retries and candidate→primary fallback cannot
 * silently exceed the planning contract.
 */
export class SummaryPlanningBudget {
  private state: SummaryBudgetState;
  private nextPartitionId = 1;
  private readonly logicalCallsByPartition = new Map<number, number>();
  private readonly partitionHandles = new WeakMap<SummaryPartitionHandle, { id: number }>();
  private readonly logicalCallHandles = new WeakMap<SummaryLogicalCallHandle, { partition: SummaryPartitionHandle; ordinal: 1 | 2; networkRequestCount: number }>();

  constructor(initial?: Partial<SummaryBudgetState>) {
    this.state = {
      finalLeafCount: initial?.finalLeafCount ?? 0,
      attemptedPartitionCount: initial?.attemptedPartitionCount ?? 0,
      logicalProviderCallCount: initial?.logicalProviderCallCount ?? 0,
      networkRequestCount: initial?.networkRequestCount ?? 0,
    };
    for (const [name, value, maximum] of [
      ["finalLeafCount", this.state.finalLeafCount, MAX_SUMMARY_FINAL_LEAVES],
      ["attemptedPartitionCount", this.state.attemptedPartitionCount, MAX_SUMMARY_ATTEMPTED_PARTITIONS],
      ["logicalProviderCallCount", this.state.logicalProviderCallCount, MAX_SUMMARY_LOGICAL_CALLS],
      ["networkRequestCount", this.state.networkRequestCount, Number.MAX_SAFE_INTEGER],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new CompactionPlanningError("data_invariant", `summary initial ${name} is outside its allowed range`);
      }
    }
  }

  snapshot(): Readonly<SummaryBudgetState> { return Object.freeze({ ...this.state }); }

  beginPartition(): SummaryPartitionHandle {
    if (this.state.attemptedPartitionCount >= MAX_SUMMARY_ATTEMPTED_PARTITIONS) {
      throw new CompactionPlanningError("summary_input_limit", "summary attempted partition limit reached");
    }
    this.state.attemptedPartitionCount += 1;
    const partition = Object.freeze({ id: this.nextPartitionId++ });
    this.logicalCallsByPartition.set(partition.id, 0);
    this.partitionHandles.set(partition, { id: partition.id });
    return partition;
  }

  finalizeLeaf() {
    if (this.state.finalLeafCount >= MAX_SUMMARY_FINAL_LEAVES) {
      throw new CompactionPlanningError("summary_input_limit", "summary final leaf limit reached");
    }
    this.state.finalLeafCount += 1;
  }

  beginLogicalCall(partition: SummaryPartitionHandle, previous?: SummaryLogicalCallHandle): SummaryLogicalCallHandle {
    const partitionState = this.partitionHandles.get(partition);
    const used = partitionState == null ? undefined : this.logicalCallsByPartition.get(partitionState.id);
    if (used == null || partitionState == null) throw new CompactionPlanningError("data_invariant", "summary partition handle is unknown");
    const previousState = previous == null ? undefined : this.logicalCallHandles.get(previous);
    if (previous != null && previousState == null) {
      throw new CompactionPlanningError("data_invariant", "summary logical call handle is unknown");
    }
    if (previousState && previousState.partition !== partition) {
      throw new CompactionPlanningError("data_invariant", "summary primary fallback belongs to a different partition");
    }
    if ((previous == null && used !== 0) || (previousState != null && (used !== 1 || previousState.ordinal !== 1))) {
      throw new CompactionPlanningError("summary_input_limit", "summary partition logical call limit reached");
    }
    if (this.state.logicalProviderCallCount >= MAX_SUMMARY_LOGICAL_CALLS) {
      throw new CompactionPlanningError("summary_input_limit", "summary logical provider call limit reached");
    }
    this.state.logicalProviderCallCount += 1;
    this.logicalCallsByPartition.set(partitionState.id, used + 1);
    const ordinal = previous == null ? 1 : 2;
    const call = Object.freeze({ partitionId: partitionState.id, ordinal });
    this.logicalCallHandles.set(call, { partition, ordinal, networkRequestCount: 0 });
    return call;
  }

  beginNetworkRequest(call: SummaryLogicalCallHandle, policy: Pick<CompactionModePolicy, "maxNetworkRequestCount" | "maxNetworkRequestsPerLogicalCall">) {
    const callState = this.logicalCallHandles.get(call);
    if (!callState) throw new CompactionPlanningError("data_invariant", "summary logical call handle is unknown");
    if (callState.networkRequestCount >= policy.maxNetworkRequestsPerLogicalCall) {
      throw new CompactionPlanningError("summary_input_limit", "summary logical call network request limit reached");
    }
    if (this.state.networkRequestCount >= policy.maxNetworkRequestCount) {
      throw new CompactionPlanningError("summary_input_limit", "summary network request limit reached");
    }
    callState.networkRequestCount += 1;
    this.state.networkRequestCount += 1;
  }

  /** Deterministic depth-first, left-first Message-block split. */
  splitForContextLimit<T>(items: readonly T[]): [readonly T[], readonly T[]] {
    if (items.length < 2) throw new CompactionPlanningError("summary_input_limit", "summary input cannot be split further");
    const midpoint = Math.floor(items.length / 2);
    return [items.slice(0, midpoint), items.slice(midpoint)];
  }
}

type EstimatedBlock = { primary: PrimaryMaterializedBlock; estimatedTokens: number };

function isOriginal(block: PrimaryMaterializedBlock) {
  return block.sourceMessageType === "user" || block.sourceMessageType === "assistant" || block.sourceMessageType === "system";
}

function canStart(block: EstimatedBlock, profile: ExecutionProfile) {
  if (block.primary.sourceMessageType === "assistant") {
    return !block.primary.isProjectionEmpty && canProfileStartRetainedTailAtAssistant(profile);
  }
  return block.primary.canStartRetainedTail;
}

function createPlanId() {
  return randomUUID();
}

/**
 * Pure A/B planner. It consumes one API source snapshot, does not fetch files,
 * call Providers, read history, or freeze Provider wire messages.
 */
export function planCompaction(input: { source: CompactionSource; profile: ExecutionProfile; mode: CompactionMode }): CompactionPlanResult {
  const { source, profile } = input;
  if (source.pendingBoundary != null) {
    return { kind: "blocked", reason: "pending_tool_execution", pendingBoundary: source.pendingBoundary };
  }
  validateCompactionSource(source);

  const primary = materializePrimaryBlocks({ source, profile });
  const estimated = primary.map((block) => ({ primary: block, estimatedTokens: block.isProjectionEmpty ? 0 : estimatePrimaryMaterializedBlock(block).estimatedTokens }));
  const retainableOriginal = estimated.filter((block) => isOriginal(block.primary) && !block.primary.isProjectionEmpty);

  if (input.mode === "recovery-full") {
    const trigger = estimated.find((block) => block.primary.containsTriggerMedia);
    if (trigger) return { kind: "media_requires_resend", triggerMessageId: trigger.primary.sourceBlockId };
    // Full recovery summarizes the complete Resolver-effective snapshot,
    // including preceding compaction messages. Omitting S loses meaning after
    // consecutive compactions.
    const prefix = estimated.filter((block) => !block.primary.isProjectionEmpty);
    const prefixIds = source.blocks.map((block) => block.sourceMessageId);
    const summaryBlocks = materializeSummaryInputBlocks(source.blocks);
    const policy = COMPACTION_MODE_POLICIES[input.mode];
    const estimatedBeforeCost = prefix.reduce((total, block) => total + block.estimatedTokens, 0);
    return {
      kind: "planned",
      plan: {
        version: 1, planId: createPlanId(), mode: input.mode, estimatorVersion: ESTIMATOR_VERSION,
        primaryMaterializerVersion: PRIMARY_MATERIALIZER_VERSION,
        summaryInputMaterializerVersion: SUMMARY_INPUT_MATERIALIZER_VERSION,
        profileFingerprint: computeCompactionProfileFingerprint(profile), modePolicy: policy,
        expectedHeadMessageId: source.headMessageId, expectedRevision: source.sessionRevision,
        resolvedSourceBlockIds: source.blocks.map((block) => block.sourceMessageId),
        prefixSourceBlockIds: prefixIds, retainedSourceBlockIds: [], retainedFromMessageId: null,
        estimatedBeforeCost, estimatedPrefixCost: estimatedBeforeCost, estimatedRetainedCost: 0,
        containsTriggerMedia: false,
        source: {
          workspaceId: source.workspaceId, sessionId: source.sessionId, runId: source.runId,
          headMessageId: source.headMessageId, contextRootMessageId: source.contextRootMessageId,
          sessionRevision: source.sessionRevision, triggerMessageId: source.triggerMessageId,
        },
      },
      summaryBlocks,
      retainedBlocks: [],
    };
  }

  if (retainableOriginal.length === 0) return { kind: "no_prefix", reason: "projection_empty" };

  let total = 0;
  let firstCandidate = retainableOriginal.length;
  for (let cursor = retainableOriginal.length - 1; cursor >= 0; cursor -= 1) {
    const candidate = retainableOriginal[cursor]!;
    if (total + candidate.estimatedTokens > COMPACTION_KEEP_RECENT_TOKENS) break;
    total += candidate.estimatedTokens;
    firstCandidate = cursor;
  }
  if (firstCandidate === retainableOriginal.length) {
    const trigger = retainableOriginal.find((block) => block.primary.containsTriggerMedia);
    return trigger ? { kind: "media_requires_resend", triggerMessageId: trigger.primary.sourceBlockId } : { kind: "retained_tail_unavailable", reason: "budget" };
  }

  let retained = retainableOriginal.slice(firstCandidate);
  if (!canStart(retained[0]!, profile)) {
    let legalIndex = firstCandidate - 1;
    while (legalIndex >= 0 && !canStart(retainableOriginal[legalIndex]!, profile)) legalIndex -= 1;
    if (legalIndex < 0) return { kind: "retained_tail_unavailable", reason: "invalid_start" };
    retained = retainableOriginal.slice(legalIndex);
    total = retained.reduce((sum, block) => sum + block.estimatedTokens, 0);
    if (total > COMPACTION_KEEP_RECENT_TOKENS) return { kind: "retained_tail_unavailable", reason: "budget" };
  }

  const triggerIndex = retainableOriginal.findIndex((block) => block.primary.containsTriggerMedia);
  if (triggerIndex >= 0) {
    const retainedStartIndex = retainableOriginal.findIndex((block) => block.primary.sourceBlockId === retained[0]!.primary.sourceBlockId);
    if (retainedStartIndex > triggerIndex) {
      retained = retainableOriginal.slice(triggerIndex);
      total = retained.reduce((sum, block) => sum + block.estimatedTokens, 0);
    }
    if (total > COMPACTION_KEEP_RECENT_TOKENS) {
      return { kind: "media_requires_resend", triggerMessageId: retainableOriginal[triggerIndex]!.primary.sourceBlockId };
    }
  }

  const retainedIds = new Set(retained.map((block) => block.primary.sourceBlockId));
  const prefix = estimated.filter((block) => !retainedIds.has(block.primary.sourceBlockId) && !block.primary.isProjectionEmpty);
  if (prefix.filter((block) => isOriginal(block.primary)).length === 0) {
    return { kind: "no_prefix", reason: "no_effective_prefix" };
  }

  const sourceById = new Map(source.blocks.map((block) => [block.sourceMessageId, block]));
  const prefixSourceBlockIds = prefix.map((block) => block.primary.sourceBlockId);
  const summaryBlocks = materializeSummaryInputBlocks(prefixSourceBlockIds.map((id) => {
    const block = sourceById.get(id);
    if (!block) throw new CompactionPlanningError("data_invariant", `missing source block ${id}`);
    return block;
  }));
  const estimatedBeforeCost = estimated.reduce((sum, block) => sum + block.estimatedTokens, 0);
  const estimatedPrefixCost = prefix.reduce((sum, block) => sum + block.estimatedTokens, 0);
  const containsTriggerMedia = primary.some((block) => block.containsTriggerMedia);
  const policy = COMPACTION_MODE_POLICIES[input.mode];
  return {
    kind: "planned",
    plan: {
      version: 1,
      planId: createPlanId(),
      mode: input.mode,
      estimatorVersion: ESTIMATOR_VERSION,
      primaryMaterializerVersion: PRIMARY_MATERIALIZER_VERSION,
      summaryInputMaterializerVersion: SUMMARY_INPUT_MATERIALIZER_VERSION,
      profileFingerprint: computeCompactionProfileFingerprint(profile),
      modePolicy: policy,
      expectedHeadMessageId: source.headMessageId,
      expectedRevision: source.sessionRevision,
      resolvedSourceBlockIds: source.blocks.map((block) => block.sourceMessageId),
      prefixSourceBlockIds,
      retainedSourceBlockIds: retained.map((block) => block.primary.sourceBlockId),
      retainedFromMessageId: retained[0]!.primary.sourceBlockId,
      estimatedBeforeCost,
      estimatedPrefixCost,
      estimatedRetainedCost: total,
      containsTriggerMedia,
      source: {
        workspaceId: source.workspaceId,
        sessionId: source.sessionId,
        runId: source.runId,
        headMessageId: source.headMessageId,
        contextRootMessageId: source.contextRootMessageId,
        sessionRevision: source.sessionRevision,
        triggerMessageId: source.triggerMessageId,
      },
    },
    summaryBlocks,
    retainedBlocks: retained.map((block) => block.primary),
  };
}
