import type { CompactionExecutionResult, CompactionMode } from "./types.js";

export type ContextLimitRecoveryState = "none" | "standard_committed" | "full_attempted" | "full_committed";

/** Pure transition rules for one model context-limit recovery episode. */
export function nextContextLimitRecoveryMode(state: ContextLimitRecoveryState): CompactionMode | null {
  if (state === "none") return "recovery-standard";
  if (state === "standard_committed") return "recovery-full";
  return null;
}

export function beginContextLimitRecovery(state: ContextLimitRecoveryState, mode: CompactionMode): ContextLimitRecoveryState {
  return mode === "recovery-full" ? "full_attempted" : state;
}

export function completeContextLimitRecovery(mode: CompactionMode): ContextLimitRecoveryState {
  return mode === "recovery-full" ? "full_committed" : "standard_committed";
}

export function isStandardBusinessNoProgress(result: CompactionExecutionResult) {
  return result.kind === "skipped"
    && (result.reason === "no_prefix" || result.reason === "no_progress" || result.reason === "oversized_tail");
}
