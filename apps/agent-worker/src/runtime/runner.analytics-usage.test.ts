import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { streamText } from "ai";
import { AgentRunner } from "./runner.js";

const neverSettlingUsage = new Promise<never>(() => undefined);

async function withTestDeadline<T>(operation: Promise<T>, description: string): Promise<T> {
  // Production usage probes intentionally unref their timers; this wait owns
  // a referenced, bounded deadline rather than borrowing another test's handle.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} exceeded the 750ms test deadline`)), 750);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("analytics test deadline is referenced and clears after success or rejection", async (t) => {
  const timeouts = t.mock.method(globalThis, "setTimeout");
  const clears = t.mock.method(globalThis, "clearTimeout");

  const completed = withTestDeadline(Promise.resolve("completed"), "successful fixture");
  const successTimer = timeouts.mock.calls[0]!.result as NodeJS.Timeout;
  assert.equal(successTimer.hasRef(), true);
  assert.equal(await completed, "completed");
  assert.ok(clears.mock.calls.some((call) => call.arguments[0] === successTimer));

  const failure = new Error("fixture rejected");
  const rejected = withTestDeadline(Promise.reject(failure), "rejected fixture");
  const rejectionTimer = timeouts.mock.calls[1]!.result as NodeJS.Timeout;
  assert.equal(rejectionTimer.hasRef(), true);
  await assert.rejects(rejected, (error) => error === failure);
  assert.ok(clears.mock.calls.some((call) => call.arguments[0] === rejectionTimer));
  assert.equal(timeouts.mock.callCount(), 2);
  assert.deepEqual(timeouts.mock.calls.map((call) => call.arguments[1]), [750, 750]);
});

test("analytics test deadline rejects a pending operation with diagnostics and clears its timer", async (t) => {
  const timeouts = t.mock.method(globalThis, "setTimeout");
  const clears = t.mock.method(globalThis, "clearTimeout");
  const pending = withTestDeadline(neverSettlingUsage, "pending usage fixture");
  const timer = timeouts.mock.calls[0]!.result as NodeJS.Timeout;
  assert.equal(timer.hasRef(), true);
  await assert.rejects(pending, {
    name: "Error",
    message: "pending usage fixture exceeded the 750ms test deadline",
  });
  assert.equal(timeouts.mock.callCount(), 1);
  assert.equal(timeouts.mock.calls[0]!.arguments[1], 750);
  assert.ok(clears.mock.calls.some((call) => call.arguments[0] === timer));
});

for (const providerNpm of ["@ai-sdk/openai-compatible", "@ai-sdk/moonshotai", "@ai-sdk/deepseek"] as const) {
  test(`${providerNpm} custom model ID invokes production Runner and emits one paired Analytics Attempt`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [{ content: "reply" }, {}]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
          model: "custom-provider-id", choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "custom-provider-id", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10,
          total_tokens: 1010, prompt_cache_hit_tokens: 900, cached_tokens: 900,
          prompt_tokens_details: { cached_tokens: 900 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.once("error", reject); });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const signals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
      let streamingAssistants = 0;
      const apiClient = {
        async createStreamingAssistant() { streamingAssistants++; return { result: "created" }; },
        async flushAssistantParts() { return { result: "updated" }; },
        async completeTerminalAssistant() { return { result: "updated" }; },
        async updateRunNotice() { return { result: "updated" }; },
        async replaceStreamingAssistant() { return { result: "updated" }; },
        async getPluginRuntimeSnapshots() { return { plugins: [] }; },
      };
      const runner = new AgentRunner(apiClient as any, { async listTools() { return []; } } as any,
        { info() {}, warn() {}, error() {} }, 1, {
          analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) {
            signals.push({ eventType, payload });
          } } as any,
          streamText: ((request: any) => streamText(request)) as any,
        });
      const result = await (runner as any).runModelStep({
        profile: {
          model: { id: "local-alias", providerModelId: "  custom-provider-id  ", options: undefined },
          provider: { id: "config", npm: providerNpm,
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}/v1` } },
          agent: { tools: [], pluginTools: [], mcpServers: [] },
          runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: 0, modelRequestRetryBackoffMaxMs: 1 },
        },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(),
          workspaceRepoDirNames: [], inputText: "hello" },
        context: { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "",
          messages: [{ role: "user", content: "hello" }], providerReplay: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] },
        step: 1, signal: new AbortController().signal, recoveryContinuation: { messageId: null }, repeatedToolCallCounter: new Map(),
      });
      assert.equal(result.hasVisibleText, true);
      assert.equal(streamingAssistants, 1);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]?.model, "custom-provider-id");
      if (providerNpm === "@ai-sdk/openai-compatible")
        assert.deepEqual(bodies[0]?.stream_options, { include_usage: true });
      else assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
      assert.deepEqual(signals.map(({ eventType }) => eventType), ["model_invoked", "model_finished"]);
      assert.equal(signals[0]?.payload.attemptNo, signals[1]?.payload.attemptNo);
      assert.equal(signals[1]?.payload.attemptNo, 1);
      assert.equal(signals[1]?.payload.status, "completed");
      assert.equal(signals[1]?.payload.modelId, "local-alias"); // Existing Analytics uses local ID, not providerModelId.
      assert.equal(signals[1]?.payload.cacheReadTokens, 900);
      assert.equal(signals[1]?.payload.cacheInputTokens, 1000);
      assert.equal(signals[1]?.payload.cacheComparable, true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
}

test("local pending ToolExecution fails before any network Attempt or model analytics", async () => {
  let networkCalls = 0;
  const modelEvents: string[] = [];
  const runner = new AgentRunner({} as any, { async listTools() { return []; } } as any,
    { info() {}, warn() {}, error() {} }, 1, {
      analyticsSignals: { emitModel(_payload: unknown, event: string) { modelEvents.push(event); } } as any,
      streamText: (() => { networkCalls++; throw new Error("must not send"); }) as any,
    });
  await assert.rejects((runner as any).runModelStep({
    profile: {},
    run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd() },
    context: { pendingTools: [{ status: "running" }], messages: [], system: "" },
    step: 1, signal: new AbortController().signal, repeatedToolCallCounter: new Map(),
  }), /cannot invoke model while ToolExecution remains queued or running/);
  assert.equal(networkCalls, 0);
  assert.deepEqual(modelEvents, []);
});

test("runner completes a terminal provider attempt when fullStream usage never settles", async () => {
  const modelSignals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const apiClient = {
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
    async updateRunNotice() { return { result: "updated" }; },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async getPluginRuntimeSnapshots() { return { plugins: [] }; },
  };
  const runner = new AgentRunner(apiClient as any, { async listTools() { return []; } } as any, { info() {}, warn() {}, error() {} }, 1, {
    analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) { modelSignals.push({ eventType, payload }); } } as any,
    streamText: (() => ({
      usage: neverSettlingUsage,
      totalUsage: neverSettlingUsage,
      response: neverSettlingUsage,
      fullStream: (async function* () {
        yield { type: "text-delta", id: "part-1", text: "completed" };
        yield { type: "finish", totalUsage: null };
        yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
      })(),
    })) as any,
  });

  const result = await withTestDeadline<any>(
    (runner as any).runModelStep({
      profile: {
        model: { id: "gpt-4o-mini", options: undefined },
        provider: { id: "provider", npm: "@ai-sdk/openai", options: {} },
        agent: { tools: [], pluginTools: [], mcpServers: [] },
        runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 1 },
      },
      run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "hello" },
      context: { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] },
      step: 1,
      signal: new AbortController().signal,
      recoveryContinuation: { messageId: null },
      repeatedToolCallCounter: new Map(),
    }),
    "runModelStep with never-settling optional usage",
  );

  assert.equal(result.aborted, false);
  assert.equal(result.hasVisibleText, true);
  const finished = modelSignals.find((signal) => signal.eventType === "model_finished");
  assert.ok(finished);
  assert.equal(finished.payload.totalSource, "unavailable");
  assert.equal(finished.payload.totalTokens, null);
  assert.equal(finished.payload.inputTokens, null);
  assert.equal(finished.payload.outputTokens, null);
});

async function finishedModelUsage(options: {
  npm: string;
  usage: Record<string, unknown> | Promise<never>;
  totalUsage?: Record<string, unknown> | Promise<never>;
  response?: unknown;
  stepUsage?: Record<string, unknown>;
  finishTotalUsage?: Record<string, unknown> | null;
  metadata?: unknown;
  steps?: number;
  baseURL?: string;
  businessTotals?: Array<number | null>;
}) {
  const signals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const apiClient = {
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant(request: { responseTotalTokens: number | null }) {
      options.businessTotals?.push(request.responseTotalTokens);
      return { result: "updated" };
    },
    async updateRunNotice() { return { result: "updated" }; },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async getPluginRuntimeSnapshots() { return { plugins: [] }; },
  };
  const runner = new AgentRunner(apiClient as any, { async listTools() { return []; } } as any, { info() {}, warn() {}, error() {} }, 1, {
    analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) { signals.push({ eventType, payload }); } } as any,
    streamText: (() => ({
      usage: Promise.resolve(options.usage),
      totalUsage: Promise.resolve(options.totalUsage ?? options.usage),
      response: Promise.resolve(options.response ?? null),
      fullStream: (async function* () {
        yield { type: "text-delta", id: "part-1", text: "completed" };
        for (let index = 0; index < (options.steps ?? 1); index++)
          yield { type: "finish-step", usage: options.stepUsage ?? options.usage, providerMetadata: options.metadata };
        yield { type: "finish", totalUsage: options.finishTotalUsage === undefined ? options.usage : options.finishTotalUsage };
        yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
      })(),
    })) as any,
  });
  const result = await withTestDeadline<any>((runner as any).runModelStep({
    profile: {
      model: { id: "model", options: undefined },
      provider: { id: "provider", npm: options.npm, options: { baseURL: options.baseURL } },
      agent: { tools: [], pluginTools: [], mcpServers: [] },
      runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 1 },
    },
    run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "hello" },
    context: { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] },
    step: 1,
    signal: new AbortController().signal,
    recoveryContinuation: { messageId: null },
    repeatedToolCallCounter: new Map(),
  }), `runModelStep (${options.npm}, steps=${options.steps ?? 1})`);
  assert.equal(result.aborted, false);
  return signals.find((signal) => signal.eventType === "model_finished")?.payload;
}

test("Analytics prefers a complete total from another stream alias without combining partial candidates", async () => {
  const reported = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 7 },
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  assert.equal(reported?.totalSource, "reported");
  assert.equal(reported?.totalTokens, 15);
  assert.equal(reported?.inputTokens, 10);
  assert.equal(reported?.outputTokens, 5);

  const nested = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 7 }, totalUsage: { outputTokens: 5 },
    response: { usage: { inputTokens: 3 }, totalUsage: { inputTokens: 4, outputTokens: 5 } },
  });
  assert.equal(nested?.totalSource, "derived");
  assert.equal(nested?.totalTokens, 9);

  const partial = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 7 }, totalUsage: { outputTokens: 5 },
  });
  assert.equal(partial?.totalSource, "unavailable");
  assert.equal(partial?.totalTokens, null);
  assert.equal(partial?.inputTokens, 7);
  assert.equal(partial?.outputTokens, null);

  const unavailable = await finishedModelUsage({ npm: "@ai-sdk/openai", usage: {}, totalUsage: {}, response: {} });
  assert.equal(unavailable?.totalSource, "unavailable");
  assert.equal(unavailable?.totalTokens, null);
  assert.equal(unavailable?.inputTokens, null);
  assert.equal(unavailable?.outputTokens, null);
});

test("Analytics only accepts safe token integers while preserving genuine zero and decimal strings", async () => {
  for (const invalid of [null, undefined, true, false, "", "  ", 1.9, "1.9", "1e3", -1, -0.5,
    Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    const payload = await finishedModelUsage({
      npm: "@ai-sdk/openai",
      usage: { inputTokens: invalid, outputTokens: invalid, totalTokens: invalid },
    });
    assert.equal(payload?.totalSource, "unavailable", `invalid value ${typeof invalid}: ${String(invalid)}`);
    assert.equal(payload?.totalTokens, null);
    assert.equal(payload?.inputTokens, null);
    assert.equal(payload?.outputTokens, null);
  }

  const partial = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 4, outputTokens: null, totalTokens: null },
  });
  assert.equal(partial?.totalSource, "unavailable");
  assert.equal(partial?.totalTokens, null);
  assert.equal(partial?.inputTokens, 4);
  assert.equal(partial?.outputTokens, null);

  const reportedZero = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
  assert.equal(reportedZero?.totalSource, "reported");
  assert.equal(reportedZero?.totalTokens, 0);
  assert.equal(reportedZero?.inputTokens, 0);
  assert.equal(reportedZero?.outputTokens, 0);

  const derivedZero = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 0, outputTokens: 0, totalTokens: null },
  });
  assert.equal(derivedZero?.totalSource, "derived");
  assert.equal(derivedZero?.totalTokens, 0);

  const decimalString = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: " 2 ", outputTokens: "3", totalTokens: "5" },
  });
  assert.equal(decimalString?.totalSource, "reported");
  assert.equal(decimalString?.totalTokens, 5);
  assert.equal(decimalString?.inputTokens, 2);
  assert.equal(decimalString?.outputTokens, 3);

  const aliasAfterNull = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { totalTokens: null, total_tokens: "7" },
  });
  assert.equal(aliasAfterNull?.totalSource, "reported");
  assert.equal(aliasAfterNull?.totalTokens, 7, "an explicit null must not shadow a valid alias with a fake zero");
});

test("business responseTotalTokens validates observed finish.totalUsage without coercing missing usage", async () => {
  for (const invalid of [null, undefined, true, false, "", " ", 1.9, "1.9", -1,
    Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}]) {
    const businessTotals: Array<number | null> = [];
    await finishedModelUsage({
      npm: "@ai-sdk/openai", usage: {}, finishTotalUsage: { totalTokens: invalid }, businessTotals,
    });
    assert.deepEqual(businessTotals, [null], `finish must not coerce ${typeof invalid} into a total`);
  }

  for (const [finishTotalUsage, expected] of [
    [{ totalTokens: null, total_tokens: "7" }, 7],
    [{ totalTokens: 1.9, total_tokens: "7" }, 7],
    [{ inputTokens: "2", outputTokens: "3", totalTokens: null }, 5],
    [{ totalTokens: 0 }, 0],
  ] as const) {
    const businessTotals: Array<number | null> = [];
    await finishedModelUsage({ npm: "@ai-sdk/openai", usage: {}, finishTotalUsage, businessTotals });
    assert.deepEqual(businessTotals, [expected], "valid finish alias, derived sum or real zero must survive");
  }
});

test("business responseTotalTokens validates stream usage and nested response aliases after invalid finish", async () => {
  for (const invalid of [null, undefined, true, false, "", " ", 1.9, "1.9", -1,
    Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}]) {
    const businessTotals: Array<number | null> = [];
    await finishedModelUsage({
      npm: "@ai-sdk/openai", usage: { totalTokens: invalid }, finishTotalUsage: null, businessTotals,
    });
    assert.deepEqual(businessTotals, [null], `stream must not coerce ${typeof invalid} into a total`);
  }

  for (const [usage, expected] of [
    [{ totalTokens: null, total_tokens: "8" }, 8],
    [{ totalTokens: true, total_tokens: "8" }, 8],
    [{ totalTokens: 1.9, total_tokens: "8" }, 8],
    [{ inputTokens: 1.9, outputTokens: 3 }, null],
    [{ inputTokens: "2", outputTokens: "3" }, 5],
    [{ totalTokens: 0 }, 0],
  ] as const) {
    const businessTotals: Array<number | null> = [];
    await finishedModelUsage({ npm: "@ai-sdk/openai", usage, finishTotalUsage: null, businessTotals });
    assert.deepEqual(businessTotals, [expected], "select only a valid stream alias or complete component sum");
  }

  const businessTotals: Array<number | null> = [];
  await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: {}, totalUsage: {}, finishTotalUsage: null,
    response: { usage: { totalTokens: null }, totalUsage: { totalTokens: "8" } },
    businessTotals,
  });
  assert.deepEqual(businessTotals, [8], "a null nested usage must not hide a valid totalUsage alias");
});

test("single-step total-only usage retains consistent earlier input and cache data", async () => {
  const usage = { inputTokens: 1000, cachedInputTokens: 900 };
  const payload = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage,
    totalUsage: { outputTokens: 10, totalTokens: 1010 },
  });
  assert.equal(payload?.totalSource, "reported");
  assert.equal(payload?.totalTokens, 1010);
  assert.equal(payload?.inputTokens, 1000);
  assert.equal(payload?.outputTokens, 10);
  assert.equal(payload?.cacheReadTokens, 900);
  assert.equal(payload?.cacheInputTokens, 1000);
  assert.equal(payload?.cacheComparable, true);
});

test("conflicting components are not merged or used for a comparable cache denominator", async () => {
  const payload = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 7, cachedInputTokens: 2 },
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  assert.equal(payload?.totalTokens, 15);
  assert.equal(payload?.inputTokens, 10);
  assert.equal(payload?.outputTokens, 5);
  assert.equal(payload?.cacheReadTokens, null);
  assert.equal(payload?.cacheComparable, false);

  const impossibleTriple = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: { inputTokens: 7 },
    totalUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 15 },
    stepUsage: { inputTokens: 7 },
  });
  assert.equal(impossibleTriple?.totalTokens, 15);
  assert.equal(impossibleTriple?.inputTokens, 10);
  assert.equal(impossibleTriple?.outputTokens, null, "never emit a triple rejected by the fact-table constraint");
});

test("contradictory same-scope stream, finish, and step totals stay unavailable", async () => {
  const cases = [
    {
      name: "stream usage disagrees with totalUsage and the observed step",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stepUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishTotalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    {
      name: "finish disagrees with the stream aliases",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      totalUsage: { totalTokens: 9 },
      stepUsage: { totalTokens: 9 },
      finishTotalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    {
      name: "finish-step disagrees with a stream alias",
      usage: { totalTokens: 0 },
      totalUsage: { totalTokens: 0 },
      stepUsage: { totalTokens: 15 },
      finishTotalUsage: null,
    },
  ];
  for (const candidate of cases) {
    const payload = await finishedModelUsage({ npm: "@ai-sdk/openai", ...candidate });
    assert.equal(payload?.totalSource, "unavailable", candidate.name);
    assert.equal(payload?.totalTokens, null, candidate.name);
    assert.equal(payload?.inputTokens, null, candidate.name);
    assert.equal(payload?.outputTokens, null, candidate.name);
    assert.equal(payload?.cacheComparable, false, candidate.name);
  }
});

test("only a completed single-step attempt falls back to observed finish.totalUsage", async () => {
  const finishTotalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const single = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: neverSettlingUsage, totalUsage: neverSettlingUsage,
    response: neverSettlingUsage, stepUsage: { inputTokens: 10 }, finishTotalUsage,
  });
  assert.equal(single?.totalSource, "reported");
  assert.equal(single?.totalTokens, 15);
  assert.equal(single?.inputTokens, 10);
  assert.equal(single?.outputTokens, 5);

  const multiple = await finishedModelUsage({
    npm: "@ai-sdk/openai", steps: 2, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    totalUsage: finishTotalUsage, finishTotalUsage,
  });
  assert.equal(multiple?.totalSource, "unavailable", "aggregate usage is not proof every step reported usage");
  assert.equal(multiple?.totalTokens, null);

  const noStep = await finishedModelUsage({
    npm: "@ai-sdk/openai", steps: 0, usage: neverSettlingUsage,
    totalUsage: neverSettlingUsage, response: neverSettlingUsage, finishTotalUsage,
  });
  assert.equal(noStep?.totalTokens, null);

  const invalidFinish = await finishedModelUsage({
    npm: "@ai-sdk/openai", usage: neverSettlingUsage, totalUsage: neverSettlingUsage,
    response: neverSettlingUsage, finishTotalUsage: { inputTokens: 10 },
  });
  assert.equal(invalidFinish?.totalTokens, null);
});

test("OpenAI cached input uses full input only for valid SDK counts", async () => {
  for (const [cached, denominator] of [[900, 1000], [0, 1000], [undefined, null], [null, null], [true, null], ["0", null], [0.5, null], [Number.MAX_SAFE_INTEGER + 1, null]] as const) {
    const payload = await finishedModelUsage({ npm: "@ai-sdk/openai", usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: cached } });
    assert.equal(payload?.cacheReadTokens, denominator === null ? null : cached);
    assert.equal(payload?.cacheInputTokens, denominator);
    assert.equal(payload?.cacheComparable, denominator !== null);
    assert.equal(payload?.totalTokens, 1010);
  }
  for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/deepseek", "@ai-sdk/moonshotai"]) {
    for (const baseURL of [undefined, "https://example.invalid"]) {
      const payload = await finishedModelUsage({ npm, baseURL, usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: 900 } });
      assert.equal(payload?.cacheReadTokens, 900, `${npm} ${baseURL}`);
      assert.equal(payload?.cacheInputTokens, 1000, `${npm} ${baseURL}`);
      assert.equal(payload?.cacheComparable, true, `${npm} ${baseURL}`);
    }
  }
  const zero = await finishedModelUsage({ npm: "@ai-sdk/openai-compatible", usage: { inputTokens: 1000, cachedInputTokens: 0 } });
  assert.equal(zero?.cacheInputTokens, 1000);
  assert.equal(zero?.cacheComparable, true);
  for (const options of [
    { npm: "@ai-sdk/openai", steps: 2 },
    { npm: "@ai-sdk/openai-compatible", steps: 2 },
    { npm: "@ai-sdk/deepseek", steps: 2 },
    { npm: "@ai-sdk/moonshotai", steps: 2 },
  ]) {
    const payload = await finishedModelUsage({ ...options, usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: 900 } });
    assert.equal(payload?.cacheComparable, false);
    assert.equal(payload?.cacheInputTokens, null);
  }
  for (const usage of [
    { inputTokens: 1000, cachedInputTokens: undefined },
    { inputTokens: undefined, cachedInputTokens: 900 },
    { inputTokens: 1000, cachedInputTokens: 1001 },
    { inputTokens: 1000, cachedInputTokens: "900" },
  ]) {
    const payload = await finishedModelUsage({ npm: "@ai-sdk/openai-compatible", usage });
    assert.equal(payload?.cacheComparable, false);
    assert.equal(payload?.cacheInputTokens, null);
  }
});

test("Anthropic counts uncached, read and creation from the same normal step without changing Token metrics", async () => {
  const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 900 };
  const metadata = { anthropic: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } };
  const valid = await finishedModelUsage({ npm: "@ai-sdk/anthropic", usage, metadata });
  assert.equal(valid?.cacheReadTokens, 900);
  assert.equal(valid?.cacheInputTokens, 1050);
  assert.equal(valid?.cacheComparable, true);
  assert.equal(valid?.inputTokens, 100);
  assert.equal(valid?.totalTokens, 110);
  const proxied = await finishedModelUsage({ npm: "@ai-sdk/anthropic", usage, metadata, baseURL: "https://example.invalid" });
  assert.equal(proxied?.cacheInputTokens, 1050);
  assert.equal(proxied?.cacheComparable, true);
  for (const invalid of [
    { metadata: undefined },
    { metadata: { anthropic: { usage: { ...metadata.anthropic.usage, iterations: {} } } } },
    { metadata: { anthropic: { usage: { input_tokens: 100, cache_read_input_tokens: 900 } } } },
    { metadata: { anthropic: { usage: { ...metadata.anthropic.usage, iterations: [{ input_tokens: 100 }] } } } },
    { metadata: { anthropic: { usage: { ...metadata.anthropic.usage, input_tokens: 101 } } } },
    { metadata, steps: 2 },
  ]) {
    const payload = await finishedModelUsage({ npm: "@ai-sdk/anthropic", usage, ...invalid });
    assert.equal(payload?.cacheComparable, false);
    assert.equal(payload?.cacheInputTokens, null);
  }
});
