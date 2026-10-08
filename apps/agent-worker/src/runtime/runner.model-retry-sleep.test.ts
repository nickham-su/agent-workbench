import assert from "node:assert/strict";
import test from "node:test";
import { InternalRpcNetworkError } from "./apiClient.js";
import { AgentRunner } from "./runner.js";

type Deps = NonNullable<ConstructorParameters<typeof AgentRunner>[4]>;
type Sleep = NonNullable<Deps["modelRetrySleep"]>;
type Notice = { retryCount: number | null; nextRetryAt: number | null };
type RunnerTestAccess = {
  modelRetrySleepFn: Sleep;
  toolRegistry: { listTools: () => Promise<never[]> };
  runModelStep: (input: Record<string, unknown>) => Promise<{ aborted: boolean }>;
};

function fixture(deps: Deps = {}, options: { failures?: number; failNoticeOnce?: boolean } = {}) {
  let calls = 0;
  let noticeCalls = 0;
  const notices: Notice[] = [];
  const backend = {
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
    async completeAssistant() { return { result: "updated" }; },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async updateRunNotice(notice: Notice) {
      if (options.failNoticeOnce && noticeCalls++ === 0) {
        throw new InternalRpcNetworkError({ method: "POST", endpoint: "/notice" });
      }
      notices.push(notice);
      return { result: "updated" };
    },
  };
  const runner = new AgentRunner(
    backend as unknown as ConstructorParameters<typeof AgentRunner>[0],
    {} as ConstructorParameters<typeof AgentRunner>[1],
    { info() {}, warn() {}, error() {} }, 1,
    {
      streamText: (() => {
        calls++;
        const failed = calls <= (options.failures ?? 1);
        return {
          fullStream: (async function* () {
            if (failed) throw new Error("temporary Provider failure");
            yield { type: "text-delta", id: "answer", text: "recovered" };
          })(),
          usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null),
        };
      }) as unknown as NonNullable<Deps["streamText"]>,
      ...deps,
    }
  );
  const access = runner as unknown as RunnerTestAccess;
  access.toolRegistry.listTools = async () => [];
  return {
    get calls() { return calls; }, notices,
    // 单独验证默认等待器，避免对带流与 I/O 的 runModelStep 全局替换时钟；不导出生产内部 helper。
    defaultSleep: access.modelRetrySleepFn,
    invoke(signal: AbortSignal, retries = 1) {
      return access.runModelStep({
        profile: {
          model: { id: "model" }, provider: { id: "provider", npm: "@ai-sdk/anthropic", options: {} },
          agent: { tools: [], pluginTools: [], mcpServers: [] },
          runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: retries,
            modelRequestRetryBackoffMaxMs: 60_000 },
        },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(),
          workspaceRepoDirNames: [], inputText: "hello" },
        context: { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "", messages: [],
          providerReplay: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] },
        step: 1, signal, repeatedToolCallCounter: new Map(),
      });
    },
  };
}

test("默认模型退避等待在 2000ms 到达前不结束，到达后返回 true", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { defaultSleep } = fixture();
  const signal = new AbortController().signal;
  const remove = t.mock.method(signal, "removeEventListener");
  let settled = false;
  const pending = defaultSleep(2_000, signal).then((result) => { settled = true; return result; });
  t.mock.timers.tick(1_999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(remove.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(await pending, true);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(remove.mock.calls[0]?.arguments[0], "abort");
});

test("默认模型退避等待遇到已取消 signal 返回 false 且不注册监听", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const add = t.mock.method(controller.signal, "addEventListener");
  assert.equal(await fixture().defaultSleep(2_000, controller.signal), false);
  assert.equal(add.mock.callCount(), 0);
});

test("默认模型退避等待中取消返回 false 并清理监听和计时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const clear = t.mock.method(globalThis, "clearTimeout");
  const pending = fixture().defaultSleep(2_000, controller.signal);
  t.mock.timers.tick(100);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
  t.mock.timers.tick(2_000);
});

test("模型等待注入保留指数退避、通知时间和次数，且传入原始 signal", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  const runner = fixture({
    nowMs: () => 100,
    modelRetrySleep: async (ms, signal) => {
      assert.equal(signal, controller.signal);
      delays.push(ms);
      return !signal.aborted;
    },
  }, { failures: 2 });
  assert.equal((await runner.invoke(controller.signal, 2)).aborted, false);
  assert.equal(runner.calls, 3);
  assert.deepEqual(delays, [2_000, 4_000]);
  assert.deepEqual(runner.notices.filter((notice) => notice.retryCount).map((notice) =>
    [notice.retryCount, notice.nextRetryAt]), [[1, 2_100], [2, 4_100]]);
});

test("模型等待注入返回 false 时不调用下一次 Provider 请求", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  const runner = fixture({ modelRetrySleep: async (ms, signal) => {
    assert.equal(signal, controller.signal);
    delays.push(ms);
    return false;
  } });
  assert.equal((await runner.invoke(controller.signal)).aborted, true);
  assert.equal(runner.calls, 1);
  assert.deepEqual(delays, [2_000]);
});

test("模型等待注入等待中响应取消，且不调用下一次 Provider 请求", { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  let waiting!: () => void;
  const started = new Promise<void>((resolve) => { waiting = resolve; });
  const runner = fixture({ modelRetrySleep: async (ms, signal) => {
    assert.equal(ms, 2_000);
    assert.equal(signal, controller.signal);
    return await new Promise<boolean>((resolve) => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
      waiting();
    });
  } });
  const pending = runner.invoke(controller.signal);
  await started;
  controller.abort();
  assert.equal((await pending).aborted, true);
  assert.equal(runner.calls, 1);
});

test("模型退避与控制面等待注入互不替代", async () => {
  const controller = new AbortController();
  const modelDelays: number[] = [];
  const controlDelays: number[] = [];
  const runner = fixture({
    modelRetrySleep: async (ms, signal) => {
      assert.equal(signal, controller.signal);
      modelDelays.push(ms);
      return !signal.aborted;
    },
    controlWriteSleep: async (ms, signal) => {
      assert.equal(signal, controller.signal);
      controlDelays.push(ms);
      return !signal.aborted;
    },
  }, { failNoticeOnce: true });
  assert.equal((await runner.invoke(controller.signal)).aborted, false);
  assert.equal(runner.calls, 2);
  assert.deepEqual(modelDelays, [2_000]);
  assert.deepEqual(controlDelays, [100]);
});
