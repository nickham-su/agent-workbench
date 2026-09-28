import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { streamText } from "ai";
import { AgentRunner } from "./runner.js";

const neverSettlingUsage = new Promise<never>(() => undefined);

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

  const result = await Promise.race([
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
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runModelStep was blocked by optional usage")), 750)),
  ]);

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
  usage: Record<string, unknown>;
  metadata?: unknown;
  steps?: number;
  baseURL?: string;
}) {
  const signals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const apiClient = {
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
    async updateRunNotice() { return { result: "updated" }; },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async getPluginRuntimeSnapshots() { return { plugins: [] }; },
  };
  const runner = new AgentRunner(apiClient as any, { async listTools() { return []; } } as any, { info() {}, warn() {}, error() {} }, 1, {
    analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) { signals.push({ eventType, payload }); } } as any,
    streamText: (() => ({
      usage: Promise.resolve(options.usage),
      totalUsage: Promise.resolve(options.usage),
      response: Promise.resolve(null),
      fullStream: (async function* () {
        yield { type: "text-delta", id: "part-1", text: "completed" };
        for (let index = 0; index < (options.steps ?? 1); index++)
          yield { type: "finish-step", usage: options.usage, providerMetadata: options.metadata };
        yield { type: "finish", totalUsage: options.usage };
        yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
      })(),
    })) as any,
  });
  const result = await (runner as any).runModelStep({
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
  });
  assert.equal(result.aborted, false);
  return signals.find((signal) => signal.eventType === "model_finished")?.payload;
}

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
