import assert from "node:assert/strict";
import test from "node:test";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { streamText, type ModelMessage } from "ai";
import type { ExecutionProfile } from "../../apiClient.js";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import { chatEndpointDigest } from "./endpoint-identity.js";
import { DefaultProviderConversationStateAdapterRegistry } from "./registry.js";
import { MoonshotConversationStateAdapter } from "./moonshot-adapter.js";

const profile = {
  provider: { npm: "@ai-sdk/moonshotai", id: "config-a", options: { baseURL: "https://fixture.invalid/v1", apiKey: "fixture" } },
  model: { id: "local", providerModelId: "kimi-k2.6" },
} as ExecutionProfile;
const identity = { providerNpm: "@ai-sdk/moonshotai" as const, protocol: "moonshot-chat" as const,
  protocolVersion: 1 as const, providerId: "config-a", model: "kimi-k2.6", endpointDigest: chatEndpointDigest(profile) };
const replay = (type: "text" | "reasoning" | "tool_call") => ({ version: 1 as const,
  provider: { npm: "@ai-sdk/moonshotai" as const, api: "chat-completions" as const,
    protocolVersion: 1 as const, providerId: "config-a", model: "kimi-k2.6", endpointDigest: chatEndpointDigest(profile) }, item: { type } });
type History = NonNullable<AgentApiPromptContextResponse["providerReplay"]>;

function source(index: number, reasoning: string): History[number] {
  return { assistantOrdinal: index, assistantProvenance: identity,
    parts: [{ type: "reasoning", visibleIndex: 0, text: reasoning, providerReplay: replay("reasoning") }] };
}
function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "fixture", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish }] };
}
function sse(chunks: unknown[]) {
  return chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("moonshot registry accepts a user-supplied model ID without local admission", () => {
  assert.ok(new DefaultProviderConversationStateAdapterRegistry().resolve(profile) instanceof MoonshotConversationStateAdapter);
  const custom = { ...profile, model: { ...profile.model, providerModelId: "custom-user-model" } };
  const adapter = new DefaultProviderConversationStateAdapterRegistry().resolve(custom);
  assert.ok(adapter instanceof MoonshotConversationStateAdapter);
  const prepared = adapter.prepareInvocation({ profile: custom, messages: [{ role: "user", content: "hi" }],
    history: [], providerOptions: {} });
  assert.equal(prepared.attemptContext.model, "custom-user-model");
});

test("Moonshot Adapter preserves all Part provenance and fixed-last options without double namespace", () => {
  const adapter = new MoonshotConversationStateAdapter(profile);
  const prepared = adapter.prepareInvocation({ profile, messages: [{ role: "user", content: "hi" }], history: [],
    providerOptions: { parallelToolCalls: true, thinking: { type: "disabled" }, "Reasoning-History": "ignored" } });
  assert.deepEqual(prepared.providerOptions, { parallelToolCalls: true,
    thinking: { type: "enabled" }, reasoningHistory: "preserved" });
  assert.equal(Object.hasOwn(prepared.providerOptions, "moonshotai"), false);
  assert.deepEqual(prepared.attemptContext, identity);
  const attempt = adapter.createAttempt(prepared.attemptContext);
  for (const type of ["text", "reasoning", "tool_call"] as const) {
    assert.deepEqual(attempt.createPartReplay?.({ id: `part-${type}`, type }), replay(type));
  }
  assert.deepEqual(attempt.finalizeAttempt(), { ok: true, allowsReplayOnlyAssistant: true });
  assert.throws(() => adapter.createAttempt({ ...identity, model: "kimi-other" }), /identity mismatch/);
  const broken = adapter.createAttempt(prepared.attemptContext);
  broken.observeChunk({ type: "reasoning-start", id: "r1" });
  assert.equal(broken.finalizeAttempt().ok, false);
});

test("Moonshot Adapter → locked SDK serializes retained reasoning and tool ordering for K2.6", async () => {
  const adapter = new MoonshotConversationStateAdapter(profile);
  const messages: ModelMessage[] = [
    { role: "user", content: "use tool" },
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: { value: "hello" } },
    ] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "echo",
      output: { type: "text", value: "hello" } }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "follow up" },
  ];
  const history: History = [source(1, "first reasoning"), source(3, "final reasoning")];
  let body: Record<string, unknown> = {};
  const mockFetch: typeof fetch = async (_, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(sse([
      chunk("kimi-k2.6", { reasoning_content: "new thought" }),
      chunk("kimi-k2.6", { content: "reply" }),
      chunk("kimi-k2.6", {}, "stop"),
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "kimi-k2.6", choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
    ]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const prepared = adapter.prepareInvocation({ profile, messages, history, providerOptions: {} });
  const attempt = adapter.createAttempt(prepared.attemptContext);
  const model = createMoonshotAI({ apiKey: "fixture", fetch: mockFetch }).chatModel("kimi-k2.6");
  const result = streamText({ model, messages: prepared.messages, providerOptions: { moonshotai: prepared.providerOptions } });
  const chunkTypes: string[] = [];
  for await (const part of result.fullStream) { chunkTypes.push(part.type); attempt.observeChunk(part); }
  assert.ok(chunkTypes.includes("reasoning-delta"));
  assert.deepEqual(attempt.finalizeAttempt(), { ok: true, allowsReplayOnlyAssistant: true });
  assert.ok(Object.keys(body).length > 0);
  assert.deepEqual(body.thinking, { type: "enabled", keep: "all" });
  const wireMessages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(wireMessages.map((message) => message.role), ["user", "assistant", "tool", "assistant", "user"]);
  assert.equal(wireMessages[1]?.reasoning_content, "first reasoning");
  assert.equal(wireMessages[3]?.reasoning_content, "final reasoning");
  assert.equal((wireMessages[1]?.tool_calls as Array<{ id: string }>)[0]?.id, "call-1");
  assert.equal(wireMessages[2]?.tool_call_id, "call-1");
  const usage = await result.totalUsage;
  assert.equal(usage.totalTokens, 12);
});

test("K2.7 Code fixed thinking does not send K2.6-only keep parameter", async () => {
  const codeProfile = { ...profile, model: { ...profile.model, providerModelId: "kimi-k2.7-code" } };
  const adapter = new MoonshotConversationStateAdapter(codeProfile);
  const codeIdentity = { ...identity, model: "kimi-k2.7-code" };
  const prepared = adapter.prepareInvocation({ profile: codeProfile,
    messages: [{ role: "assistant", content: [{ type: "text", text: "previous" }] }],
    history: [{ assistantOrdinal: 0, assistantProvenance: codeIdentity, parts: [{ type: "reasoning", visibleIndex: 0,
      text: "code reasoning", providerReplay: { ...replay("reasoning"), provider: {
        ...replay("reasoning").provider, model: "kimi-k2.7-code" } } }] }], providerOptions: {} });
  let requestBody: Record<string, unknown> = {};
  const mockFetch: typeof fetch = async (_, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(sse([chunk("kimi-k2.7-code", { content: "done" }), chunk("kimi-k2.7-code", {}, "stop")]),
      { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const model = createMoonshotAI({ apiKey: "fixture", fetch: mockFetch }).chatModel("kimi-k2.7-code");
  const response = streamText({ model, messages: prepared.messages, providerOptions: { moonshotai: prepared.providerOptions } });
  for await (const _chunk of response.fullStream) { /* consume mocked stream */ }
  assert.deepEqual(requestBody.thinking, { type: "enabled" });
  assert.equal((requestBody.messages as Array<{ reasoning_content?: string }>)[0]?.reasoning_content, "code reasoning");
});

test("Moonshot replay stops at foreign or legacy Assistant, even after switching back", () => {
  const adapter = new MoonshotConversationStateAdapter(profile);
  const messages: ModelMessage[] = [
    { role: "assistant", content: [{ type: "text", text: "older" }] },
    { role: "assistant", content: [] },
    { role: "assistant", content: [{ type: "text", text: "recent" }] },
  ];
  const restored = adapter.prepareInvocation({ profile, messages, history: [source(0, "must not return"),
    { assistantOrdinal: 1, assistantProvenance: null, parts: [] }, source(2, "fresh")], providerOptions: {} });
  assert.equal(restored.messages.length, 2);
  assert.deepEqual((restored.messages[0] as { content: Array<{ text: string }> }).content,
    [{ type: "text", text: "older" }]);
  assert.deepEqual((restored.messages[1] as { content: Array<{ text: string }> }).content[0],
    { type: "reasoning", text: "fresh" });
});
