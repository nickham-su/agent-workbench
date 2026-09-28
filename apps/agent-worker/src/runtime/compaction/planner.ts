import { createHash, randomUUID } from "node:crypto";
import type { ExecutionProfile } from "../apiClient.js";
import { ESTIMATOR_VERSION, estimatePrimaryMaterializedBlock } from "./estimator-v1.js";
import { canProfileStartRetainedTailAtAssistant, materializePrimaryBlocks, primaryMaterializerAdapterIdentity } from "./primary-materializer.js";
import { validateCompactionSource } from "./source-block-invariants.js";
import { materializeSummaryInputBlocks } from "./summary-input-materializer.js";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_MODE_POLICIES,
  CompactionPlanningError,
  PRIMARY_MATERIALIZER_VERSION,
  SUMMARY_INPUT_MATERIALIZER_VERSION,
  normalizedProviderModelId,
  type CompactionMode,
  type CompactionPlanResult,
  type CompactionProfileFingerprint,
  type CompactionSource,
  type PrimaryMaterializedBlock,
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
