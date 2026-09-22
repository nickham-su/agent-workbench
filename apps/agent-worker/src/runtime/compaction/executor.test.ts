import assert from "node:assert/strict";
import test from "node:test";
import { ApiConflictError, InternalRpcHttpError, InternalRpcInvalidResponseError, InternalRpcNetworkError } from "../apiClient.js";
import type { ExecutionProfile } from "../apiClient.js";
import { CompactionExecutor, CompactionWorkDeadlineExceededError } from "./executor.js";
import { testProfile, testSource } from "./test-fixtures.js";

function createExecutor(input?: {
  source?: ReturnType<typeof testSource>;
  summary?: string;
  generateSummary?: (request: Record<string, unknown>) => Promise<{ text: string }>;
  nowMs?: () => number;
  profile?: ExecutionProfile;
  onGetExecutionProfile?: (options: Record<string, unknown>) => void;
  onGetCompactionSource?: (options: Record<string, unknown>) => void;
  workDeadlineMsByMode?: { manual?: number; proactive?: number };
  confirm?: () => Promise<{ outcome: "committed" | "not_committed" }>;
  commit?: (request: Record<string, unknown>) => Promise<{ result: "updated" | "ignored"; summaryMessageId: string | null }>;
}) {
  const requests: Record<string, unknown>[] = [];
  const summaries: Array<Record<string, unknown>> = [];
  const executor = new CompactionExecutor({
    apiClient: {
      async getExecutionProfile(_request: unknown, options: Record<string, unknown>) {
        input?.onGetExecutionProfile?.(options);
        return input?.profile ?? testProfile;
      },
      async getCompactionSource(_request: unknown, options: Record<string, unknown>) {
        input?.onGetCompactionSource?.(options);
        return input?.source ?? testSource();
      },
      async commitCompactionWithTerminalIntent(request: Record<string, unknown>) {
        requests.push(request as unknown as Record<string, unknown>);
        return input?.commit
          ? await input.commit(request as unknown as Record<string, unknown>)
          : { result: "updated" as const, summaryMessageId: "summary" };
      },
      async confirmCompactionCommit() {
        return input?.confirm ? await input.confirm() : { outcome: "not_committed" as const };
      },
    } as any,
    nowMs: input?.nowMs,
    workDeadlineMsByMode: input?.workDeadlineMsByMode,
    newId: (prefix) => `${prefix}-id`,
    isContextLimitError: () => false,
    async generateSummary(request) {
      const summaryRequest = request as unknown as Record<string, unknown>;
      summaries.push(summaryRequest);
      return input?.generateSummary
        ? await input.generateSummary(summaryRequest)
        : { text: input?.summary ?? "brief summary" };
    },
  });
  return { executor, requests, summaries };
}

const args = {
  profile: testProfile,
  workspaceId: "ws",
  sessionId: "session",
  runId: "run",
  abortSignal: new AbortController().signal,
};

test("executor consumes only frozen compaction source, summaries sanitized SummaryInput, and atomically commits retained anchor", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  const { executor, requests, summaries } = createExecutor({ source });
  const result = await executor.execute({ ...args, mode: "manual" });

  assert.equal(result.kind, "committed");
  assert.equal(summaries.length, 1);
  const request = summaries[0]!;
  assert.equal(request.system, source.oneShotSystem);
  assert.equal(JSON.stringify(request.messages).includes("secret"), false);
  assert.equal(request.messages?.toString?.().includes("encrypted"), false);
  assert.deepEqual(requests[0]?.intent, { status: "completed", code: "compaction_completed", detail: null });
  assert.equal(requests[0]?.retainedFromMessageId, "m2");
  assert.equal(requests[0]?.expectedHeadMessageId, source.headMessageId);
  assert.equal(requests[0]?.expectedRevision, source.sessionRevision);
});

test("executor skips no-progress summary without a write", async () => {
  const { executor, requests } = createExecutor({ source: testSource({ texts: ["x".repeat(100_000), "recent"] }), summary: "x".repeat(200_000) });
  const result = await executor.execute({ ...args, mode: "proactive" });
  assert.deepEqual(result, { kind: "skipped", reason: "no_progress" });
  assert.equal(requests.length, 0);
});

test("executor obeys proactive CAS skip and manual single replan", async () => {
  let attempts = 0;
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  const proactive = createExecutor({
    source,
    commit: async () => { throw new ApiConflictError("conflict"); },
  });
  assert.deepEqual(await proactive.executor.execute({ ...args, mode: "proactive" }), { kind: "skipped", reason: "cas_conflict" });

  const manual = createExecutor({
    source,
    commit: async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiConflictError("conflict");
      return { result: "updated", summaryMessageId: "summary" };
    },
  });
  const result = await manual.executor.execute({ ...args, mode: "manual" });
  assert.equal(result.kind, "committed");
  assert.equal(attempts, 2);
});

test("CAS replan 清除上一轮 commit 状态，第二轮发送前 deadline 是 unavailable 且不确认", async () => {
  let now = 0;
  let commitCalls = 0;
  let confirmations = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    nowMs: () => now,
    workDeadlineMsByMode: { manual: 100 },
    commit: async () => {
      commitCalls += 1;
      if (commitCalls === 1) {
        now = 50;
        throw new ApiConflictError("definitive conflict");
      }
      throw new Error("second commit must not be sent after deadline");
    },
    confirm: async () => {
      confirmations += 1;
      return { outcome: "committed" };
    },
    generateSummary: async () => {
      now = commitCalls === 0 ? 0 : 100;
      return { text: "brief summary" };
    },
  });

  assert.deepEqual(await executor.execute({ ...args, mode: "manual" }), { kind: "unavailable", reason: "deadline" });
  assert.equal(commitCalls, 1);
  assert.equal(confirmations, 0);
});

test("CAS replan 共享 allowance，且 profile fingerprint 变化按模式处理", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  const sharedCasState = { remaining: 1 };
  const first = createExecutor({ source, commit: async () => { throw new ApiConflictError("conflict"); } });
  assert.deepEqual(await first.executor.execute({ ...args, mode: "manual", casState: sharedCasState }), { kind: "skipped", reason: "cas_conflict" });
  assert.equal(sharedCasState.remaining, 0);

  const changedProfile = { ...testProfile, model: { ...testProfile.model, contextWindowTokens: testProfile.model.contextWindowTokens + 1 } };
  for (const [mode, expected] of [
    ["proactive", "profile_changed"],
    ["manual", "cas_conflict"],
  ] as const) {
    let reads = 0;
    let commits = 0;
    const executor = new CompactionExecutor({
      apiClient: {
        async getExecutionProfile() { reads += 1; return reads === 1 ? testProfile : changedProfile; },
        async getCompactionSource() { return source; },
        async commitCompactionWithTerminalIntent() {
          commits += 1;
          if (commits === 1) throw new ApiConflictError("conflict");
          throw new Error("profile change must short-circuit before a second commit");
        },
        async confirmCompactionCommit() { return { outcome: "not_committed" as const }; },
      } as any,
      newId: (prefix) => `${prefix}-id`,
      isContextLimitError: () => false,
      async generateSummary() { return { text: "brief summary" }; },
    });
    const result = await executor.execute({ ...args, mode, casState: { remaining: 1 } });
    assert.equal(result.kind, "skipped");
    assert.equal(result.reason, expected);
    assert.equal(reads, 2);
    assert.equal(commits, 1);
  }
});

test("executor blocks pending tools before provider work", async () => {
  const pending = createExecutor({ source: testSource({ pending: true }) });
  assert.deepEqual(await pending.executor.execute({ ...args, mode: "manual" }), { kind: "blocked", reason: "pending_tool_execution" });
  assert.equal(pending.summaries.length, 0);
});

test("proactive 与 manual 的总 deadline 使用单次请求超时配置", async () => {
  for (const [mode, modelTotalTimeoutMs] of [["proactive", 61_000], ["manual", 3_000]] as const) {
    let now = 0;
    const observedTimeouts: unknown[] = [];
    const profile: ExecutionProfile = {
      ...testProfile,
      runtime: { ...testProfile.runtime, modelTotalTimeoutMs },
    };
    const { executor } = createExecutor({
      profile,
      nowMs: () => now,
      source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
      onGetExecutionProfile: (options) => observedTimeouts.push(options.timeoutMs),
      onGetCompactionSource: (options) => {
        observedTimeouts.push(options.timeoutMs);
        now = modelTotalTimeoutMs;
      },
    });

    assert.deepEqual(
      await executor.execute({ ...args, profile, mode }),
      { kind: "unavailable", reason: "deadline" },
    );
    assert.deepEqual(observedTimeouts, [modelTotalTimeoutMs, modelTotalTimeoutMs]);
  }
});

test("proactive 与 manual 在单次请求超时关闭时不设置总 deadline", async () => {
  for (const mode of ["proactive", "manual"] as const) {
    const observedTimeouts: unknown[] = [];
    const { executor } = createExecutor({
      source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
      onGetExecutionProfile: (options) => observedTimeouts.push(options.timeoutMs),
      onGetCompactionSource: (options) => observedTimeouts.push(options.timeoutMs),
    });

    assert.equal((await executor.execute({ ...args, mode })).kind, "committed");
    assert.deepEqual(observedTimeouts, [undefined, undefined]);
  }
});

test("executor enforces an absolute configured work deadline before source work", async () => {
  let reads = 0;
  const profile: ExecutionProfile = {
    ...testProfile,
    runtime: { ...testProfile.runtime, modelTotalTimeoutMs: 15_000 },
  };
  const { executor } = createExecutor({
    nowMs: () => reads++ === 0 ? 0 : 15_000,
    profile,
  });
  assert.deepEqual(
    await executor.execute({ ...args, profile, mode: "proactive" }),
    { kind: "unavailable", reason: "deadline" },
  );
});

test("executor 将 source/control 失败限定分类为 transient、control 或 data invariant", async () => {
  const executeWithSourceFailure = async (error: Error) => {
    const executor = new CompactionExecutor({
      apiClient: {
        async getExecutionProfile() { return testProfile; },
        async getCompactionSource() { throw error; },
        async commitCompactionWithTerminalIntent() { throw new Error("unexpected commit"); },
        async confirmCompactionCommit() { throw new Error("unexpected confirmation"); },
      } as any,
      newId: (prefix) => `${prefix}-id`,
      isContextLimitError: () => false,
      async generateSummary() { throw new Error("unexpected summary"); },
    });
    return await executor.execute({ ...args, mode: "manual" });
  };

  assert.deepEqual(
    await executeWithSourceFailure(new InternalRpcNetworkError({ method: "POST", endpoint: "/source" })),
    { kind: "unavailable", reason: "transient" },
  );
  assert.deepEqual(
    await executeWithSourceFailure(new InternalRpcHttpError({ method: "POST", endpoint: "/source", status: 429 })),
    { kind: "unavailable", reason: "transient" },
  );
  assert.deepEqual(
    await executeWithSourceFailure(new InternalRpcHttpError({ method: "POST", endpoint: "/source", status: 403 })),
    { kind: "failed", reason: "control" },
  );
  assert.deepEqual(
    await executeWithSourceFailure(new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/source", stage: "schema" })),
    { kind: "failed", reason: "control" },
  );
  assert.deepEqual(
    await executeWithSourceFailure(new Error("source invariant broken")),
    { kind: "failed", reason: "data_invariant" },
  );
});

test("commit 的永久 control 错误不触发 outcome confirmation", async () => {
  let confirmations = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => { throw new InternalRpcHttpError({ method: "POST", endpoint: "/complete", status: 401 }); },
    confirm: async () => {
      confirmations += 1;
      return { outcome: "committed" };
    },
  });

  assert.deepEqual(await executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "control" });
  assert.equal(confirmations, 0);
});

test("首次 commit 前 deadline 仍是 unavailable，但首次请求后退避中止必须 fail closed", async () => {
  let now = 0;
  let commitCalls = 0;
  let confirmations = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    nowMs: () => now,
    workDeadlineMsByMode: { proactive: 15_000 },
    commit: async () => {
      commitCalls += 1;
      now = 15_000;
      throw new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" });
    },
    confirm: async () => {
      confirmations += 1;
      return { outcome: "not_committed" };
    },
  });

  assert.deepEqual(
    await executor.execute({ ...args, mode: "proactive" }),
    { kind: "failed", reason: "commit_outcome_uncertain" },
  );
  assert.equal(commitCalls, 1);
  assert.equal(confirmations, 0, "work deadline 已耗尽时不把 commit outcome 伪装为 unavailable");
});

test("commit 第二次请求前耗尽时仍确认第一笔写入，不确认则 fail closed", async () => {
  let commitCalls = 0;
  let confirmations = 0;
  const controller = new AbortController();
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => {
      commitCalls += 1;
      controller.abort();
      throw new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" });
    },
    confirm: async () => {
      confirmations += 1;
      throw new Error("confirmation was interrupted");
    },
  });

  assert.deepEqual(
    await executor.execute({ ...args, mode: "manual", abortSignal: controller.signal }),
    { kind: "failed", reason: "cancelled" },
  );
  assert.equal(commitCalls, 1);
  assert.equal(confirmations, 0, "caller cancel 的终态优先于确认");
});

test("仅 caller signal abort 映射 cancelled；到达 Provider 分类器的 AbortError 是 transient", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  const providerAbort = createExecutor({
    source,
    generateSummary: async () => {
      const error = new Error("provider aborted transport");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.deepEqual(
    await providerAbort.executor.execute({ ...args, mode: "proactive" }),
    { kind: "unavailable", reason: "transient" },
  );

  const caller = new AbortController();
  caller.abort();
  const callerAbort = createExecutor({ source });
  assert.deepEqual(
    await callerAbort.executor.execute({ ...args, mode: "proactive", abortSignal: caller.signal }),
    { kind: "failed", reason: "cancelled" },
  );
});

test("Provider 因 work deadline signal 中止并抛 AbortError 时映射 deadline", async () => {
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    workDeadlineMsByMode: { proactive: 20 },
    generateSummary: async (request) => await new Promise<{ text: string }>((_resolve, reject) => {
      const signal = request.abortSignal as AbortSignal;
      signal.addEventListener("abort", () => {
        const error = new Error("provider request aborted by deadline");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });

  assert.deepEqual(
    await executor.execute({ ...args, mode: "proactive" }),
    { kind: "unavailable", reason: "deadline" },
  );
});

test("proactive does not retry a transient summary request, while manual retries it exactly once", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  let proactiveAttempts = 0;
  const proactive = createExecutor({
    source,
    generateSummary: async () => {
      proactiveAttempts += 1;
      const error = new Error("transient");
      error.name = "FetchError";
      throw error;
    },
  });
  assert.deepEqual(await proactive.executor.execute({ ...args, mode: "proactive" }), { kind: "unavailable", reason: "transient" });
  assert.equal(proactiveAttempts, 1);

  let manualAttempts = 0;
  const manual = createExecutor({
    source,
    generateSummary: async () => {
      manualAttempts += 1;
      if (manualAttempts === 1) {
        const error = new Error("transient");
        error.name = "FetchError";
        throw error;
      }
      return { text: "brief summary" };
    },
  });
  assert.equal((await manual.executor.execute({ ...args, mode: "manual" })).kind, "committed");
  assert.equal(manualAttempts, 2);
});

test("manual commit response-loss retry replays the exact artifact request", async () => {
  const { executor, requests } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => {
      if (requests.length === 1) {
        const error = new Error("response lost");
        error.name = "InternalRpcNetworkError";
        throw error;
      }
      return { result: "updated", summaryMessageId: "summary" };
    },
  });

  assert.equal((await executor.execute({ ...args, mode: "manual" })).kind, "committed");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0]?.messageId, "message-id");
  assert.equal(requests[0]?.textPartId, "part-id");
});

test("uncertain commit is confirmed before any caller can continue with the old context", async () => {
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => {
      const error = new Error("response lost");
      error.name = "InternalRpcNetworkError";
      throw error;
    },
    confirm: async () => ({ outcome: "committed" }),
  });
  const result = await executor.execute({ ...args, mode: "proactive" });
  assert.equal(result.kind, "committed");
});

test("confirmed missing compaction is the only proactive skip after response loss; unconfirmable outcome fails closed", async () => {
  const retryableCommit = async () => {
    const error = new Error("response lost");
    error.name = "InternalRpcNetworkError";
    throw error;
  };
  const missing = createExecutor({ source: testSource({ texts: ["x".repeat(100_000), "recent"] }), commit: retryableCommit, confirm: async () => ({ outcome: "not_committed" }) });
  assert.deepEqual(await missing.executor.execute({ ...args, mode: "proactive" }), { kind: "skipped", reason: "commit_not_committed" });

  const unknown = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: retryableCommit,
    confirm: async () => { throw new Error("confirm unavailable"); },
  });
  assert.deepEqual(await unknown.executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "commit_outcome_uncertain" });
});

test("candidate context limit uses primary as the second logical call before splitting", async () => {
  const profiles: string[] = [];
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  const candidate = {
    ...testProfile,
    compaction: { source: "runtime_compaction" as const, provider: testProfile.provider, model: { ...testProfile.model, id: "summary", providerModelId: "summary" } },
  };
  const executor = new CompactionExecutor({
    apiClient: {
      async getExecutionProfile() { return candidate; },
      async getCompactionSource() { return source; },
      async commitCompactionWithTerminalIntent() { return { result: "updated" as const, summaryMessageId: "summary" }; },
    } as any,
    newId: (prefix) => `${prefix}-id`,
    isContextLimitError: (error) => error instanceof Error && error.message === "limit",
    async generateSummary(request) {
      profiles.push(request.profile.model.id);
      if (request.profile.model.id === "summary") throw new Error("limit");
      return { text: "brief summary" };
    },
  });
  assert.equal((await executor.execute({ ...args, mode: "manual" })).kind, "committed");
  assert.deepEqual(profiles, ["summary", "model"]);
});

test("candidate permanent failure does not fall back to primary", async () => {
  const profiles: string[] = [];
  const candidate = {
    ...testProfile,
    compaction: { source: "runtime_compaction" as const, provider: testProfile.provider, model: { ...testProfile.model, id: "summary", providerModelId: "summary" } },
  };
  const executor = new CompactionExecutor({
    apiClient: {
      async getExecutionProfile() { return candidate; },
      async getCompactionSource() { return testSource({ texts: ["x".repeat(100_000), "recent"] }); },
      async commitCompactionWithTerminalIntent() { throw new Error("unexpected"); },
    } as any,
    newId: (prefix) => `${prefix}-id`,
    isContextLimitError: () => false,
    async generateSummary(request) {
      profiles.push(request.profile.model.id);
      const error = new Error("unauthorized");
      (error as Error & { status: number }).status = 401;
      throw error;
    },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "manual" }), { kind: "failed", reason: "provider" });
  assert.deepEqual(profiles, ["summary"]);
});

test("identical candidate and primary issue one logical call before splitting", async () => {
  let calls = 0;
  const executor = new CompactionExecutor({
    apiClient: {
      async getExecutionProfile() { return testProfile; },
      async getCompactionSource() { return testSource({ texts: ["x".repeat(100_000), "recent"] }); },
      async commitCompactionWithTerminalIntent() { throw new Error("must not commit"); },
      async confirmCompactionCommit() { return { outcome: "not_committed" as const }; },
    } as any,
    newId: (prefix) => `${prefix}-id`,
    isContextLimitError: (error) => error instanceof Error && error.message === "limit",
    async generateSummary() {
      calls += 1;
      throw new Error("limit");
    },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "manual" }), { kind: "summary_input_limit" });
  assert.equal(calls, 1);
});
