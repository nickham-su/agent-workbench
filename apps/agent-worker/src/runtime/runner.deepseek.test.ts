import { chatEndpointDigest } from "./providers/conversation-state/endpoint-identity.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { streamText } from "ai";
import type { ExecutionProfile } from "./apiClient.js";
import { AgentRunner } from "./runner.js";
import { DeepSeekConversationStateAdapter } from "./providers/conversation-state/deepseek-adapter.js";

const profile = (baseURL: string, retries = 0) => ({
  model: { id: "local-deepseek", providerModelId: "deepseek-v4-pro", options: {
    providerOptionsByKey: { deepseek: { thinking: { type: "disabled" }, "Reasoning-Effort": "low" } },
  } },
  provider: { id: "deepseek-config", npm: "@ai-sdk/deepseek", options: { baseURL, apiKey: "fixture-only" } },
  agent: { tools: [], pluginTools: [], mcpServers: [] },
  runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: retries,
    modelRequestRetryBackoffMaxMs: 1 },
}) as unknown as ExecutionProfile;
const run = { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(),
  workspaceRepoDirNames: [], inputText: "hello" };
const context = (messages: unknown[] = [], providerReplay: unknown[] = []) => ({
  pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "", messages,
  providerReplay, lastResponseTotalTokens: null, uiLocale: null, externalSkills: [],
});
const invoke = (runner: AgentRunner, activeProfile: ExecutionProfile, messages: unknown[] = [], replay: unknown[] = []) =>
  (runner as any).runModelStep({ profile: activeProfile, run, context: context(messages, replay), step: 1,
    signal: new AbortController().signal, recoveryContinuation: { messageId: null }, repeatedToolCallCounter: new Map() });
type SavedPart = { type: "text" | "reasoning" | "tool_call"; text?: string;
  providerReplay?: { provider: { npm: string; providerId: string; model: string }; item: { type: string } };
  id: string; position: number };
function backend() {
  const parts = new Map<string, SavedPart[]>();
  const completed: string[] = [];
  let executions = 0;
  return { parts, completed, get executions() { return executions; },
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts(request: { messageId: string; parts: SavedPart[] }) {
      parts.set(request.messageId, request.parts); return { result: "updated" };
    },
    async completeTerminalAssistant(request: { messageId: string }) {
      completed.push(request.messageId); return { result: "updated" };
    },
    async completeAssistant(request: { messageId: string; executions: unknown[] }) {
      completed.push(request.messageId); executions += request.executions.length;
      return { result: "updated" };
    },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async updateRunNotice() { return { result: "updated" }; },
    async getPluginRuntimeSnapshots() { return { plugins: [] }; },
  };
}
const logger = { info() {}, warn() {}, error() {} };
function fixtureRunner(api: ReturnType<typeof backend>, baseURL: string, extras: Record<string, unknown> = {}) {
  const runner = new AgentRunner(api as any, { async listTools() { return []; } } as any,
    logger, 1, { ...extras });
  return { runner, profile: profile(baseURL) };
}
function chunk(delta: Record<string, unknown>, reason: string | null = null) {
  return { id: "fixture", object: "chat.completion.chunk", model: "deepseek-v4-pro", created: 1,
    choices: [{ index: 0, delta, finish_reason: reason }] };
}
function sse(text: string) {
  return [chunk({ reasoning_content: `${text} thinking` }), chunk({ content: text }), chunk({}, "stop"),
    { id: "fixture", object: "chat.completion.chunk", model: "deepseek-v4-pro", created: 1,
      choices: [], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("DeepSeek custom Provider model ID reaches SDK and emits paired Analytics signals", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse("custom"));
  });
  await new Promise<void>((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.once("error", reject); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const signals: Array<{ type: string; attemptNo: number }> = [];
    const api = backend();
    const { runner, profile: selected } = fixtureRunner(api, `http://127.0.0.1:${address.port}/v1`, {
      streamText: (request: any) => streamText(request),
      analyticsSignals: { emitModel(payload: { attemptNo: number }, type: string) {
        signals.push({ type, attemptNo: payload.attemptNo });
      } },
    });
    const custom = { ...selected, model: { ...selected.model, providerModelId: "  my-deepseek-alias  " } };
    await invoke(runner, custom, [{ role: "user", content: "hello" }]);
    assert.equal(bodies[0]?.model, "my-deepseek-alias");
    assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
    const fallback = { ...selected, model: { ...selected.model, providerModelId: "   " } };
    await invoke(runner, fallback, [{ role: "user", content: "hello" }]);
    assert.equal(bodies[1]?.model, "local-deepseek");
    assert.deepEqual(bodies[1]?.thinking, { type: "enabled" });
    assert.deepEqual(signals, [{ type: "model_invoked", attemptNo: 1 }, { type: "model_finished", attemptNo: 1 },
      { type: "model_invoked", attemptNo: 1 }, { type: "model_finished", attemptNo: 1 }]);
    assert.equal(api.completed.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("DeepSeek Runner + actual SDK mock: flushed provenance feeds next request; analytics counts each Attempt", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const entry of req) body.push(Buffer.isBuffer(entry) ? entry : Buffer.from(entry));
    requests.push(JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(requests.length === 1 ? "first" : "second"));
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve); server.once("error", reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const api = backend();
    const modelSignals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const { runner, profile: activeProfile } = fixtureRunner(api, `http://127.0.0.1:${address.port}/v1`, {
      streamText: (request: any) => streamText(request),
      analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) {
        modelSignals.push({ eventType, payload });
      } },
    });
    const first = await invoke(runner, activeProfile, [{ role: "user", content: "hello" }]);
    const saved = api.parts.get(first.assistantMessageId) ?? [];
    assert.ok(api.completed.includes(first.assistantMessageId));
    assert.deepEqual(saved.map((part) => part.type), ["reasoning", "text"]);
    for (const part of saved) {
      assert.deepEqual(part.providerReplay?.provider, { npm: "@ai-sdk/deepseek", api: "chat-completions",
        protocolVersion: 1, providerId: "deepseek-config", model: "deepseek-v4-pro", endpointDigest: chatEndpointDigest(activeProfile) });
      assert.equal(part.providerReplay?.item.type, part.type);
    }
    const reasoning = saved.find((part) => part.type === "reasoning")!;
    const second = await invoke(runner, activeProfile,
      [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "user", content: "continue" }],
      [{ assistantOrdinal: 1, assistantProvenance: {
        providerNpm: "@ai-sdk/deepseek", providerId: "deepseek-config", model: "deepseek-v4-pro",
        protocol: "deepseek-chat", protocolVersion: 1, endpointDigest: chatEndpointDigest(activeProfile) }, parts: [{ type: "reasoning", visibleIndex: 0,
        text: reasoning.text, providerReplay: reasoning.providerReplay }] }]);
    assert.ok(api.completed.includes(second.assistantMessageId));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((body) => body.thinking), [
      { type: "enabled" }, { type: "enabled" },
    ]);
    assert.equal((requests[1]?.messages as Array<{ reasoning_content?: string }>)[1]?.reasoning_content,
      "first thinking");
    assert.equal(modelSignals.length, 4);
    assert.deepEqual(modelSignals.map(({ eventType, payload }) => [eventType, payload.attemptNo, payload.status]), [
      ["model_invoked", 1, "running"], ["model_finished", 1, "completed"],
      ["model_invoked", 1, "running"], ["model_finished", 1, "completed"],
    ]);
    assert.equal(modelSignals[0]?.payload.modelCallId, modelSignals[1]?.payload.modelCallId);
    assert.equal(modelSignals[2]?.payload.modelCallId, modelSignals[3]?.payload.modelCallId);
    assert.notEqual(modelSignals[0]?.payload.modelCallId, modelSignals[2]?.payload.modelCallId);
    assert.equal(modelSignals[1]?.payload.totalTokens, 10);
    assert.equal(modelSignals[1]?.payload.inputTokens, 6);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("DeepSeek Runner retry replaces failed Parts and pairs analytics per network Attempt", async () => {
  const api = backend();
  const signals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const retryDelays: number[] = [];
  let calls = 0;
  const { runner, profile: activeProfile } = fixtureRunner(api, "https://fixture.invalid/v1", {
    modelRetrySleep: async (ms: number, signal: AbortSignal) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      retryDelays.push(ms);
      return !signal.aborted;
    },
    streamText: () => {
      calls++;
      if (calls === 1) return {
        fullStream: (async function* () {
          yield { type: "reasoning-start", id: "failed" };
          yield { type: "reasoning-delta", id: "failed", text: "discarded reasoning" };
          throw new Error("retryable transport failure");
        })(), usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null),
      };
      return { fullStream: (async function* () {
        yield { type: "reasoning-start", id: "final" };
        yield { type: "reasoning-delta", id: "final", text: "retained reasoning" };
        yield { type: "reasoning-end", id: "final" };
        yield { type: "text-delta", id: "answer", text: "answer" };
        yield { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      })(), reasoningText: Promise.resolve("retained reasoning"),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 2, totalTokens: 7 }), response: Promise.resolve(null) };
    },
    analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) {
      signals.push({ eventType, payload });
    } },
  });
  activeProfile.runtime.modelRequestMaxRetries = 1;
  const output = await invoke(runner, activeProfile, [{ role: "user", content: "hello" }]);
  const saved = api.parts.get(output.assistantMessageId) ?? [];
  assert.deepEqual(retryDelays, [2_000]);
  assert.equal(calls, 2);
  assert.equal(api.completed.length, 1);
  assert.deepEqual(saved.map((part) => part.text), ["retained reasoning", "answer"]);
  assert.ok(saved.every((part) => part.providerReplay?.provider.npm === "@ai-sdk/deepseek"));
  assert.deepEqual(signals.map(({ eventType, payload }) => [eventType, payload.attemptNo, payload.status]), [
    ["model_invoked", 1, "running"], ["model_finished", 1, "failed"],
    ["model_invoked", 2, "running"], ["model_finished", 2, "completed"],
  ]);
  assert.equal(signals[0]?.payload.modelCallId, signals[1]?.payload.modelCallId);
  assert.equal(signals[2]?.payload.modelCallId, signals[3]?.payload.modelCallId);
  assert.notEqual(signals[0]?.payload.modelCallId, signals[2]?.payload.modelCallId);
  assert.equal(signals[1]?.payload.totalTokens, null);
  assert.equal(signals[3]?.payload.inputTokens, 5);
  assert.equal(signals[3]?.payload.totalTokens, 7);
});

test("DeepSeek Runner accepts nonempty reasoning-only but rejects text-only-free empty reasoning", async () => {
  const api = backend();
  const { runner, profile: activeProfile } = fixtureRunner(api, "https://fixture.invalid/v1", {
    streamText: () => ({
      fullStream: (async function* () {
        yield { type: "reasoning-start", id: "r" };
        yield { type: "reasoning-delta", id: "r", text: "nonempty" };
        yield { type: "reasoning-end", id: "r" };
      })(), reasoningText: Promise.resolve("nonempty"),
      usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null),
    }),
  });
  const result = await invoke(runner, activeProfile, [{ role: "user", content: "hello" }]);
  assert.equal(api.completed.length, 1);
  assert.deepEqual(api.parts.get(result.assistantMessageId)?.map((part) => [part.type, part.text]),
    [["reasoning", "nonempty"]]);

  const failedApi = backend();
  const { runner: failed } = fixtureRunner(failedApi, "https://fixture.invalid/v1", {
    streamText: () => ({ fullStream: (async function* () {
      yield { type: "reasoning-start", id: "empty" }; yield { type: "reasoning-end", id: "empty" };
    })(), reasoningText: Promise.resolve(""),
      usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null) }),
  });
  await assert.rejects(invoke(failed, activeProfile, [{ role: "user", content: "hello" }]),
    /model stream completed without visible text or tool calls/);
  assert.deepEqual(failedApi.completed, []);
});

test("DeepSeek text-only and tool-only Assistants retain provenance without inventing reasoning", async () => {
  const textApi = backend();
  const { runner: textRunner, profile: activeProfile } = fixtureRunner(textApi, "https://fixture.invalid/v1", {
    streamText: () => ({ fullStream: (async function* () {
      yield { type: "text-start", id: "text" };
      yield { type: "text-delta", id: "text", text: "visible" };
      yield { type: "text-end", id: "text" };
    })(), reasoningText: Promise.resolve(""), usage: Promise.resolve(null), totalUsage: Promise.resolve(null),
      response: Promise.resolve(null) }),
  });
  const text = await invoke(textRunner, activeProfile);
  assert.deepEqual(textApi.parts.get(text.assistantMessageId)?.map((part) => part.type), ["text"]);
  assert.equal(textApi.parts.get(text.assistantMessageId)?.[0]?.providerReplay?.item.type, "text");
  assert.equal(textApi.completed.length, 1);

  const toolApi = backend();
  const { runner: toolRunner } = fixtureRunner(toolApi, "https://fixture.invalid/v1", {
    streamText: () => ({ fullStream: (async function* () {
      yield { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: { value: "hello" } };
    })(), reasoningText: Promise.resolve(""), usage: Promise.resolve(null), totalUsage: Promise.resolve(null),
      response: Promise.resolve(null) }),
  });
  (toolRunner as any).toolRegistry = { async listTools() {
    return [{ name: "echo", description: "fixture tool", inputSchema: {
      type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
  } };
  const tool = await invoke(toolRunner, activeProfile);
  assert.deepEqual(toolApi.parts.get(tool.assistantMessageId)?.map((part) => part.type), ["tool_call"]);
  assert.equal(toolApi.parts.get(tool.assistantMessageId)?.[0]?.providerReplay?.item.type, "tool_call");
  assert.equal(toolApi.executions, 1);
  assert.equal(toolApi.completed.length, 1);
});

test("DeepSeek Runner tool continuation restores reasoning and original tool-call/result ID", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const entry of req) buffers.push(Buffer.isBuffer(entry) ? entry : Buffer.from(entry));
    requests.push(JSON.parse(Buffer.concat(buffers).toString("utf8")) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      const parts = [chunk({ reasoning_content: "tool reasoning" }), chunk({ content: "working" }),
        chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function",
          function: { name: "echo", arguments: '{"value":"hello"}' } }] }), chunk({}, "tool_calls")];
      res.end(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n");
    } else {
      res.end(sse("tool answer"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve); server.once("error", reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const api = backend();
    const { runner, profile: activeProfile } = fixtureRunner(api, `http://127.0.0.1:${address.port}/v1`, {
      streamText: (request: any) => streamText(request),
    });
    (runner as any).toolRegistry = { async listTools() {
      return [{ name: "echo", description: "fixture tool", inputSchema: {
        type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
    } };
    const first = await invoke(runner, activeProfile, [{ role: "user", content: "use tool" }]);
    const stored = api.parts.get(first.assistantMessageId) ?? [];
    assert.deepEqual(stored.map((part) => part.type), ["reasoning", "text", "tool_call"]);
    assert.equal(api.executions, 1);
    assert.ok(stored.every((part) => part.providerReplay?.provider.npm === "@ai-sdk/deepseek"));
    const thought = stored[0]!;
    const second = await invoke(runner, activeProfile, [
      { role: "user", content: "use tool" },
      { role: "assistant", content: [{ type: "text", text: "working" },
        { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: { value: "hello" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "echo",
        output: { type: "text", value: "hello" } }] },
    ], [{ assistantOrdinal: 1, assistantProvenance: {
      providerNpm: "@ai-sdk/deepseek", providerId: "deepseek-config", model: "deepseek-v4-pro",
      protocol: "deepseek-chat", protocolVersion: 1, endpointDigest: chatEndpointDigest(activeProfile) }, parts: [{ type: "reasoning", visibleIndex: 0,
        text: thought.text, providerReplay: thought.providerReplay }] }]);
    assert.ok(api.completed.includes(second.assistantMessageId));
    assert.equal(requests.length, 2);
    const wire = requests[1]?.messages as Array<Record<string, unknown>>;
    assert.deepEqual(wire.map((item) => item.role), ["user", "assistant", "tool"]);
    assert.equal(wire[1]?.reasoning_content, "tool reasoning");
    assert.equal((wire[1]?.tool_calls as Array<{ id: string }>)[0]?.id, "call-1");
    assert.equal(wire[2]?.tool_call_id, "call-1");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
