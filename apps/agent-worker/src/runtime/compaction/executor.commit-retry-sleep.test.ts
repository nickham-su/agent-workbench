import assert from "node:assert/strict";
import test from "node:test";
import { InternalRpcNetworkError } from "../apiClient.js";
import { CompactionExecutor, type CompactionExecutorDependencies } from "./executor.js";
import { testProfile, testSource } from "./test-fixtures.js";

type Sleep = NonNullable<CompactionExecutorDependencies["commitRetrySleep"]>;
type Commit = CompactionExecutorDependencies["apiClient"]["commitCompactionWithTerminalIntent"];
type CommitRequest = Parameters<Commit>[0];
type CallOptions = { abortSignal?: AbortSignal; timeoutMs?: number };
type ExecutorTestAccess = {
  sleepWithAbort: Sleep;
  commitExactReplay: (input: {
    request: CommitRequest;
    deadline: number | null;
    abortSignal: AbortSignal;
    callerSignal: AbortSignal;
    onAttempt: () => void;
  }) => ReturnType<Commit>;
};
type Seams = Pick<CompactionExecutorDependencies, "commitRetrySleep" | "summaryRetrySleep">;

function fixture(seams: Seams = {}, input: {
  commitFailures?: number;
  summaryFailures?: number;
  confirm?: (options: CallOptions) => Promise<{ outcome: "committed" | "not_committed" }>;
} = {}) {
  const requests: CommitRequest[] = [];
  const commitOptions: CallOptions[] = [];
  const confirmations: CallOptions[] = [];
  const summarySignals: AbortSignal[] = [];
  const profile = { ...testProfile, runtime: { ...testProfile.runtime, modelRequestMaxRetries: 1 } };
  const executor = new CompactionExecutor({
    ...seams,
    apiClient: {
      async getExecutionProfile() { return profile; },
      async getCompactionSource() { return testSource({ texts: ["x".repeat(100_000), "recent"] }); },
      async commitCompactionWithTerminalIntent(request: CommitRequest, options: CallOptions) {
        requests.push(request);
        commitOptions.push(options);
        if (requests.length <= (input.commitFailures ?? 1)) {
          throw new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" });
        }
        return { result: "updated", summaryMessageId: "summary" };
      },
      async confirmCompactionCommit(_request: unknown, options: CallOptions) {
        confirmations.push(options);
        return input.confirm ? await input.confirm(options) : { outcome: "not_committed" };
      },
    } as unknown as CompactionExecutorDependencies["apiClient"],
    newId: (prefix) => `${prefix}-id`,
    async generateSummary(params) {
      summarySignals.push(params.abortSignal);
      if (summarySignals.length <= (input.summaryFailures ?? 0)) throw new Error("temporary summary failure");
      return { text: "brief summary" };
    },
  });
  return {
    executor, requests, commitOptions, confirmations, summarySignals,
    // 隔离验证默认等待/精确重放，避免全局假时钟推进 execute 的 deadline；不导出内部 helper。
    access: executor as unknown as ExecutorTestAccess,
    execute(signal = new AbortController().signal) {
      return executor.execute({ mode: "manual", profile, workspaceId: "ws", sessionId: "session", runId: "run", abortSignal: signal });
    },
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function assertConfirmationSignal(options: CallOptions, workSignal: AbortSignal, callerSignal: AbortSignal) {
  assert.ok(options.abortSignal);
  assert.notEqual(options.abortSignal, workSignal);
  assert.notEqual(options.abortSignal, callerSignal);
  assert.equal(options.abortSignal.aborted, false);
  assert.equal(options.timeoutMs, 1_000);
}

test("默认 commit 重放在 1000ms 到达前不发送第二次请求，完成后清理等待", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const workSignal = new AbortController().signal;
  const callerSignal = new AbortController().signal;
  const remove = t.mock.method(workSignal, "removeEventListener");
  const clear = t.mock.method(globalThis, "clearTimeout");
  let attempts = 0;
  let settled = false;
  const request = { messageId: "message-id" } as CommitRequest;
  const pending = f.access.commitExactReplay({
    request, deadline: null, abortSignal: workSignal, callerSignal, onAttempt: () => { attempts++; },
  }).then((result) => { settled = true; return result; });
  await nextTurn();
  assert.equal(f.requests.length, 1);
  t.mock.timers.tick(999);
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(f.requests.length, 1);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(clear.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal((await pending).result, "updated");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0], request);
  assert.equal(f.requests[1], request);
  assert.equal(attempts, 2);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(remove.mock.calls[0]?.arguments[0], "abort");
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(f.confirmations.length, 0);
});

test("默认 commit 等待遇到已取消 signal 返回 false，不注册监听或计时器", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const add = t.mock.method(controller.signal, "addEventListener");
  const timer = t.mock.method(globalThis, "setTimeout");
  assert.equal(await fixture().access.sleepWithAbort(1_000, controller.signal), false);
  assert.equal(add.mock.callCount(), 0);
  assert.equal(timer.mock.callCount(), 0);
});

test("默认 commit 等待中取消返回 false 并清理监听和计时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const clear = t.mock.method(globalThis, "clearTimeout");
  const pending = fixture().access.sleepWithAbort(1_000, controller.signal);
  t.mock.timers.tick(100);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
  t.mock.timers.tick(1_000);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
});

test("commit 等待注入 false 不再重放，仍通过独立 bounded confirmation 判定", async () => {
  const caller = new AbortController();
  const waits: Array<{ ms: number; signal: AbortSignal }> = [];
  const f = fixture({ commitRetrySleep: async (ms, signal) => {
    waits.push({ ms, signal });
    return false;
  } }, { confirm: async (options) => {
    assertConfirmationSignal(options, waits[0]!.signal, caller.signal);
    return { outcome: "not_committed" };
  } });
  assert.deepEqual(await f.execute(caller.signal), { kind: "failed", reason: "commit_outcome_uncertain" });
  assert.equal(f.requests.length, 1);
  assert.equal(f.confirmations.length, 1);
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.ms, 1_000);
  assert.equal(waits[0]!.signal, f.commitOptions[0]!.abortSignal);
  assert.notEqual(waits[0]!.signal, caller.signal);
  assert.equal(waits[0]!.signal.aborted, false);
});

for (const outcome of ["committed", "not_committed", "unavailable"] as const) {
  test(`commit 退避中 caller abort 保留独立确认结果：${outcome}`, { timeout: 5_000 }, async () => {
    const caller = new AbortController();
    let started!: (signal: AbortSignal) => void;
    const waiting = new Promise<AbortSignal>((resolve) => { started = resolve; });
    const waits: number[] = [];
    let cleaned = false;
    const f = fixture({ commitRetrySleep: async (ms, signal) => {
      waits.push(ms);
      return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          cleaned = true;
          resolve(false);
        };
        if (signal.aborted) { cleaned = true; resolve(false); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        started(signal);
      });
    } }, { confirm: async (options) => {
      assertConfirmationSignal(options, f.commitOptions[0]!.abortSignal!, caller.signal);
      if (outcome === "unavailable") throw new Error("confirmation unavailable");
      return { outcome };
    } });
    const pending = f.execute(caller.signal);
    try {
      const workSignal = await waiting;
      assert.equal(workSignal, f.commitOptions[0]!.abortSignal);
      assert.notEqual(workSignal, caller.signal);
      assert.equal(workSignal.aborted, false);
      caller.abort();
      const result = await pending;
      assert.equal(workSignal.aborted, true);
      assert.equal(cleaned, true);
      assert.deepEqual(waits, [1_000]);
      assert.equal(f.requests.length, 1);
      assert.equal(f.confirmations.length, 1);
      if (outcome === "committed") {
        assert.equal(result.kind, "committed");
        if (result.kind === "committed") assert.equal(result.summaryMessageId, "message-id");
      } else {
        assert.deepEqual(result, { kind: "failed", reason: "commit_outcome_uncertain" });
      }
    } finally {
      caller.abort();
      await pending;
    }
  });
}

test("summary 与 commit 等待注入独立，分别保留 2000ms 和 1000ms", async () => {
  const summaryWaits: Array<{ ms: number; signal: AbortSignal }> = [];
  const commitWaits: Array<{ ms: number; signal: AbortSignal }> = [];
  const f = fixture({
    summaryRetrySleep: async (ms, signal) => {
      summaryWaits.push({ ms, signal });
      return !signal.aborted;
    },
    commitRetrySleep: async (ms, signal) => {
      commitWaits.push({ ms, signal });
      return !signal.aborted;
    },
  }, { summaryFailures: 1 });
  const caller = new AbortController();
  assert.equal((await f.execute(caller.signal)).kind, "committed");
  assert.equal(f.summarySignals.length, 2);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1], f.requests[0]);
  assert.deepEqual(summaryWaits.map(({ ms }) => ms), [2_000]);
  assert.deepEqual(commitWaits.map(({ ms }) => ms), [1_000]);
  assert.equal(summaryWaits[0]!.signal, f.summarySignals[0]);
  assert.equal(commitWaits[0]!.signal, f.commitOptions[0]!.abortSignal);
  assert.equal(summaryWaits[0]!.signal, commitWaits[0]!.signal);
  assert.notEqual(commitWaits[0]!.signal, caller.signal);
  assert.equal(f.confirmations.length, 0);
});
