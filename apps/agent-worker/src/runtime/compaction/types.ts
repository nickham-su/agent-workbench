import type { AgentApiCompactionSourceResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentToolExecutionStatus } from "@agent-workbench/shared";
import type { ExecutionProfile } from "../apiClient.js";

export const PRIMARY_MATERIALIZER_VERSION = "primary-materializer-v1";
export const SUMMARY_INPUT_MATERIALIZER_VERSION = "summary-input-materializer-v1";
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const MAX_SUMMARY_FINAL_LEAVES = 8;
export const MAX_SUMMARY_ATTEMPTED_PARTITIONS = 15;
export const MAX_SUMMARY_LOGICAL_CALLS = 30;

export type CompactionSource = AgentApiCompactionSourceResponse;
export type CompactionSourceBlock = CompactionSource["blocks"][number];

export type PrimaryReplay = {
  provider: { npm: "@ai-sdk/openai"; api: "responses"; providerId: string; model: string };
  item:
    | { type: "reasoning"; itemId: string; encryptedContent: string; summaryIndex?: number }
    | { type: "text"; itemId: string; phase?: "commentary" | "final_answer" }
    | { type: "function_call"; itemId: string };
};

export type PrimaryUserPart =
  | { type: "text"; text: string }
  | { type: "attachment_ref"; workspaceId: string; attachmentId: string; mediaType: string; filename: string };

export type PrimaryAssistantPart =
  | { type: "text"; text: string; providerReplay?: PrimaryReplay }
  | { type: "reasoning"; text: string; providerReplay: PrimaryReplay }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown>; providerReplay?: PrimaryReplay };

export type PrimaryToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string } | { type: "error-text"; value: string };
};

export type PrimaryProviderNeutralMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | PrimaryUserPart[] }
  | { role: "assistant"; content: string | PrimaryAssistantPart[] }
  | { role: "tool"; content: PrimaryToolResultPart[] };

export type PrimaryMaterializedBlock = {
  sourceBlockId: string;
  sourceMessageType: CompactionSourceBlock["message"]["type"];
  messages: PrimaryProviderNeutralMessage[];
  isProjectionEmpty: boolean;
  canStartRetainedTail: boolean;
  containsTriggerMedia: boolean;
};

export type SummaryInputPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "attachment"; mediaType: string; filename: string }
  | { type: "tool-call"; toolName: string; input: Record<string, unknown> }
  | { type: "tool-result"; toolName: string; output: { type: "text" | "error-text"; value: string } };

export type SummaryInputMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: SummaryInputPart[] }
  | { role: "assistant"; content: SummaryInputPart[] }
  | { role: "tool"; content: SummaryInputPart[] };

export type SummaryInputBlock = { sourceBlockId: string; messages: SummaryInputMessage[]; isProjectionEmpty: boolean };

export type EstimatorCanonicalJsonValue =
  | null | boolean | number | string | EstimatorCanonicalJsonValue[] | { [key: string]: EstimatorCanonicalJsonValue };

export type EstimatorCanonicalReplay = {
  provider: PrimaryReplay["provider"];
  item:
    | { type: "reasoning"; itemId: string; encryptedContent: "<encrypted>" }
    | { type: "text"; itemId: string; phase?: "commentary" | "final_answer" }
    | { type: "function_call"; itemId: string };
};

export type EstimatorCanonicalMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "attachment_ref"; mediaType: string; filename: "<filename>" }> }
  | { role: "assistant"; content: Array<{ type: "text"; text: string; replay?: EstimatorCanonicalReplay } | { type: "reasoning"; text: string; replay: EstimatorCanonicalReplay } | { type: "tool-call"; toolCallId: string; toolName: string; input: EstimatorCanonicalJsonValue; replay?: EstimatorCanonicalReplay }> }
  | { role: "tool"; content: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text" | "error-text"; value: string } }> };

export type EstimatorEstimate = {
  canonicalMessages: EstimatorCanonicalMessage[];
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
};

export type CompactionMode = "proactive" | "manual" | "recovery-standard" | "recovery-full";
export type CompactionProfileFingerprint = string;

export type CompactionModePolicy = {
  mode: CompactionMode;
  workDeadlineMs?: number;
  casReplanAllowance: number;
  casReplanScope: "attempt" | "run" | "recovery";
  maxNetworkRequestsPerLogicalCall: 1 | 2;
  maxNetworkRequestCount: 30 | 60;
};

export const COMPACTION_MODE_POLICIES: Readonly<Record<CompactionMode, CompactionModePolicy>> = {
  proactive: { mode: "proactive", casReplanAllowance: 0, casReplanScope: "attempt", maxNetworkRequestsPerLogicalCall: 1, maxNetworkRequestCount: 30 },
  manual: { mode: "manual", casReplanAllowance: 1, casReplanScope: "run", maxNetworkRequestsPerLogicalCall: 2, maxNetworkRequestCount: 60 },
  "recovery-standard": { mode: "recovery-standard", workDeadlineMs: 45_000, casReplanAllowance: 1, casReplanScope: "recovery", maxNetworkRequestsPerLogicalCall: 2, maxNetworkRequestCount: 60 },
  "recovery-full": { mode: "recovery-full", workDeadlineMs: 45_000, casReplanAllowance: 1, casReplanScope: "recovery", maxNetworkRequestsPerLogicalCall: 2, maxNetworkRequestCount: 60 },
};

export type FrozenCompactionPlan = {
  version: 1;
  planId: string;
  mode: CompactionMode;
  estimatorVersion: "estimator-v1";
  primaryMaterializerVersion: typeof PRIMARY_MATERIALIZER_VERSION;
  summaryInputMaterializerVersion: typeof SUMMARY_INPUT_MATERIALIZER_VERSION;
  profileFingerprint: CompactionProfileFingerprint;
  modePolicy: CompactionModePolicy;
  expectedHeadMessageId: string | null;
  expectedRevision: number;
  resolvedSourceBlockIds: string[];
  prefixSourceBlockIds: string[];
  retainedSourceBlockIds: string[];
  retainedFromMessageId: string | null;
  estimatedBeforeCost: number;
  estimatedPrefixCost: number;
  estimatedRetainedCost: number;
  containsTriggerMedia: boolean;
  source: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    headMessageId: string | null;
    contextRootMessageId: string | null;
    sessionRevision: number;
    triggerMessageId: string | null;
  };
};

export type SummaryBudgetState = {
  finalLeafCount: number;
  attemptedPartitionCount: number;
  logicalProviderCallCount: number;
  networkRequestCount: number;
};

export type CompactionToolExecutionResult = {
  status: AgentToolExecutionStatus;
  resultPreview: string | null;
  error: string | null;
};

export type CompactionToolResultOutput = { type: "text"; value: string } | { type: "error-text"; value: string };

export class CompactionPlanningError extends Error {
  constructor(readonly code: "summary_input_limit" | "data_invariant" | "profile_invalid", message: string) {
    super(message);
    this.name = "CompactionPlanningError";
  }
}

export type CompactionPlanResult =
  | { kind: "planned"; plan: FrozenCompactionPlan; summaryBlocks: SummaryInputBlock[]; retainedBlocks: PrimaryMaterializedBlock[] }
  | { kind: "no_prefix"; reason: "no_effective_prefix" | "projection_empty" }
  | { kind: "blocked"; reason: "pending_tool_execution"; pendingBoundary: NonNullable<CompactionSource["pendingBoundary"]> }
  | { kind: "media_requires_resend"; triggerMessageId: string }
  | { kind: "retained_tail_unavailable"; reason: "budget" | "invalid_start" | "full_mode_requires_execution" };

export type CompactionCasState = { remaining: number };

export type CompactionExecutionResult =
  | { kind: "committed"; summaryMessageId: string; plan: FrozenCompactionPlan }
  | { kind: "skipped"; reason: "no_prefix" | "no_progress" | "oversized_tail" | "cas_conflict" | "profile_changed" | "commit_not_committed" }
  | { kind: "blocked"; reason: "pending_tool_execution" }
  | { kind: "media_requires_resend" }
  | { kind: "summary_input_limit" }
  | { kind: "unavailable"; reason: "transient" | "deadline" | "commit_response_loss" }
  | { kind: "failed"; reason: "provider" | "control" | "data_invariant" | "cancelled" | "commit_outcome_uncertain" };

export function normalizedProviderModelId(profile: Pick<ExecutionProfile, "model">) {
  const providerModelId = profile.model.providerModelId;
  return typeof providerModelId === "string" && providerModelId.trim() ? providerModelId.trim() : profile.model.id;
}
