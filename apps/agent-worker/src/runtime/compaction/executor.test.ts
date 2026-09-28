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
  summaryRetrySleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  onSummaryRetry?: (input: { retryAttempt: number; maxRetries: number; delayMs: number; abortSignal: AbortSignal }) => Promise<void>;
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
    summaryRetrySleep: input?.summaryRetrySleep,
    onSummaryRetry: input?.onSummaryRetry,
    newId: (prefix) => `${prefix}-id`,
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
  assert.equal(manual.summaries.length, 2, "a definitive CAS conflict regenerates the full summary once");
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

test("definitive CAS conflict or ignored commit after deadline cannot skip or replan", async () => {
  for (const mode of ["manual", "proactive"] as const) {
    for (const outcome of ["conflict", "ignored"] as const) {
      let now = 0;
      let commits = 0;
      let confirmations = 0;
      const { executor, summaries } = createExecutor({
        source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
        nowMs: () => now,
        workDeadlineMsByMode: { [mode]: 100 },
        commit: async () => {
          commits += 1;
          now = 100;
          if (outcome === "conflict") throw new ApiConflictError("definitive conflict");
          return { result: "ignored", summaryMessageId: null };
        },
        confirm: async () => { confirmations += 1; return { outcome: "not_committed" }; },
      });
      assert.deepEqual(await executor.execute({ ...args, mode }), outcome === "ignored"
        ? { kind: "failed", reason: "commit_outcome_uncertain" }
        : { kind: "unavailable", reason: "deadline" });
      assert.equal(commits, 1, "manual must not replan after a late definitive CAS conflict");
      assert.equal(summaries.length, 1);
      assert.equal(confirmations, 0, "definitive non-commit needs no outcome confirmation");
    }
  }
});

test("caller cancellation takes priority over a late definitive CAS conflict", async () => {
  let now = 0;
  const controller = new AbortController();
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    nowMs: () => now,
    workDeadlineMsByMode: { manual: 100 },
    commit: async () => { now = 100; controller.abort(); throw new ApiConflictError("conflict"); },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "manual", abortSignal: controller.signal }), { kind: "failed", reason: "cancelled" });
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

test("summary resolves normally after the work deadline: empty and no-progress text cannot skip", async () => {
  for (const mode of ["manual", "proactive"] as const) {
    for (const summary of ["", "x".repeat(200_000)]) {
      let now = 0;
      const { executor, requests, summaries } = createExecutor({
        source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
        nowMs: () => now,
        workDeadlineMsByMode: { [mode]: 100 },
        generateSummary: async () => {
          now = 100;
          return { text: summary };
        },
      });
      assert.deepEqual(await executor.execute({ ...args, mode }), { kind: "unavailable", reason: "deadline" });
      assert.equal(summaries.length, 1);
      assert.equal(requests.length, 0);
    }
  }
});

test("late profile/source reads cannot return normal skips, including no-prefix planning", async () => {
  const noPrefix = testSource({ texts: ["summary", "new"], types: ["compaction", "user"] });
  for (const mode of ["manual", "proactive"] as const) {
    let now = 0;
    let sourceReads = 0;
    const afterProfile = createExecutor({
      source: noPrefix,
      nowMs: () => now,
      workDeadlineMsByMode: { [mode]: 100 },
      onGetExecutionProfile: () => { now = 100; },
      onGetCompactionSource: () => { sourceReads += 1; },
    });
    assert.deepEqual(await afterProfile.executor.execute({ ...args, mode }), { kind: "unavailable", reason: "deadline" });
    assert.equal(sourceReads, 0);

    now = 0;
    const afterSource = createExecutor({
      source: noPrefix,
      nowMs: () => now,
      workDeadlineMsByMode: { [mode]: 100 },
      onGetCompactionSource: () => { now = 100; },
    });
    assert.deepEqual(await afterSource.executor.execute({ ...args, mode }), { kind: "unavailable", reason: "deadline" });
    assert.equal(afterSource.summaries.length, 0);

    // The clock reaches the deadline on the check immediately after planning:
    // a no-prefix result is valid only if the work is still in time.
    let clockReads = 0;
    const afterPlanning = createExecutor({
      source: noPrefix,
      nowMs: () => clockReads++ < 4 ? 0 : 100,
      workDeadlineMsByMode: { [mode]: 100 },
    });
    assert.deepEqual(await afterPlanning.executor.execute({ ...args, mode }), { kind: "unavailable", reason: "deadline" });
    assert.equal(afterPlanning.summaries.length, 0);

    now = 0;
    const noWork = createExecutor({ source: noPrefix, nowMs: () => now, workDeadlineMsByMode: { [mode]: 100 } });
    assert.deepEqual(await noWork.executor.execute({ ...args, mode }), { kind: "skipped", reason: "no_prefix" });
  }
});

test("caller cancellation takes precedence over deadline even when a read returns a normal skip", async () => {
  let now = 0;
  const controller = new AbortController();
  const { executor } = createExecutor({
    source: testSource({ texts: ["summary", "new"], types: ["compaction", "user"] }),
    nowMs: () => now,
    workDeadlineMsByMode: { proactive: 100 },
    onGetCompactionSource: () => { now = 100; controller.abort(); },
  });
  assert.deepEqual(
    await executor.execute({ ...args, mode: "proactive", abortSignal: controller.signal }),
    { kind: "failed", reason: "cancelled" },
  );
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
    { kind: "failed", reason: "commit_outcome_uncertain" },
  );
  assert.equal(commitCalls, 1);
  assert.equal(confirmations, 1, "caller cancellation must not suppress bounded read-only confirmation");
});

test("cancel after a lost commit response confirms the persisted manual completion", async () => {
  const caller = new AbortController();
  let confirmations = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => {
      caller.abort();
      throw new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" });
    },
    confirm: async () => { confirmations += 1; return { outcome: "committed" }; },
  });
  assert.equal((await executor.execute({ ...args, mode: "manual", abortSignal: caller.signal })).kind, "committed");
  assert.equal(confirmations, 1);
});

test("negative confirmation after response loss is not proof an in-flight write cannot commit", async () => {
  let confirmations = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => { throw new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" }); },
    confirm: async () => { confirmations += 1; return { outcome: "not_committed" }; },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "commit_outcome_uncertain" });
  assert.equal(confirmations, 1);
});

test("ignored proactive commit is not an ordinary CAS conflict", async () => {
  const { executor, requests } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => ({ result: "ignored", summaryMessageId: null }),
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "commit_outcome_uncertain" });
  assert.equal(requests.length, 1);
});

test("an updated commit without an artifact ID cannot be treated as a CAS skip", async () => {
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => ({ result: "updated", summaryMessageId: null }),
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "proactive" }),
    { kind: "failed", reason: "commit_outcome_uncertain" });
});

test("仅 caller signal abort 映射 cancelled；Provider 自身 AbortError 按摘要错误处理", async () => {
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
    { kind: "failed", reason: "provider" },
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

test("both modes retry all summary errors using model retry count and capped exponential backoff", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  for (const mode of ["proactive", "manual"] as const) {
    for (const retries of [0, 1, 5, 100]) {
      for (const status of [400, 401, 429, 500]) {
        const delays: number[] = [];
        const profile = { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: retries, modelRequestRetryBackoffMaxMs: 8_000 } };
        let attempts = 0;
        const { executor, summaries } = createExecutor({
          source, profile,
          summaryRetrySleep: async (ms) => { delays.push(ms); return true; },
          generateSummary: async () => {
            attempts += 1;
            throw Object.assign(new Error("context length exceeded"), { statusCode: status });
          },
        });
        assert.deepEqual(await executor.execute({ ...args, mode }), { kind: "failed", reason: "provider" });
        assert.equal(attempts, retries + 1, `${mode}, N=${retries}, status=${status}`);
        assert.equal(summaries.length, retries + 1);
        assert.deepEqual(delays, Array.from({ length: retries }, (_, i) => Math.min(8_000, 2_000 * 2 ** i)));
      }
    }
  }
});

test("summary retry progress is emitted before waiting, only for scheduled retries", async () => {
  for (const mode of ["proactive", "manual"] as const) {
    const events: Array<{ retryAttempt: number; maxRetries: number; delayMs: number; abortSignal: AbortSignal }> = [];
    let calls = 0;
    const { executor } = createExecutor({
      source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
      profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 2, modelRequestRetryBackoffMaxMs: 8_000 } },
      onSummaryRetry: async (event) => { events.push(event); },
      summaryRetrySleep: async (_ms, signal) => {
        assert.equal(signal, events.at(-1)?.abortSignal);
        return true;
      },
      generateSummary: async () => {
        calls += 1;
        throw new Error("private provider response");
      },
    });
    assert.deepEqual(await executor.execute({ ...args, mode }), { kind: "failed", reason: "provider" });
    assert.equal(calls, 3);
    assert.deepEqual(events.map(({ retryAttempt, maxRetries, delayMs }) => ({ retryAttempt, maxRetries, delayMs })), [
      { retryAttempt: 1, maxRetries: 2, delayMs: 2_000 },
      { retryAttempt: 2, maxRetries: 2, delayMs: 4_000 },
    ]);
  }
});

test("work deadline before retry wait does not publish an impossible retry notice", async () => {
  let notices = 0;
  let sleeps = 0;
  const { executor, summaries } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 5 } },
    workDeadlineMsByMode: { proactive: 1_000 },
    nowMs: () => 0,
    onSummaryRetry: async () => { notices += 1; },
    summaryRetrySleep: async () => { sleeps += 1; return true; },
    generateSummary: async () => { throw new Error("private provider response"); },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "proactive" }), { kind: "unavailable", reason: "deadline" });
  assert.equal(summaries.length, 1);
  assert.equal(notices, 0);
  assert.equal(sleeps, 0);
});

test("retry notice control write failure is not retried as a provider request", async () => {
  const { executor, summaries } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 5 } },
    onSummaryRetry: async () => { throw new Error("notice write failed"); },
    summaryRetrySleep: async () => { throw new Error("should not sleep"); },
    generateSummary: async () => { throw new Error("private provider response"); },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "control" });
  assert.equal(summaries.length, 1);
});

test("summary retry recovers from errors regardless of status, but empty success is not retried", async () => {
  for (const mode of ["proactive", "manual"] as const) {
    let calls = 0;
    const { executor, summaries } = createExecutor({
      source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
      profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 1 } },
      summaryRetrySleep: async () => true,
      generateSummary: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
        return { text: "brief summary" };
      },
    });
    assert.equal((await executor.execute({ ...args, mode })).kind, "committed");
    assert.equal(summaries.length, 2);
  }
  const empty = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    summary: "",
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 5 } },
  });
  assert.deepEqual(await empty.executor.execute({ ...args, mode: "proactive" }), { kind: "skipped", reason: "no_progress" });
  assert.equal(empty.summaries.length, 1);
});

test("a summary stream failure after partial output retries the complete input", async () => {
  let calls = 0;
  const { executor, summaries } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 1 } },
    summaryRetrySleep: async () => true,
    generateSummary: async () => {
      calls += 1;
      if (calls === 1) throw new Error("summary stream stopped after partial output");
      return { text: "brief summary" };
    },
  });
  assert.equal((await executor.execute({ ...args, mode: "proactive" })).kind, "committed");
  assert.equal(calls, 2);
  assert.deepEqual(summaries[0]?.messages, summaries[1]?.messages);
});

test("summary retries stop on cancellation or shared deadline, not on provider error names", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "recent"] });
  const caller = new AbortController();
  let calls = 0;
  const cancelled = createExecutor({
    source,
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 5 } },
    generateSummary: async () => {
      calls += 1;
      caller.abort();
      throw new Error("provider failed");
    },
  });
  assert.deepEqual(await cancelled.executor.execute({ ...args, mode: "proactive", abortSignal: caller.signal }), { kind: "failed", reason: "cancelled" });
  assert.equal(calls, 1);

  let now = 0;
  calls = 0;
  const deadline = createExecutor({
    source, nowMs: () => now, workDeadlineMsByMode: { proactive: 100 },
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 5 } },
    summaryRetrySleep: async () => { now = 100; return true; },
    generateSummary: async () => { calls += 1; throw new Error("provider failed"); },
  });
  assert.deepEqual(await deadline.executor.execute({ ...args, mode: "proactive" }), { kind: "unavailable", reason: "deadline" });
  assert.equal(calls, 1);
});

test("caller cancellation during summary backoff stops before a second request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    profile: { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 5 } },
    summaryRetrySleep: async (_ms, signal) => {
      controller.abort();
      assert.equal(signal.aborted, true);
      return false;
    },
    generateSummary: async () => { calls += 1; throw new Error("transport interrupted"); },
  });
  assert.deepEqual(
    await executor.execute({ ...args, mode: "proactive", abortSignal: controller.signal }),
    { kind: "failed", reason: "cancelled" },
  );
  assert.equal(calls, 1);
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

test("late confirmation preserves a committed artifact; a negative observation stays uncertain", async () => {
  for (const outcome of ["committed", "not_committed"] as const) {
    let now = 0;
    let confirmations = 0;
    const { executor, requests } = createExecutor({
      source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
      nowMs: () => now,
      workDeadlineMsByMode: { proactive: 100 },
      commit: async () => { throw new Error("commit response missing"); },
      confirm: async () => { confirmations += 1; now = 100; return { outcome }; },
    });
    const result = await executor.execute({ ...args, mode: "proactive" });
    assert.equal(requests.length, 1);
    assert.equal(confirmations, 1, "the outcome must be confirmed before deciding whether a timed-out Run can continue");
    if (outcome === "committed") {
      assert.equal(result.kind, "committed");
      if (result.kind === "committed") assert.equal(result.summaryMessageId, "message-id");
    } else {
      assert.deepEqual(result, { kind: "failed", reason: "commit_outcome_uncertain" });
    }
  }
});

test("caller cancellation cannot turn a negative confirmation of an in-flight commit into cancelled", async () => {
  const controller = new AbortController();
  let confirmations = 0;
  const { executor } = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: async () => { throw new Error("commit response missing"); },
    confirm: async () => { confirmations += 1; controller.abort(); return { outcome: "not_committed" }; },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "proactive", abortSignal: controller.signal }), { kind: "failed", reason: "commit_outcome_uncertain" });
  assert.equal(confirmations, 1);
});

test("a negative or unconfirmable response-loss observation both fail closed", async () => {
  const retryableCommit = async () => {
    const error = new Error("response lost");
    error.name = "InternalRpcNetworkError";
    throw error;
  };
  const missing = createExecutor({ source: testSource({ texts: ["x".repeat(100_000), "recent"] }), commit: retryableCommit, confirm: async () => ({ outcome: "not_committed" }) });
  assert.deepEqual(await missing.executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "commit_outcome_uncertain" });

  const unknown = createExecutor({
    source: testSource({ texts: ["x".repeat(100_000), "recent"] }),
    commit: retryableCommit,
    confirm: async () => { throw new Error("confirm unavailable"); },
  });
  assert.deepEqual(await unknown.executor.execute({ ...args, mode: "proactive" }), { kind: "failed", reason: "commit_outcome_uncertain" });
});

test("configured summary model is the only model used; capacity errors do not split the complete input", async () => {
  const source = testSource({ texts: ["x".repeat(100_000), "y".repeat(100_000), "recent"] });
  const candidate: ExecutionProfile = {
    ...testProfile,
    runtime: { ...testProfile.runtime, modelRequestMaxRetries: 1 },
    compaction: { source: "runtime_compaction", provider: testProfile.provider, model: { ...testProfile.model, id: "summary", providerModelId: "summary" } },
  };
  const models: string[] = [];
  const { executor, summaries } = createExecutor({
    source, profile: candidate,
    summaryRetrySleep: async () => true,
    generateSummary: async (request) => {
      models.push((request.profile as { model: { id: string } }).model.id);
      throw Object.assign(new Error("context_length_exceeded"), { statusCode: 400 });
    },
  });
  assert.deepEqual(await executor.execute({ ...args, mode: "manual" }), { kind: "failed", reason: "provider" });
  assert.deepEqual(models, ["summary", "summary"]);
  assert.deepEqual(summaries[0]?.messages, summaries[1]?.messages);
  assert.equal(JSON.stringify(summaries[0]?.messages).includes("x"), true);
  assert.equal(JSON.stringify(summaries[0]?.messages).includes("y"), true);
});
