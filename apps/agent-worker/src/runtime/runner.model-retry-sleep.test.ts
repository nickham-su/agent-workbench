import assert from "node:assert/strict";
import test from "node:test";
import { InternalRpcNetworkError } from "./apiClient.js";
import { AgentRunner } from "./runner.js";
import type { PromptContext } from "./apiClient.js";
import type { ResolvedToolDefinition } from "./tools/types.js";

type Deps = NonNullable<ConstructorParameters<typeof AgentRunner>[4]>;
type Sleep = NonNullable<Deps["modelRetrySleep"]>;
type Notice = { retryCount: number | null; nextRetryAt: number | null };
type RunnerTestAccess = {
  modelRetrySleepFn: Sleep;
  toolRegistry: { listTools: () => Promise<ResolvedToolDefinition[]> };
  runModelStep: (input: Record<string, unknown>) => Promise<{ aborted: boolean; availableToolNames?: ReadonlySet<string> }>;
};

function fixture(deps: Deps = {}, options: {
  failures?: number;
  contextPreparationMs?: number | null;
  failNoticeOnce?: boolean;
  tools?: ResolvedToolDefinition[];
  context?: Partial<PromptContext>;
  refreshContext?: () => Promise<PromptContext>;
  successToolCalls?: string[];
} = {}) {
  let calls = 0;
  let noticeCalls = 0;
  const notices: Notice[] = [];
  const requests: Array<Parameters<NonNullable<Deps["streamText"]>>[0]> = [];
  let contextReads = 0;
  let assistantCreates = 0;
  let assistantReplacements = 0;
  const backend = {
    async createStreamingAssistant() { assistantCreates++; return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
    async completeAssistant() { return { result: "updated" }; },
    async replaceStreamingAssistant() { assistantReplacements++; return { result: "updated" }; },
    async getPromptContext() {
      contextReads++;
      assert.ok(options.refreshContext, "retry without subtask must not query PromptContext");
      return options.refreshContext();
    },
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
      preparationRandom: () => 0,
      streamText: ((request: Parameters<NonNullable<Deps["streamText"]>>[0]) => {
        calls++;
        requests.push(request);
        const failed = calls <= (options.failures ?? 1);
        return {
          fullStream: (async function* () {
            if (failed) throw new Error("temporary Provider failure");
            yield { type: "text-delta", id: "answer", text: "recovered" };
            for (const toolName of options.successToolCalls ?? []) {
              yield { type: "tool-call", toolName, toolCallId: `call-${toolName}`, input: {} };
            }
          })(),
          usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null),
        };
      }) as unknown as NonNullable<Deps["streamText"]>,
      ...deps,
    }
  );
  const access = runner as unknown as RunnerTestAccess;
  access.toolRegistry.listTools = async () => options.tools ?? [];
  return {
    get calls() { return calls; }, notices,
    requests,
    get contextReads() { return contextReads; },
    get assistantCreates() { return assistantCreates; }, get assistantReplacements() { return assistantReplacements; },
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
          providerReplay: [], lastResponseTotalTokens: null, uiLocale: null, workspaceRepoNames: [], externalSkills: [],
          ...options.context },
        contextPreparationMs: options.contextPreparationMs === undefined ? 0 : options.contextPreparationMs,
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

test("subtask 重试只刷新候选描述，保留消息、replay、工具/schema 和执行快照", async () => {
  const tools: ResolvedToolDefinition[] = [
    { name: "subtask", description: "Available agents: A, B", inputSchema: { type: "object" }, source: "builtin" },
    { name: "read", description: "Read base", inputSchema: { type: "object" }, source: "builtin" },
  ];
  const messages = [{ role: "user" as const, content: "original user message" }];
  const providerReplay: NonNullable<PromptContext["providerReplay"]> = [];
  let prepared = 0;
  let attempts = 0;
  let refreshes = 0;
  const attemptContext = { providerNpm: "@ai-sdk/anthropic", protocol: "openai-responses", protocolVersion: 1, providerId: "provider", model: "model" };
  const adapterRegistry = { resolve: () => ({
    prepareInvocation(input: { messages: unknown[]; history: unknown; providerOptions: unknown }) {
      prepared++;
      assert.equal(input.messages, messages);
      assert.equal(input.history, providerReplay);
      return { messages: input.messages, providerOptions: input.providerOptions, attemptContext };
    },
    createAttempt(input: unknown) {
      attempts++;
      assert.equal(input, attemptContext);
      return { observeChunk() { return {}; }, finalizeAttempt() { return { ok: true }; } };
    },
  }) };
  const runner = fixture({
    modelRetrySleep: async () => true,
    providerConversationStateAdapterRegistry: adapterRegistry as unknown as NonNullable<Deps["providerConversationStateAdapterRegistry"]>,
  }, {
    failures: 2, tools, context: { messages, providerReplay, system: "original system" },
    successToolCalls: ["subtask", "injected"],
    refreshContext: async () => ({
      pendingTools: [], tools: [
        { name: "subtask", description: ++refreshes === 1 ? "Available agents: A" : "No agents are currently available", inputSchema: { type: "string" } },
        { name: "injected", description: "not part of this turn", inputSchema: {} },
      ],
      headMessageId: "changed", sessionRevision: 99, system: "changed system", messages: [],
      providerReplay: [], lastResponseTotalTokens: null, uiLocale: null, workspaceRepoNames: [], externalSkills: [],
    }),
  });
  const result = await runner.invoke(new AbortController().signal, 2);
  assert.equal(result.aborted, false);
  assert.equal(runner.contextReads, 2);
  assert.equal(prepared, 1, "conversation-state preparation must not rerun on retries");
  assert.equal(attempts, 3);
  assert.equal(runner.assistantCreates, 1);
  assert.equal(runner.assistantReplacements, 0, "description refresh must not change Assistant boundaries");
  assert.equal(runner.requests[0]?.tools?.subtask?.description, "Available agents: A, B");
  assert.deepEqual(runner.requests.map((request) => request.tools?.subtask?.description), [
    "Available agents: A, B", "Available agents: A", "No agents are currently available",
  ]);
  for (const request of runner.requests.slice(1)) {
    assert.equal(request.system, "original system");
    assert.deepEqual(request.messages, messages);
    assert.equal(request.providerOptions, runner.requests[0]?.providerOptions);
    assert.deepEqual(Object.keys(request.tools ?? {}), ["subtask", "read"]);
    assert.equal(request.tools?.read, runner.requests[0]?.tools?.read);
    assert.equal(request.tools?.subtask?.inputSchema, runner.requests[0]?.tools?.subtask?.inputSchema);
  }
  assert.deepEqual([...(result.availableToolNames ?? [])], ["subtask", "read"]);
  assert.equal(tools[0]?.description, "Available agents: A, B");
});

test("subtask 重试刷新失败属于本地错误，不继续重试 Provider", async () => {
  const failure = new Error("cannot read current Workspace enablement");
  const runner = fixture({ modelRetrySleep: async () => true }, {
    tools: [{ name: "subtask", description: "Available agents: A", inputSchema: {}, source: "builtin" }],
    refreshContext: async () => { throw failure; },
  });
  await assert.rejects(runner.invoke(new AbortController().signal, 3), (error) => error === failure);
  assert.equal(runner.calls, 1);
  assert.equal(runner.contextReads, 1);
});

test("subtask 重试刷新缺失描述时拒绝发送旧候选列表", async () => {
  const runner = fixture({ modelRetrySleep: async () => true }, {
    tools: [{ name: "subtask", description: "Available agents: A", inputSchema: {}, source: "builtin" }],
    refreshContext: async () => ({ tools: [] } as unknown as PromptContext),
  });
  await assert.rejects(runner.invoke(new AbortController().signal, 3), /subtask tool description is unavailable/);
  assert.equal(runner.calls, 1);
});


test("准备计时分段累加，排除 Assistant 写入与退避，共享准备仅归属首次 attempt", async () => {
  const clock = [10, 30, 1000, 1005, 10000, 10007];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const harness = fixture({
    preparationNowMs: () => { const value = clock.shift(); assert.notEqual(value, undefined); return value!; },
    modelRetrySleep: async () => true,
    analyticsSignals: { emitModel(payload: Record<string, unknown>, type: string) { events.push({ type, payload }); } } as any,
  }, { contextPreparationMs: 13 });
  await harness.invoke(new AbortController().signal);
  assert.equal(harness.calls, 2);
  assert.deepEqual(events.filter((event) => event.type === "model_invoked").map((event) => event.payload.requestPreparationMs), [38, 7]);
  assert.deepEqual(events.filter((event) => event.type === "model_finished").map((event) => event.payload.requestPreparationMs), [38, 7]);
  assert.equal(clock.length, 0);
});

for (const firstSampled of [false, true]) {
  for (const retryRandom of [0.099999, 0.1]) {
    test(`准备耗时独立采样：首轮=${firstSampled}，重试随机值=${retryRandom}`, async () => {
      const retrySampled = retryRandom < 0.1;
      const clock = [...(firstSampled ? [10, 30, 1000, 1005] : []), ...(retrySampled ? [10000, 10007] : [])];
      let randomCalls = 0;
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const harness = fixture({
        preparationRandom: () => { randomCalls++; return retryRandom; },
        preparationNowMs: () => {
          assert.ok(clock.length > 0, "未采样 attempt 不应读取计时时钟");
          return clock.shift()!;
        },
        modelRetrySleep: async () => true,
        analyticsSignals: { emitModel(payload: Record<string, unknown>, type: string) { events.push({ type, payload }); } } as any,
      }, { contextPreparationMs: firstSampled ? 13 : null });
      await harness.invoke(new AbortController().signal);
      const expected = [firstSampled ? 38 : null, retrySampled ? 7 : null];
      assert.deepEqual(events.filter((event) => event.type === "model_invoked").map((event) => event.payload.requestPreparationMs), expected);
      assert.deepEqual(events.filter((event) => event.type === "model_finished").map((event) => event.payload.requestPreparationMs), expected);
      assert.equal(events.length, 4, "未采样仍完整保留模型开始和结束事件");
      assert.equal(harness.calls, 2);
      assert.equal(randomCalls, 1, "首次复用上下文的采样决定，重试单独抽样");
      assert.equal(clock.length, 0);
    });
  }
}

test("采样后真实零耗时保持为零，不冒充未采样", async () => {
  const values: unknown[] = [];
  const harness = fixture({
    preparationNowMs: () => 100,
    analyticsSignals: { emitModel(payload: Record<string, unknown>) { values.push(payload.requestPreparationMs); } } as any,
  }, { failures: 0, contextPreparationMs: 0 });
  await harness.invoke(new AbortController().signal);
  assert.deepEqual(values, [0, 0]);
});

for (const scenario of ["direct", "pending_tools", "compaction_committed", "compaction_skipped"] as const) {
  const draws = scenario === "direct" ? [[0], [0.099999], [0.1]] : [[0, 0], [0, 0.1], [0.1, 0], [0.1, 0.1]];
  for (const samples of draws) {
    test(`最终上下文独立采样，不累加工具与压缩轮次：${scenario} ${samples}`, async () => {
      let monotonic = 0;
      let clockCalls = 0;
      let randomCalls = 0;
      let pendingDraw: number | undefined;
      const remainingDraws = [...samples];
      let reads = 0;
      let shouldCompactCalls = 0;
      const preparedContexts: Array<number | null> = [];
      const terminals: string[] = [];
      const apiClient = {
        async markRunWorkInProgress() { return { result: "updated" }; },
        async getExecutionProfile() { return { model: {}, provider: {}, agent: {}, runtime: {} }; },
        async getPromptContext() {
          assert.notEqual(pendingDraw, undefined, "必须在上下文读取前决定采样");
          pendingDraw = undefined;
          reads++;
          monotonic += scenario !== "direct" && reads === 1 ? 900 : 10;
          return {
            pendingTools: scenario === "pending_tools" && reads === 1 ? [{ status: "queued" }] : [],
            messages: [], tools: [], sessionRevision: 1,
          };
        },
        async persistRunTerminalIntent(input: { status: string }) { terminals.push(input.status); return { result: "updated" }; },
        async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "completed" }; },
      };
      const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
        preparationRandom: () => {
          randomCalls++;
          return pendingDraw = remainingDraws.shift()!;
        },
        preparationNowMs: () => { clockCalls++; return monotonic; },
      });
      const access = runner as any;
      access.shouldAutoCompact = () => scenario.startsWith("compaction") && ++shouldCompactCalls === 1;
      access.executeCompaction = async () => {
        monotonic += 5000;
        return scenario === "compaction_committed" ? { kind: "committed" } : { kind: "skipped", reason: "below_threshold" };
      };
      access.executePendingTools = async () => { monotonic += 5000; return { paused: false }; };
      access.runModelStep = async (params: { contextPreparationMs: number | null }) => {
        preparedContexts.push(params.contextPreparationMs);
        return { aborted: false, toolCallCount: 0, hasVisibleText: true, assistantMessageId: "assistant" };
      };
      await access.processRun({ workspaceId: "ws", sessionId: "session", runId: "run", runKind: "user", workspacePath: process.cwd(), workspaceRepoDirNames: [] }, new AbortController().signal);
      assert.deepEqual(preparedContexts, [samples.at(-1)! < 0.1 ? 10 : null]);
      assert.equal(reads, scenario === "direct" ? 1 : 2);
      assert.equal(randomCalls, samples.length);
      assert.equal(clockCalls, samples.filter((value) => value < 0.1).length * 2);
      assert.equal(remainingDraws.length, 0);
      assert.deepEqual(terminals, ["completed"]);
    });
  }
}
