import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTimelineRefreshScheduler } from "./agentTimelineRefreshScheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("snapshot active 后 before 保持独立 intent，持续 delta 不会饿死分页", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const first = deferred<void>();
  const deltaStarted = deferred<void>();
  const second = deferred<void>();
  const modes: string[] = [];
  const runner = async (mode: "snapshot" | "delta" | "before") => {
    modes.push(mode);
    if (modes.length === 1) await first.promise;
    if (mode === "delta" && modes.length === 2) {
      deltaStarted.resolve();
      await second.promise;
    }
    return mode === "before" ? { paginationExhausted: true } : undefined;
  };
  const snapshot = scheduler.request("snapshot", runner);
  const before = scheduler.request("before", runner);
  const delta = scheduler.request("delta", runner);
  first.resolve();
  await deltaStarted.promise;
  // 又一个 delta 在首个 delta 执行期间抵达，但不得再次越过已等待的 pagination。
  const laterDelta = scheduler.request("delta", runner);
  second.resolve();
  await Promise.all([snapshot, before, delta, laterDelta]);
  assert.deepEqual(modes, ["snapshot", "delta", "before", "delta"]);
});

test("before cursor 失效后 snapshot，再用新 cursor 实际执行 before", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const modes: string[] = [];
  await scheduler.request("before", async (mode) => {
    modes.push(mode);
    return mode === "before" && modes.length === 1
      ? { requestSnapshot: true }
      : mode === "before"
        ? { paginationExhausted: true }
        : undefined;
  });
  assert.deepEqual(modes, ["before", "snapshot", "before"]);
});

test("before 在仍有 cursor 时保持 waiter，并在后续页耗尽后才结算", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const modes: string[] = [];
  let completed = false;
  await scheduler.request("before", async (mode) => {
    modes.push(mode);
    return modes.length === 1 ? undefined : { paginationExhausted: true };
  }).then(() => { completed = true; });
  assert.equal(completed, true);
  assert.deepEqual(modes, ["before", "before"]);
});

test("before 只有服务端确认无更多页时才结算", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const page = deferred<void>();
  let completed = false;
  const request = scheduler.request("before", async () => {
    await page.promise;
    return { paginationExhausted: true };
  }).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  page.resolve();
  await request;
  assert.equal(completed, true);
});

test("结构 snapshot 临时失败会退避重试至成功", async () => {
  const timers: Array<() => void> = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    structuralRetryDelaysMs: [0],
  });
  let calls = 0;
  const done = scheduler.requestStructuralSnapshot(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary network failure");
  });
  await tick();
  assert.equal(calls, 1);
  assert.equal(timers.length, 1);
  timers.shift()!();
  await done;
  assert.equal(calls, 2);
});

test("结构 snapshot 永久失败仅尝试初始加退避次数，耗尽后拒绝并释放 waiter", async () => {
  const timers: Array<() => void> = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    structuralRetryDelaysMs: [0, 0],
  });
  let calls = 0;
  const pending = scheduler.requestStructuralSnapshot(async () => {
    calls += 1;
    throw new Error(`failure ${calls}`);
  });
  // 初始一次，随后仅由两个配置的 timer 各重试一次。
  await tick();
  timers.shift()!();
  await tick();
  timers.shift()!();
  await assert.rejects(pending, /failure 3/);
  assert.equal(calls, 3);
  assert.equal(scheduler.hasPending(), false);
});

test("结构退避期间 delta 排队但不绕过失败 snapshot，pagination 可独立完成", async () => {
  const timers: Array<() => void> = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    structuralRetryDelaysMs: [0],
  });
  const modes: string[] = [];
  let structuralCalls = 0;
  const structural = scheduler.requestStructuralSnapshot(async (mode) => {
    modes.push(`structural:${mode}`);
    structuralCalls += 1;
    if (structuralCalls === 1) throw new Error("temporary");
  });
  await tick();
  const delta = scheduler.request("delta", async (mode) => { modes.push(`tail:${mode}`); });
  const before = scheduler.request("before", async (mode) => {
    modes.push(`page:${mode}`);
    return { paginationExhausted: true };
  });
  await before;
  assert.deepEqual(modes, ["structural:snapshot", "page:before"]);
  assert.equal(structuralCalls, 1);
  timers.shift()!();
  await Promise.all([structural, delta]);
  assert.deepEqual(modes, ["structural:snapshot", "page:before", "structural:snapshot", "structural:delta"]);
});

test("结构 snapshot 成功后重置 retry 状态且无残留 pending", async () => {
  const cleared: unknown[] = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    clearTimeout: ((timer) => { cleared.push(timer); }) as typeof clearTimeout,
    structuralRetryDelaysMs: [0],
  });
  await scheduler.requestStructuralSnapshot(async () => undefined);
  assert.deepEqual(cleared, []);
  assert.equal(scheduler.hasPending(), false);
});

test("退避期间 invalidate 清除旧 timer，并让新 structural snapshot 立即合并旧 waiter", async () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((timer) => { (timer as unknown as Timer).cleared = true; }) as typeof clearTimeout,
    structuralRetryDelaysMs: [10],
  });
  const calls: Array<{ mode: string; epoch: number }> = [];
  let attempts = 0;
  const runner = async (mode: "snapshot" | "delta" | "before", epoch: number) => {
    calls.push({ mode, epoch });
    attempts += 1;
    if (attempts === 1) throw new Error("temporary");
  };

  const old = scheduler.requestStructuralSnapshot(runner);
  await tick();
  assert.equal(timers.length, 1);
  const oldRetry = timers[0]!;
  const nextEpoch = scheduler.invalidate();
  const fresh = scheduler.requestStructuralSnapshot(runner);
  await Promise.all([old, fresh]);

  assert.equal(oldRetry.cleared, true);
  assert.equal(nextEpoch, 1);
  assert.deepEqual(calls, [
    { mode: "snapshot", epoch: 0 },
    { mode: "snapshot", epoch: 1 },
  ]);
  assert.equal(scheduler.hasPending(), false);
});

test("dispose 在结构退避期间清 timer、结算 waiter 且不会再次尝试", async () => {
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: ((timer) => { cleared.push(timer); }) as typeof clearTimeout,
    structuralRetryDelaysMs: [0],
  });
  let calls = 0;
  const pending = scheduler.requestStructuralSnapshot(async () => {
    calls += 1;
    throw new Error("temporary");
  });
  await tick();
  scheduler.dispose();
  await pending;
  assert.equal(calls, 1);
  assert.equal(cleared.length, 1);
  timers.shift()!();
  await tick();
  assert.equal(calls, 1);
  assert.equal(scheduler.hasPending(), false);
});

test("delta runner 超过 watchdog 后中止并改用 structural snapshot", async () => {
  const timers: Array<() => void> = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    runnerWatchdogMs: 1,
  });
  const entered = deferred<void>();
  const modes: string[] = [];
  let aborted = false;
  const runner = async (mode: "snapshot" | "delta" | "before", _epoch: number, signal: AbortSignal) => {
    modes.push(mode);
    if (mode === "delta") {
      entered.resolve();
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await new Promise<void>(() => undefined);
    }
  };

  const pending = scheduler.request("delta", runner);
  await entered.promise;
  timers.shift()!();
  await pending;

  assert.equal(aborted, true);
  assert.deepEqual(modes, ["delta", "snapshot"]);
  assert.equal(scheduler.hasPending(), false);
});

test("watchdog 使忽略 Abort 的旧 runner 失效，晚到失败不会污染新 structural snapshot", async () => {
  const timers: Array<() => void> = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    runnerWatchdogMs: 1,
  });
  const lateOldRun = deferred<void>();
  const observed: string[] = [];
  const accepted: string[] = [];
  let deltaSettled = 0;
  const runner = async (mode: "snapshot" | "delta" | "before", runnerEpoch: number) => {
    observed.push(`${mode}:${runnerEpoch}`);
    if (mode === "delta") {
      try {
        await lateOldRun.promise;
      } catch {
        if (scheduler.currentEpoch() === runnerEpoch) accepted.push(`late:${runnerEpoch}`);
        throw new Error("late old runner failure");
      }
      return;
    }
    if (scheduler.currentEpoch() === runnerEpoch) accepted.push(`snapshot:${runnerEpoch}`);
  };

  const pending = scheduler.request("delta", runner).then(() => { deltaSettled += 1; });
  await tick();
  timers.shift()!();
  await pending;
  lateOldRun.reject(new Error("network finished after watchdog"));
  await tick();

  assert.deepEqual(observed, ["delta:0", "snapshot:1"]);
  assert.deepEqual(accepted, ["snapshot:1"]);
  assert.equal(deltaSettled, 1);
  assert.equal(scheduler.hasPending(), false);
});

test("structural snapshot runner watchdog 有限重试并最终释放 waiter", async () => {
  const timers: Array<() => void> = [];
  const scheduler = createAgentTimelineRefreshScheduler({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    structuralRetryDelaysMs: [0, 0],
    runnerWatchdogMs: 1,
  });
  let calls = 0;
  const pending = scheduler.requestStructuralSnapshot(async () => {
    calls += 1;
    await new Promise<void>(() => undefined);
  });
  const rejected = assert.rejects(pending, /watchdog deadline/);

  await tick();
  timers.shift()!(); // initial snapshot watchdog
  await tick();
  timers.shift()!(); // first structural retry delay
  await tick();
  timers.shift()!(); // first retry watchdog
  await tick();
  timers.shift()!(); // second structural retry delay
  await tick();
  timers.shift()!(); // second retry watchdog
  await rejected;

  assert.equal(calls, 3);
  assert.equal(scheduler.hasPending(), false);
});

test("invalidate 中止 active runner 后 structural snapshot 不受旧请求阻塞", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const entered = deferred<void>();
  const modes: string[] = [];
  let aborted = false;
  const runner = async (mode: "snapshot" | "delta" | "before", _epoch: number, signal: AbortSignal) => {
    modes.push(mode);
    if (mode === "delta") {
      entered.resolve();
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await new Promise<void>(() => undefined);
    }
  };

  const delta = scheduler.request("delta", runner);
  await entered.promise;
  const nextEpoch = scheduler.invalidate();
  const snapshot = scheduler.requestStructuralSnapshot(runner);
  await Promise.all([delta, snapshot]);

  assert.equal(nextEpoch, 1);
  assert.equal(aborted, true);
  assert.deepEqual(modes, ["delta", "snapshot"]);
  assert.equal(scheduler.hasPending(), false);
});

test("dispose abort active runner 并结算 active/pending waiter", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const entered = deferred<void>();
  let aborted = false;
  const runner = async (_mode: "snapshot" | "delta" | "before", _epoch: number, signal: AbortSignal) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  };
  const active = scheduler.request("snapshot", runner);
  await entered.promise;
  const pending = scheduler.request("before", runner);
  scheduler.dispose();
  await Promise.all([active, pending]);
  assert.equal(aborted, true);
  assert.equal(scheduler.hasPending(), false);
});

test("结构 mutation 提升 epoch，mutation 前的晚到响应可被调用方拒绝", async () => {
  const scheduler = createAgentTimelineRefreshScheduler();
  const request = deferred<void>();
  let capturedEpoch = -1;
  const pending = scheduler.request("delta", async (_mode, epoch) => {
    capturedEpoch = epoch;
    await request.promise;
  });
  const nextEpoch = scheduler.invalidate();
  request.resolve();
  await pending;
  assert.equal(capturedEpoch, 0);
  assert.equal(nextEpoch, 1);
  assert.notEqual(capturedEpoch, scheduler.currentEpoch());
});
