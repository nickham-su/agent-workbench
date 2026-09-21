import type { ModelMessage } from "ai";
import { ApiConflictError, InternalRpcHttpError, InternalRpcInvalidResponseError, type AgentApiClient, type ExecutionProfile } from "../apiClient.js";
import { estimateCompactionSummaryText } from "./estimator-v1.js";
import { computeCompactionProfileFingerprint, planCompaction, SummaryPlanningBudget, type SummaryLogicalCallHandle } from "./planner.js";
import { summaryInputToModelMessages } from "./summary-input-to-model-messages.js";
import {
  CompactionPlanningError,
  COMPACTION_MODE_POLICIES,
  type CompactionCasState,
  type CompactionExecutionResult,
  type CompactionMode,
  type SummaryInputBlock,
} from "./types.js";

const MIN_REMAINING_MS = 50;
const PROVIDER_RETRY_DELAY_MS = 1_000;

type SummaryProfile = Pick<ExecutionProfile, "provider" | "model">;
type ProviderFailureKind = "context_limit" | "transient" | "permanent";

class CompactionCommitOutcomeUncertainError extends Error {
  constructor(cause: unknown) {
    super("compaction commit outcome uncertain");
    this.name = "CompactionCommitOutcomeUncertainError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class CompactionWorkDeadlineExceededError extends Error {
  constructor() {
    super("compaction work deadline exceeded");
    this.name = "CompactionWorkDeadlineExceededError";
  }
}

export type CompactionExecutorDependencies = {
  apiClient: Pick<AgentApiClient, "getExecutionProfile" | "getCompactionSource" | "commitCompactionWithTerminalIntent" | "confirmCompactionCommit">;
  nowMs?: () => number;
  /** Test seam only; overrides the mode-resolved compaction deadline. */
  workDeadlineMsByMode?: Partial<Record<CompactionMode, number>>;
  newId: (prefix: string) => string;
  generateSummary: (params: {
    profile: SummaryProfile;
    system: string;
    messages: ModelMessage[];
    timeoutMs: number | null;
    abortSignal: AbortSignal;
  }) => Promise<{ text: string }>;
  isContextLimitError: (error: unknown) => boolean;
};

function compactionPrompt() {
  return "Summarize the preceding conversation faithfully. Preserve decisions, completed work, constraints, unresolved issues, and tool outcomes needed for the next turn.";
}

function combineSummaries(summaries: readonly string[]) {
  return summaries.join("\n\n---\n\n");
}

function primarySummaryProfile(profile: ExecutionProfile): SummaryProfile {
  return { provider: profile.provider, model: profile.model };
}

function candidateSummaryProfile(profile: ExecutionProfile): SummaryProfile {
  return profile.compaction ?? primarySummaryProfile(profile);
}

function sameSummaryProfile(left: SummaryProfile, right: SummaryProfile) {
  const leftModel = left.model.providerModelId?.trim() || left.model.id;
  const rightModel = right.model.providerModelId?.trim() || right.model.id;
  return left.provider.id === right.provider.id && left.provider.npm === right.provider.npm && leftModel === rightModel;
}

/**
 * Worker-only compaction orchestration. It consumes the API Resolver snapshot and
 * never reconstructs history from Timeline/messages-context or reads attachment bytes.
 */
export class CompactionExecutor {
  private readonly nowMs: () => number;

  constructor(private readonly dependencies: CompactionExecutorDependencies) {
    this.nowMs = dependencies.nowMs ?? Date.now;
  }

  async execute(params: {
    mode: CompactionMode;
    /** Initial profile is retained for compatibility; every attempt refetches it. */
    profile: ExecutionProfile;
    workspaceId: string;
    sessionId: string;
    runId: string;
    abortSignal: AbortSignal;
    casState?: CompactionCasState;
  }): Promise<CompactionExecutionResult> {
    const policy = COMPACTION_MODE_POLICIES[params.mode];
    const workDeadlineMs = this.workDeadlineMs(params.mode, params.profile, policy.workDeadlineMs);
    const deadline = workDeadlineMs == null ? null : this.nowMs() + workDeadlineMs;
    const casState = params.casState ?? { remaining: policy.casReplanAllowance };
    const messageId = this.dependencies.newId("message");
    const textPartId = this.dependencies.newId("part");
    const summaryBudget = new SummaryPlanningBudget();
    const deadlineController = new AbortController();
    const abortForCallerCancellation = () => deadlineController.abort();
    params.abortSignal.addEventListener("abort", abortForCallerCancellation, { once: true });
    const deadlineTimer = workDeadlineMs == null ? null : setTimeout(() => deadlineController.abort(), workDeadlineMs);
    let initialFingerprint: string | null = null;

    try {
      while (true) {
        // This state belongs to exactly one frozen plan / exact-replay round.
        // A definitive CAS conflict proves that round did not commit, so the next
        // replan must start without inheriting an earlier attempted-write marker.
        let commitAttempted = false;
        // The order is intentional: a frozen plan can only pair a freshly-read
        // profile with the source materialized under that profile.
        const remaining = this.remaining(deadline, deadlineController.signal, params.abortSignal);
        const profile = await this.dependencies.apiClient.getExecutionProfile({
          workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId,
        }, { abortSignal: deadlineController.signal, ...this.remainingTimeoutOption(remaining) });
        const fingerprint = computeCompactionProfileFingerprint(profile);
        if (initialFingerprint == null) initialFingerprint = fingerprint;
        else if (fingerprint !== initialFingerprint) {
          return params.mode === "proactive"
            ? { kind: "skipped", reason: "profile_changed" }
            : { kind: "skipped", reason: "cas_conflict" };
        }
        const source = await this.dependencies.apiClient.getCompactionSource({
          workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId,
        }, { abortSignal: deadlineController.signal, ...this.remainingTimeoutOption(remaining) });
        const planned = planCompaction({ source, profile, mode: params.mode });
        if (planned.kind === "blocked") return { kind: "blocked", reason: planned.reason };
        if (planned.kind === "media_requires_resend") return { kind: "media_requires_resend" };
        if (planned.kind === "no_prefix") return { kind: "skipped", reason: "no_prefix" };
        if (planned.kind === "retained_tail_unavailable") {
          return { kind: "skipped", reason: planned.reason === "budget" ? "oversized_tail" : "no_prefix" };
        }

        const plan = planned.plan;
        if (plan.profileFingerprint !== fingerprint) {
          return params.mode === "proactive"
            ? { kind: "skipped", reason: "profile_changed" }
            : { kind: "skipped", reason: "cas_conflict" };
        }

        let summaryText: string;
        try {
          summaryText = await this.summarize({
            blocks: planned.summaryBlocks,
            profile,
            system: source.oneShotSystem,
            deadline,
            abortSignal: deadlineController.signal,
            maxNetworkRequestsPerLogicalCall: policy.maxNetworkRequestsPerLogicalCall,
            maxNetworkRequestCount: policy.maxNetworkRequestCount,
            budget: summaryBudget,
          });
        } catch (error) {
          if (error instanceof CompactionPlanningError) {
            return error.code === "summary_input_limit"
              ? { kind: "summary_input_limit" }
              : { kind: "failed", reason: "data_invariant" };
          }
          if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
          if (error instanceof CompactionWorkDeadlineExceededError) return { kind: "unavailable", reason: "deadline" };
          if (deadlineController.signal.aborted || (deadline != null && this.nowMs() >= deadline)) return { kind: "unavailable", reason: "deadline" };
          const failure = this.classifyProviderFailure(error, deadlineController.signal);
          return failure === "transient"
            ? { kind: "unavailable", reason: "transient" }
            : { kind: "failed", reason: "provider" };
        }
        if (!summaryText) return { kind: "skipped", reason: "no_progress" };

        const estimatedAfter = estimateCompactionSummaryText(summaryText) + plan.estimatedRetainedCost;
        if (estimatedAfter >= plan.estimatedBeforeCost) return { kind: "skipped", reason: "no_progress" };

        const request = {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          runId: params.runId,
          messageId,
          textPartId,
          expectedHeadMessageId: plan.expectedHeadMessageId,
          expectedRevision: plan.expectedRevision,
          retainedFromMessageId: plan.retainedFromMessageId,
          summaryText,
          ...(params.mode === "manual" ? { intent: { status: "completed" as const, code: "compaction_completed" as const, detail: null } } : {}),
          createdAt: this.nowMs(),
        };
        try {
          const committed = await this.commitExactReplay({
            request,
            deadline,
            abortSignal: deadlineController.signal,
            callerSignal: params.abortSignal,
            onAttempt: () => { commitAttempted = true; },
          });
          if (committed.result === "updated" && committed.summaryMessageId) return { kind: "committed", summaryMessageId: committed.summaryMessageId, plan };
          return { kind: "skipped", reason: "cas_conflict" };
        } catch (error) {
          if (!(error instanceof ApiConflictError)) {
            if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
            if (commitAttempted && this.isCommitOutcomeUncertain(error)) {
              try {
                const confirmed = await this.dependencies.apiClient.confirmCompactionCommit({
                  workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId, messageId,
                }, { abortSignal: deadlineController.signal, ...this.remainingTimeoutOption(this.remaining(deadline, deadlineController.signal, params.abortSignal)) });
                if (confirmed.outcome === "committed") return { kind: "committed", summaryMessageId: messageId, plan };
                return params.mode === "proactive"
                  ? { kind: "skipped", reason: "commit_not_committed" }
                  : { kind: "failed", reason: "control" };
              } catch (confirmationError) {
                if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
                return { kind: "failed", reason: "commit_outcome_uncertain" };
              }
            }
            // Before the first write request no remote state could have changed.
            if (!commitAttempted && error instanceof CompactionWorkDeadlineExceededError) {
              return { kind: "unavailable", reason: "deadline" };
            }
            return { kind: "failed", reason: this.isControlError(error) ? "control" : "data_invariant" };
          }
          if (casState.remaining <= 0) return { kind: "skipped", reason: "cas_conflict" };
          casState.remaining -= 1;
        }
      }
    } catch (error) {
      if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
      if (error instanceof CompactionWorkDeadlineExceededError || deadlineController.signal.aborted) return { kind: "unavailable", reason: "deadline" };
      if (error instanceof CompactionPlanningError) return { kind: "failed", reason: "data_invariant" };
      if (this.isTransientControlError(error)) return { kind: "unavailable", reason: "transient" };
      return { kind: "failed", reason: this.isControlError(error) ? "control" : "data_invariant" };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      params.abortSignal.removeEventListener("abort", abortForCallerCancellation);
    }
  }

  private workDeadlineMs(mode: CompactionMode, profile: ExecutionProfile, policyDeadlineMs: number | undefined) {
    const testDeadlineMs = this.dependencies.workDeadlineMsByMode?.[mode];
    if (testDeadlineMs !== undefined) return testDeadlineMs;
    if (mode === "proactive" || mode === "manual") {
      const configured = Math.max(0, Math.floor(Number(profile.runtime.modelTotalTimeoutMs)));
      return configured > 0 ? configured : null;
    }
    if (policyDeadlineMs == null) throw new Error(`missing compaction deadline policy for ${mode}`);
    return policyDeadlineMs;
  }

  private remaining(deadline: number | null, signal: AbortSignal, callerSignal?: AbortSignal) {
    if (callerSignal?.aborted) {
      const error = new Error("compaction cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (deadline == null) return null;
    const remaining = deadline - this.nowMs();
    if (signal.aborted || remaining < MIN_REMAINING_MS) throw new CompactionWorkDeadlineExceededError();
    return remaining;
  }

  private remainingTimeoutOption(remaining: number | null) {
    return remaining == null ? {} : { timeoutMs: remaining };
  }

  private async sleepWithAbort(ms: number, signal: AbortSignal) {
    if (signal.aborted) return false;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(true), ms);
      const onAbort = () => done(false);
      const done = (completed: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async commitExactReplay(params: {
    request: Parameters<AgentApiClient["commitCompactionWithTerminalIntent"]>[0];
    deadline: number | null;
    abortSignal: AbortSignal;
    callerSignal: AbortSignal;
    onAttempt: () => void;
  }) {
    const commit = async () => {
      const remaining = this.remaining(params.deadline, params.abortSignal, params.callerSignal);
      params.onAttempt();
      return await this.dependencies.apiClient.commitCompactionWithTerminalIntent(
        params.request,
        { abortSignal: params.abortSignal, ...this.remainingTimeoutOption(remaining) },
      );
    };
    try {
      return await commit();
    } catch (error) {
      if (!this.isRetryableControlWriteError(error)) throw error;
      // Once one response is lost, a later retry failure cannot prove that the
      // original write was absent. Preserve this fact for the confirmation path.
      if (!await this.sleepWithAbort(PROVIDER_RETRY_DELAY_MS, params.abortSignal)) {
        throw new CompactionCommitOutcomeUncertainError(error);
      }
      try {
        return await commit();
      } catch (retryError) {
        throw new CompactionCommitOutcomeUncertainError(retryError);
      }
    }
  }

  private isRetryableControlWriteError(error: unknown) {
    return this.isTransientControlError(error);
  }

  private isTransientControlError(error: unknown) {
    const status = this.statusOf(error);
    return error instanceof Error && (error.name === "InternalRpcNetworkError" || error.name === "InternalRpcTimeoutError" || error.name === "FetchError" || error.name === "TimeoutError" || status === 429 || (status != null && status >= 500));
  }

  private isControlError(error: unknown) {
    if (error instanceof ApiConflictError || error instanceof InternalRpcHttpError || error instanceof InternalRpcInvalidResponseError) return true;
    const status = this.statusOf(error);
    return status != null && status >= 400 && status < 500;
  }

  private isCommitOutcomeUncertain(error: unknown) {
    // A known conflict or known 4xx response is definitive. Every other post-send
    // outcome can have reached the Store, including timeout, retry interruption,
    // malformed success responses, and locally-unclassified transport failures.
    if (error instanceof ApiConflictError) return false;
    if (error instanceof CompactionCommitOutcomeUncertainError) return true;
    if (error instanceof InternalRpcHttpError) return error.status < 400 || error.status >= 500;
    if (error instanceof CompactionWorkDeadlineExceededError) return true;
    return true;
  }

  private statusOf(error: unknown) {
    if (!error || typeof error !== "object") return null;
    const raw = error as { status?: unknown; statusCode?: unknown };
    return typeof raw.statusCode === "number" ? raw.statusCode : typeof raw.status === "number" ? raw.status : null;
  }

  private classifyProviderFailure(error: unknown, deadlineSignal: AbortSignal): ProviderFailureKind {
    if (this.dependencies.isContextLimitError(error)) return "context_limit";
    if (deadlineSignal.aborted) return "transient";
    const status = this.statusOf(error);
    if (error instanceof Error && (error.name === "FetchError" || error.name === "TypeError" || error.name === "TimeoutError" || error.name === "AbortError")) return "transient";
    if (status === 429 || (status != null && status >= 500)) return "transient";
    return "permanent";
  }

  private async summarize(params: {
    blocks: readonly SummaryInputBlock[];
    profile: ExecutionProfile;
    system: string;
    deadline: number | null;
    abortSignal: AbortSignal;
    maxNetworkRequestsPerLogicalCall: 1 | 2;
    maxNetworkRequestCount: 30 | 60;
    budget: SummaryPlanningBudget;
  }) {
    const summarizeBlocks = async (blocks: readonly SummaryInputBlock[]): Promise<string> => {
      const partition = params.budget.beginPartition();
      const candidateCall = params.budget.beginLogicalCall(partition);
      const messages = [...summaryInputToModelMessages(blocks), { role: "user" as const, content: compactionPrompt() }];
      const request = async (call: SummaryLogicalCallHandle, profile: SummaryProfile) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < params.maxNetworkRequestsPerLogicalCall; attempt += 1) {
          params.budget.beginNetworkRequest(call, {
            maxNetworkRequestsPerLogicalCall: params.maxNetworkRequestsPerLogicalCall,
            maxNetworkRequestCount: params.maxNetworkRequestCount,
          });
          try {
            return await this.dependencies.generateSummary({ profile, system: params.system, messages, timeoutMs: this.remaining(params.deadline, params.abortSignal), abortSignal: params.abortSignal });
          } catch (error) {
            lastError = error;
            if (this.classifyProviderFailure(error, params.abortSignal) !== "transient" || attempt + 1 >= params.maxNetworkRequestsPerLogicalCall) throw error;
            if (!await this.sleepWithAbort(PROVIDER_RETRY_DELAY_MS, params.abortSignal)) throw new CompactionWorkDeadlineExceededError();
          }
        }
        throw lastError;
      };

      let response: { text: string };
      const candidate = candidateSummaryProfile(params.profile);
      const primary = primarySummaryProfile(params.profile);
      try {
        response = await request(candidateCall, candidate);
      } catch (error) {
        if (!this.dependencies.isContextLimitError(error)) throw error;
        if (sameSummaryProfile(candidate, primary)) {
          if (blocks.length < 2) throw new CompactionPlanningError("summary_input_limit", "summary input cannot be split further");
          const [left, right] = params.budget.splitForContextLimit(blocks);
          return combineSummaries([await summarizeBlocks(left), await summarizeBlocks(right)]);
        }
        // Only capacity failure can use the primary as the second logical call.
        const primaryCall = params.budget.beginLogicalCall(partition, candidateCall);
        try {
          response = await request(primaryCall, primary);
        } catch (primaryError) {
          if (!this.dependencies.isContextLimitError(primaryError)) throw primaryError;
          if (blocks.length < 2) throw new CompactionPlanningError("summary_input_limit", "summary input cannot be split further");
          const [left, right] = params.budget.splitForContextLimit(blocks);
          return combineSummaries([await summarizeBlocks(left), await summarizeBlocks(right)]);
        }
      }
      const text = String(response.text || "").trim();
      if (!text) return "";
      params.budget.finalizeLeaf();
      return text;
    };
    return await summarizeBlocks(params.blocks);
  }
}
