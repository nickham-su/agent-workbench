import type { ModelMessage } from "ai";
import { getPromptText } from "@agent-workbench/shared/prompts";
import { ApiConflictError, InternalRpcHttpError, InternalRpcInvalidResponseError, type AgentApiClient, type ExecutionProfile } from "../apiClient.js";
import { computeRetryBackoffMs, normalizeModelRequestMaxRetries } from "../retry-backoff.js";
import { estimateCompactionSummaryText } from "./estimator-v1.js";
import { computeCompactionProfileFingerprint, planCompaction } from "./planner.js";
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
const COMMIT_REPLAY_DELAY_MS = 1_000;
const COMMIT_CONFIRM_MAX_MS = 1_000;

type SummaryProfile = Pick<ExecutionProfile, "provider" | "model">;

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

class CompactionRetryNoticeWriteError extends Error {
  constructor() { super("compaction retry notice write failed"); }
}
/** A stale Run must stop, not turn a notice failure into a new terminal tuple. */
export class CompactionNoticeFenceLostError extends Error {
  constructor() { super("compaction notice run fence lost"); }
}

export type CompactionExecutorDependencies = {
  apiClient: Pick<AgentApiClient, "getExecutionProfile" | "getCompactionSource" | "commitCompactionWithTerminalIntent" | "confirmCompactionCommit">;
  nowMs?: () => number;
  /** Test seam only; overrides the mode-resolved compaction deadline. */
  workDeadlineMsByMode?: Partial<Record<CompactionMode, number>>;
  /** Test seam only; production waits must remain abortable. */
  summaryRetrySleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  /** Test seam only for exact commit replay; production waits remain abortable. */
  commitRetrySleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  /** Called before each summary retry wait; not part of the provider retry count. */
  onSummaryRetry?: (input: {
    expectedRevision: number;
    retryAttempt: number;
    maxRetries: number;
    delayMs: number;
    abortSignal: AbortSignal;
  }) => Promise<void>;
  newId: (prefix: string) => string;
  generateSummary: (params: {
    profile: SummaryProfile;
    system: string;
    messages: ModelMessage[];
    timeoutMs: number | null;
    abortSignal: AbortSignal;
  }) => Promise<{ text: string }>;
};

function compactionPrompt(uiLocale: "zh-CN" | "en-US" | null) {
  return getPromptText(uiLocale === "zh-CN"
    ? "agent/compaction-user-prompt.zh-CN.txt"
    : "agent/compaction-user-prompt.en-US.txt");
}


function primarySummaryProfile(profile: ExecutionProfile): SummaryProfile {
  return { provider: profile.provider, model: profile.model };
}

function selectedSummaryProfile(profile: ExecutionProfile): SummaryProfile {
  return profile.compaction ?? primarySummaryProfile(profile);
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
    const workDeadlineMs = this.workDeadlineMs(params.mode, params.profile);
    const deadline = workDeadlineMs == null ? null : this.nowMs() + workDeadlineMs;
    const casState = params.casState ?? { remaining: policy.casReplanAllowance };
    const messageId = this.dependencies.newId("message");
    const textPartId = this.dependencies.newId("part");
    const deadlineController = new AbortController();
    const abortForCallerCancellation = () => deadlineController.abort();
    params.abortSignal.addEventListener("abort", abortForCallerCancellation, { once: true });
    const deadlineTimer = workDeadlineMs == null ? null : setTimeout(() => deadlineController.abort(), workDeadlineMs);
    // A definitive non-commit may return skipped or replan only while this work
    // is still live. A confirmed commit must instead retain its success result.
    const stopAfterNonCommit = (): Extract<CompactionExecutionResult, { kind: "failed" | "unavailable" }> | null => {
      if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
      if (deadline != null && (deadlineController.signal.aborted || deadline - this.nowMs() < MIN_REMAINING_MS)) {
        return { kind: "unavailable", reason: "deadline" };
      }
      return null;
    };
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
        // Control reads can resolve normally after cancellation or the deadline.
        const sourceRemaining = this.remaining(deadline, deadlineController.signal, params.abortSignal);
        const fingerprint = computeCompactionProfileFingerprint(profile);
        if (initialFingerprint == null) initialFingerprint = fingerprint;
        else if (fingerprint !== initialFingerprint) {
          return params.mode === "proactive"
            ? { kind: "skipped", reason: "profile_changed" }
            : { kind: "skipped", reason: "cas_conflict" };
        }
        const source = await this.dependencies.apiClient.getCompactionSource({
          workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId,
        }, { abortSignal: deadlineController.signal, ...this.remainingTimeoutOption(sourceRemaining) });
        this.remaining(deadline, deadlineController.signal, params.abortSignal);
        const planned = planCompaction({ source, profile, mode: params.mode });
        this.remaining(deadline, deadlineController.signal, params.abortSignal);
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
            uiLocale: source.uiLocale,
            expectedRevision: plan.expectedRevision,
            profile,
            system: source.oneShotSystem,
            deadline,
            abortSignal: deadlineController.signal,
          });
          this.remaining(deadline, deadlineController.signal, params.abortSignal);
        } catch (error) {
          if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
          if (error instanceof CompactionWorkDeadlineExceededError) return { kind: "unavailable", reason: "deadline" };
          if (deadlineController.signal.aborted || (deadline != null && this.nowMs() >= deadline)) return { kind: "unavailable", reason: "deadline" };
          if (error instanceof CompactionNoticeFenceLostError) throw error;
          if (error instanceof CompactionPlanningError) return { kind: "failed", reason: "data_invariant" };
          if (error instanceof CompactionRetryNoticeWriteError) return { kind: "failed", reason: "control" };
          return { kind: "failed", reason: "provider" };
        }
        if (!summaryText) return { kind: "skipped", reason: "no_progress" };

        const estimatedAfter = estimateCompactionSummaryText(summaryText) + plan.estimatedRetainedCost;
        this.remaining(deadline, deadlineController.signal, params.abortSignal);
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
          // `ignored` also covers an exact-replay mismatch, not just a lost
          // Run fence. An `updated` response without an artifact ID is equally
          // unsafe to treat as a CAS skip. Neither permits this Worker to
          // continue the turn or select a new terminal intent.
          return { kind: "failed", reason: "commit_outcome_uncertain" };
        } catch (error) {
          if (!(error instanceof ApiConflictError)) {
            if (commitAttempted && this.isCommitOutcomeUncertain(error)) {
              // Once sent, cancellation/timeout stops work but cannot prove the
              // write absent. A separate, bounded read may establish success.
              const confirmMs = deadline == null ? COMMIT_CONFIRM_MAX_MS
                : Math.min(COMMIT_CONFIRM_MAX_MS, deadline - this.nowMs());
              if (confirmMs <= 0) return { kind: "failed", reason: "commit_outcome_uncertain" };
              const confirmationController = new AbortController();
              const confirmationTimer = setTimeout(() => confirmationController.abort(), confirmMs);
              try {
                const confirmed = await this.dependencies.apiClient.confirmCompactionCommit({
                  workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId, messageId,
                }, { abortSignal: confirmationController.signal, timeoutMs: confirmMs });
                if (confirmed.outcome === "committed") return { kind: "committed", summaryMessageId: messageId, plan };
                // This is a read-only observation, not a barrier against a
                // previously sent request that may still arrive later.
                return { kind: "failed", reason: "commit_outcome_uncertain" };
              } catch {
                return { kind: "failed", reason: "commit_outcome_uncertain" };
              } finally {
                clearTimeout(confirmationTimer);
              }
            }
            if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
            // Before the first write request no remote state could have changed.
            if (!commitAttempted && error instanceof CompactionWorkDeadlineExceededError) {
              return { kind: "unavailable", reason: "deadline" };
            }
            return { kind: "failed", reason: this.isControlError(error) ? "control" : "data_invariant" };
          }
          const stop = stopAfterNonCommit();
          if (stop) return stop;
          if (casState.remaining <= 0) return { kind: "skipped", reason: "cas_conflict" };
          casState.remaining -= 1;
        }
      }
    } catch (error) {
      if (params.abortSignal.aborted) return { kind: "failed", reason: "cancelled" };
      if (error instanceof CompactionWorkDeadlineExceededError || deadlineController.signal.aborted || (deadline != null && this.nowMs() >= deadline)) {
        return { kind: "unavailable", reason: "deadline" };
      }
      if (error instanceof CompactionNoticeFenceLostError) throw error;
      if (error instanceof CompactionPlanningError) return { kind: "failed", reason: "data_invariant" };
      if (this.isTransientControlError(error)) return { kind: "unavailable", reason: "transient" };
      return { kind: "failed", reason: this.isControlError(error) ? "control" : "data_invariant" };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      params.abortSignal.removeEventListener("abort", abortForCallerCancellation);
    }
  }

  private workDeadlineMs(mode: CompactionMode, profile: ExecutionProfile) {
    const testDeadlineMs = this.dependencies.workDeadlineMsByMode?.[mode];
    if (testDeadlineMs !== undefined) return testDeadlineMs;
    const configured = Math.max(0, Math.floor(Number(profile.runtime.modelTotalTimeoutMs)));
    return configured > 0 ? configured : null;
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
      const sleep = this.dependencies.commitRetrySleep ?? ((ms: number, signal: AbortSignal) => this.sleepWithAbort(ms, signal));
      if (!await sleep(COMMIT_REPLAY_DELAY_MS, params.abortSignal)) {
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

  private async summarize(params: {
    blocks: readonly SummaryInputBlock[];
    uiLocale: "zh-CN" | "en-US" | null;
    expectedRevision: number;
    profile: ExecutionProfile;
    system: string;
    deadline: number | null;
    abortSignal: AbortSignal;
  }) {
    const messages = [...summaryInputToModelMessages(params.blocks), { role: "user" as const, content: compactionPrompt(params.uiLocale) }];
    const profile = selectedSummaryProfile(params.profile);
    const maxRetries = normalizeModelRequestMaxRetries(params.profile.runtime.modelRequestMaxRetries);
    for (let retryCount = 0; ; retryCount += 1) {
      // Validate the shared work deadline before the provider call, not in its retry catch.
      if (params.abortSignal.aborted) throw new CompactionWorkDeadlineExceededError();
      const timeoutMs = this.remaining(params.deadline, params.abortSignal);
      let response: { text: string };
      try {
        response = await this.dependencies.generateSummary({ profile, system: params.system, messages, timeoutMs, abortSignal: params.abortSignal });
      } catch (error) {
        if (params.abortSignal.aborted || (params.deadline != null && this.nowMs() >= params.deadline)) {
          throw new CompactionWorkDeadlineExceededError();
        }
        if (retryCount >= maxRetries) throw error;
        const delayMs = computeRetryBackoffMs(retryCount, params.profile.runtime.modelRequestRetryBackoffMaxMs);
        if (params.deadline != null && this.nowMs() + delayMs >= params.deadline) {
          throw new CompactionWorkDeadlineExceededError();
        }
        try {
          await this.dependencies.onSummaryRetry?.({
            expectedRevision: params.expectedRevision,
            retryAttempt: retryCount + 1,
            maxRetries,
            delayMs,
            abortSignal: params.abortSignal,
          });
        } catch (noticeError) {
          if (params.abortSignal.aborted || (params.deadline != null && this.nowMs() >= params.deadline)) {
            throw new CompactionWorkDeadlineExceededError();
          }
          if (noticeError instanceof CompactionNoticeFenceLostError) throw noticeError;
          throw new CompactionRetryNoticeWriteError();
        }
        this.remaining(params.deadline, params.abortSignal);
        const sleep = this.dependencies.summaryRetrySleep ?? ((ms: number, signal: AbortSignal) => this.sleepWithAbort(ms, signal));
        if (!await sleep(delayMs, params.abortSignal)) throw new CompactionWorkDeadlineExceededError();
        continue;
      }
      return String(response.text || "").trim();
    }
  }
}
