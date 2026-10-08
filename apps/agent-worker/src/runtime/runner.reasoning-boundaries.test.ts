import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "./runner.js";

const profile = (npm = "@ai-sdk/anthropic", retries = 0) => ({
  model: { id: "model", options: undefined },
  provider: { id: "provider", npm, options: {} },
  agent: { tools: [], pluginTools: [], mcpServers: [] },
  runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: retries, modelRequestRetryBackoffMaxMs: 1 },
});
const run = { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "hello" };
const context = (messages: unknown[] = []) => ({ pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0,
  system: "", messages, providerReplay: [{ assistantOrdinal: 1, assistantProvenance: null, parts: [] }],
  lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] });
const step = (runner: AgentRunner, npm: string, retries = 0, messages: unknown[] = []) => (runner as any).runModelStep({
  profile: profile(npm, retries), run, context: context(messages), step: 1, signal: new AbortController().signal,
  recoveryContinuation: { messageId: null }, repeatedToolCallCounter: new Map(),
});
function api() {
  let completed = 0;
  let executions = 0;
  return {
    get completed() { return completed; }, get executions() { return executions; },
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { completed++; return { result: "updated" }; },
    async completeAssistant(request: { executions: unknown[] }) { completed++; executions += request.executions.length; return { result: "updated" }; },
    async updateRunNotice() { return { result: "updated" }; },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async getPluginRuntimeSnapshots() { return { plugins: [] }; },
  };
}
const successStream = () => ({
  fullStream: (async function* () { yield { type: "text-delta", id: "part", text: "done" }; })(),
  reasoningText: Promise.resolve(""),
  usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null),
});

test("switching Providers never sends an unrecoverable legacy placeholder, with or without an Adapter", async () => {
  for (const withAdapter of [false, true]) {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const registry = { resolve() { return {
      protocol: "openai-responses",
      prepareInvocation(input: { messages: unknown[]; providerOptions: unknown }) { return {
        messages: input.messages, providerOptions: input.providerOptions,
        attemptContext: { providerNpm: "@ai-sdk/openai", protocol: "openai-responses", protocolVersion: 1,
          providerId: "provider", model: "model" },
      }; },
      createAttempt() { return { observeChunk() { return {}; }, finalizeAttempt() { return { ok: true }; } }; },
    }; } };
    const runner = new AgentRunner(api() as any, { async listTools() { return []; } } as any,
      { info() {}, warn() {}, error() {} }, 1, {
        streamText: ((request: typeof requests[number]) => { requests.push(request); return successStream(); }) as any,
        ...(withAdapter ? { providerConversationStateAdapterRegistry: registry as any } : {}),
      });
    await step(runner, "@ai-sdk/anthropic", 0, [
      { role: "user", content: "first" }, { role: "assistant", content: [] }, { role: "user", content: "next" },
    ]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.messages.map((message) => message.role), ["user", "user"]);
    assert.equal(requests[0]?.messages.some((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.length === 0), false);
  }
});

test("retry records each network Attempt using its immutable attempt number", async () => {
  const events: Array<{ type: string; modelCallId: string; attemptNo: number; status: string }> = [];
  const retryDelays: number[] = [];
  let calls = 0;
  const runner = new AgentRunner(api() as any, { async listTools() { return []; } } as any,
    { info() {}, warn() {}, error() {} }, 1, {
      modelRetrySleep: async (ms, signal) => {
        assert.ok(signal instanceof AbortSignal);
        assert.equal(signal.aborted, false);
        retryDelays.push(ms);
        return !signal.aborted;
      },
      streamText: (() => {
        calls++;
        if (calls === 1) return { fullStream: (async function* () { throw new Error("temporary failure"); })(),
          usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null) };
        return successStream();
      }) as any,
      analyticsSignals: { emitModel(payload: { modelCallId: string; attemptNo: number; status: string }, type: string) {
        events.push({ type, ...payload });
      } } as any,
    });
  const result = await step(runner, "@ai-sdk/anthropic", 1);
  assert.deepEqual(retryDelays, [2_000]);
  assert.equal(result.hasVisibleText, true);
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => [event.type, event.attemptNo, event.status]), [
    ["model_invoked", 1, "running"], ["model_finished", 1, "failed"],
    ["model_invoked", 2, "running"], ["model_finished", 2, "completed"],
  ]);
  assert.equal(events[0]?.modelCallId, events[1]?.modelCallId);
  assert.equal(events[2]?.modelCallId, events[3]?.modelCallId);
  assert.notEqual(events[0]?.modelCallId, events[2]?.modelCallId);
});

test("part replay hook errors fail locally, without retry, completion, tool creation or private details", async () => {
  const backend = api();
  let calls = 0;
  const events: string[] = [];
  const runner = new AgentRunner(backend as any, { async listTools() { return []; } } as any,
    { info() {}, warn() {}, error() {} }, 1, {
      streamText: (() => { calls++; return { ...successStream(), fullStream: (async function* () {
        yield { type: "text-start", id: "part" };
      })() }; }) as any,
      analyticsSignals: { emitModel(_payload: unknown, type: string) { events.push(type); } } as any,
      providerConversationStateAdapterRegistry: { resolve() { return {
        protocol: "openai-responses",
        prepareInvocation(input: { messages: unknown[]; providerOptions: unknown }) { return {
          messages: input.messages, providerOptions: input.providerOptions,
          attemptContext: { providerNpm: "@ai-sdk/openai", protocol: "openai-responses", protocolVersion: 1,
            providerId: "provider", model: "model" },
        }; },
        createAttempt() { return {
          observeChunk() { return {}; },
          createPartReplay() { throw new Error("private-reasoning-and-token-must-not-leak"); },
          finalizeAttempt() { return { ok: true }; },
        }; },
      }; } } as any,
    });
  await assert.rejects(step(runner, "@ai-sdk/openai", 2), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AgentProviderReplayUpdateError");
    assert.equal(err.message, "provider replay part materialization failed");
    assert.doesNotMatch(String(err), /private-reasoning|token-must-not-leak/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(backend.completed, 0);
  assert.equal(backend.executions, 0);
  assert.deepEqual(events, ["model_invoked", "model_finished"]);
});
