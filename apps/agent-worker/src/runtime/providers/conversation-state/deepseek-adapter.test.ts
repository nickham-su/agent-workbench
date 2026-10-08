import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText, type ModelMessage } from "ai";
import type { ExecutionProfile } from "../../apiClient.js";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import { chatEndpointDigest } from "./endpoint-identity.js";
import { DefaultProviderConversationStateAdapterRegistry } from "./registry.js";
import { DeepSeekConversationStateAdapter } from "./deepseek-adapter.js";

const profile = {
  provider: { npm: "@ai-sdk/deepseek", id: "config-a", options: { baseURL: "https://fixture.invalid", apiKey: "fixture" } },
  model: { id: "local", providerModelId: "deepseek-v4-pro" },
} as ExecutionProfile;
const identity = { providerNpm: "@ai-sdk/deepseek" as const, protocol: "deepseek-chat" as const,
  protocolVersion: 1 as const, providerId: "config-a", model: "deepseek-v4-pro", endpointDigest: chatEndpointDigest(profile) };
const replay = (type: "text" | "reasoning" | "tool_call", overrides: Record<string, string> = {}) => ({
  version: 1 as const,
  provider: { npm: "@ai-sdk/deepseek" as const, api: "chat-completions" as const,
    protocolVersion: 1 as const, providerId: "config-a", model: "deepseek-v4-pro", endpointDigest: chatEndpointDigest(profile), ...overrides },
  item: { type },
});
type History = NonNullable<AgentApiPromptContextResponse["providerReplay"]>;
const source = (index: number, reasoning: string): History[number] => ({
  assistantOrdinal: index, assistantProvenance: identity,
  parts: [{ type: "reasoning", visibleIndex: 0, text: reasoning, providerReplay: replay("reasoning") }],
});
function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "fixture", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-pro",
    choices: [{ index: 0, delta, finish_reason: finish }] };
}
function sse(chunks: unknown[]) {
  return chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("deepseek registry accepts a user-supplied model ID without local admission", () => {
  assert.ok(new DefaultProviderConversationStateAdapterRegistry().resolve(profile) instanceof DeepSeekConversationStateAdapter);
  const custom = { ...profile, model: { ...profile.model, providerModelId: "custom-user-model" } };
  const adapter = new DefaultProviderConversationStateAdapterRegistry().resolve(custom);
  assert.ok(adapter instanceof DeepSeekConversationStateAdapter);
  const prepared = adapter.prepareInvocation({ profile: custom, messages: [{ role: "user", content: "hi" }],
    history: [], providerOptions: {} });
  assert.equal(prepared.attemptContext.model, "custom-user-model");
});

test("DeepSeek Adapter uses fixed thinking and stamps each Part with exact invocation provenance", () => {
  const adapter = new DeepSeekConversationStateAdapter(profile);
  const prepared = adapter.prepareInvocation({ profile, messages: [{ role: "user", content: "hello" }], history: [],
    providerOptions: { parallelToolCalls: true, thinking: { type: "disabled" }, "Reasoning-Effort": "low",
      reasoningHistory: "preserved" } });
  assert.deepEqual(prepared.providerOptions, { parallelToolCalls: true, thinking: { type: "enabled" } });
  assert.equal(Object.hasOwn(prepared.providerOptions, "deepseek"), false);
  assert.deepEqual(prepared.attemptContext, identity);
  const attempt = adapter.createAttempt(prepared.attemptContext);
  for (const type of ["text", "reasoning", "tool_call"] as const) {
    assert.deepEqual(attempt.createPartReplay?.({ id: `part-${type}`, type }), replay(type));
  }
  assert.deepEqual(attempt.finalizeAttempt(), { ok: true, allowsReplayOnlyAssistant: true });
  assert.throws(() => adapter.createAttempt({ ...identity, providerId: "config-b" }), /identity mismatch/);
  for (const unexpected of [
    [{ type: "reasoning-start", id: "r1" }],
    [{ type: "reasoning-delta", id: "r1", text: "orphan" }],
    [{ type: "reasoning-end", id: "r1" }],
  ]) {
    const broken = adapter.createAttempt(prepared.attemptContext);
    for (const entry of unexpected) broken.observeChunk(entry);
    assert.equal(broken.finalizeAttempt().ok, false);
  }
  const multiple = adapter.createAttempt(prepared.attemptContext);
  for (const entry of ["reasoning-start", "reasoning-end", "reasoning-start", "reasoning-end"]) {
    multiple.observeChunk({ type: entry, id: "reasoning-0" });
  }
  assert.equal(multiple.finalizeAttempt().ok, true, "locked SDK may reuse the reasoning-0 ID across blocks");
});

test("DeepSeek V4 Adapter → locked SDK retains every tool-step reasoning and next-turn reasoning", async () => {
  const adapter = new DeepSeekConversationStateAdapter(profile);
  const messages: ModelMessage[] = [
    { role: "user", content: "use tool" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "echo", input: { value: "one" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "echo",
      output: { type: "text", value: "one" } }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-2", toolName: "echo", input: { value: "two" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call-2", toolName: "echo",
      output: { type: "text", value: "two" } }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "next user turn" },
  ];
  const history: History = [source(1, "first thought"), source(3, "second thought"), source(5, "final thought")];
  let body: Record<string, unknown> = {};
  const fetch: typeof globalThis.fetch = async (_, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(sse([chunk({ reasoning_content: "next thought" }), chunk({ content: "reply" }), chunk({}, "stop"),
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-pro", choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, prompt_cache_hit_tokens: 2 } }]),
    { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const prepared = adapter.prepareInvocation({ profile, messages, history, providerOptions: {} });
  const attempt = adapter.createAttempt(prepared.attemptContext);
  const model = createDeepSeek({ apiKey: "fixture", fetch }).chat("deepseek-v4-pro");
  const result = streamText({ model, messages: prepared.messages, providerOptions: { deepseek: prepared.providerOptions } });
  const chunks: string[] = [];
  for await (const entry of result.fullStream) { chunks.push(entry.type); attempt.observeChunk(entry); }
  assert.ok(chunks.includes("reasoning-delta"));
  assert.deepEqual(attempt.finalizeAttempt(), { ok: true, allowsReplayOnlyAssistant: true });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(Object.hasOwn(body, "reasoningHistory"), false);
  assert.equal(Object.hasOwn(body, "reasoningEffort"), false);
  const wire = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(wire.map((item) => item.role), ["user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
  assert.deepEqual([wire[1]?.reasoning_content, wire[3]?.reasoning_content, wire[5]?.reasoning_content],
    ["first thought", "second thought", "final thought"]);
  assert.deepEqual([(wire[1]?.tool_calls as Array<{id: string}>)[0]?.id,
    (wire[3]?.tool_calls as Array<{id: string}>)[0]?.id], ["call-1", "call-2"]);
  assert.deepEqual([wire[2]?.tool_call_id, wire[4]?.tool_call_id], ["call-1", "call-2"]);
  const usage = await result.totalUsage;
  assert.equal(usage.totalTokens, 12);
  assert.equal(usage.cachedInputTokens, 2);
});

test("DeepSeek V4 keeps next-turn history while older model serializer drops it", async () => {
  for (const modelId of ["deepseek-v4-pro", "deepseek-chat"]) {
    const activeProfile = { ...profile, model: { ...profile.model, providerModelId: modelId } };
    const activeIdentity = { ...identity, model: modelId };
    const activeReplay = { ...replay("reasoning"), provider: { ...replay("reasoning").provider, model: modelId } };
    const adapter = new DeepSeekConversationStateAdapter(activeProfile);
    const prepared = adapter.prepareInvocation({ profile: activeProfile,
      messages: [{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
        { role: "user", content: "next" }],
      history: [{ assistantOrdinal: 0, assistantProvenance: activeIdentity,
        parts: [{ type: "reasoning", visibleIndex: 0, text: "old thought", providerReplay: activeReplay }] }],
      providerOptions: {} });
    let body: Record<string, unknown> = {};
    const fetch: typeof globalThis.fetch = async (_, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sse([chunk({ content: "reply" }), chunk({}, "stop")]),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const response = streamText({ model: createDeepSeek({ apiKey: "fixture", fetch }).chat(modelId),
      messages: prepared.messages, providerOptions: { deepseek: prepared.providerOptions } });
    for await (const _entry of response.fullStream) { /* consume SDK response */ }
    assert.equal((body.messages as Array<{reasoning_content?: string}>)[0]?.reasoning_content,
      modelId === "deepseek-v4-pro" ? "old thought" : undefined);
  }
});

test("DeepSeek replay stops at provider/config/model or legacy boundary, including empty Assistant", () => {
  const adapter = new DeepSeekConversationStateAdapter(profile);
  const messages: ModelMessage[] = [
    { role: "assistant", content: [{ type: "text", text: "older" }] },
    { role: "assistant", content: [] },
    { role: "assistant", content: [{ type: "text", text: "recent" }] },
  ];
  const changes = [
    { assistantProvenance: null },
    { assistantProvenance: { ...identity, providerNpm: "@ai-sdk/moonshotai" } },
    { assistantProvenance: { ...identity, providerId: "other-config" } },
    { assistantProvenance: { ...identity, model: "other-model" } },
    { assistantProvenance: { ...identity, protocol: "moonshot-chat" } },
  ] as const;
  for (const changed of changes) {
    const restored = adapter.prepareInvocation({ profile, messages,
    // Deliberately malformed provenance to exercise a hard replay boundary.
    history: [source(0, "must not return"), { assistantOrdinal: 1, parts: [], ...changed }, source(2, "fresh")] as History,
      providerOptions: {} });
    assert.equal(restored.messages.length, 2);
    assert.deepEqual((restored.messages[0] as {content: Array<{text: string}>}).content,
      [{ type: "text", text: "older" }]);
    assert.deepEqual((restored.messages[1] as {content: Array<{text: string}>}).content[0],
      { type: "reasoning", text: "fresh" });
  }
});

test("text-only/tool-only Assistant receives provenance; absent/empty reasoning is never fabricated", () => {
  const adapter = new DeepSeekConversationStateAdapter(profile);
  const prepared = adapter.prepareInvocation({ profile,
    messages: [{ role: "assistant", content: [{ type: "text", text: "plain" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "echo", input: {} }] }],
    history: [{ assistantOrdinal: 0, assistantProvenance: identity, parts: [] },
      { assistantOrdinal: 1, assistantProvenance: identity, parts: [] }], providerOptions: {} });
  assert.deepEqual(prepared.messages, [
    { role: "assistant", content: [{ type: "text", text: "plain" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "echo", input: {} }] },
  ]);
  const attempt = adapter.createAttempt(prepared.attemptContext);
  assert.equal(attempt.createPartReplay?.({ id: "plain", type: "text" })?.item.type, "text");
  assert.equal(attempt.createPartReplay?.({ id: "call", type: "tool_call" })?.item.type, "tool_call");
  assert.equal(attempt.finalizeAttempt().ok, true);
});
