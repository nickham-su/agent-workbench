import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "./runner.js";

const neverSettlingUsage = new Promise<never>(() => undefined);

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

test("OpenAI cached input uses full input only for valid SDK counts and official endpoint", async () => {
  for (const [cached, denominator] of [[900, 1000], [0, 1000], [undefined, null], [null, null], [true, null], ["0", null], [0.5, null], [Number.MAX_SAFE_INTEGER + 1, null]] as const) {
    const payload = await finishedModelUsage({ npm: "@ai-sdk/openai", usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: cached } });
    assert.equal(payload?.cacheReadTokens, denominator === null ? null : cached);
    assert.equal(payload?.cacheInputTokens, denominator);
    assert.equal(payload?.cacheComparable, denominator !== null);
    assert.equal(payload?.totalTokens, 1010);
  }
  for (const options of [
    { npm: "@ai-sdk/openai-compatible" },
    { npm: "@ai-sdk/openai", baseURL: "https://example.invalid" },
    { npm: "@ai-sdk/openai", steps: 2 },
  ]) {
    const payload = await finishedModelUsage({ ...options, usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: 900 } });
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
  for (const invalid of [
    { metadata: undefined },
    { metadata: { anthropic: { usage: { ...metadata.anthropic.usage, iterations: {} } } } },
    { metadata: { anthropic: { usage: { input_tokens: 100, cache_read_input_tokens: 900 } } } },
    { metadata: { anthropic: { usage: { ...metadata.anthropic.usage, iterations: [{ input_tokens: 100 }] } } } },
    { metadata: { anthropic: { usage: { ...metadata.anthropic.usage, input_tokens: 101 } } } },
    { metadata, steps: 2 },
    { metadata, baseURL: "https://example.invalid" },
  ]) {
    const payload = await finishedModelUsage({ npm: "@ai-sdk/anthropic", usage, ...invalid });
    assert.equal(payload?.cacheComparable, false);
    assert.equal(payload?.cacheInputTokens, null);
  }
});
