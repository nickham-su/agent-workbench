import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesConversationStateAdapter } from "./openai-responses-adapter.js";
import { DefaultProviderConversationStateAdapterRegistry } from "./registry.js";

const profile = {
  provider: { id: "provider-a", npm: "@ai-sdk/openai", options: {} },
  model: { id: "internal-model", providerModelId: "gpt-5" },
  agent: { tools: [], pluginTools: [], mcpServers: [] },
  runtime: { modelRequestRetryBackoffMaxMs: 0 },
} as any;

function completedRaw() {
  return {
    type: "response.completed",
    response: {
      output: [{ type: "reasoning", id: "rs-1", encrypted_content: "cipher" }],
    },
  };
}

test("OpenAI Responses Adapter 保持请求准备行为并只选择官方 Responses", () => {
  const adapter = new OpenAIResponsesConversationStateAdapter(profile);
  const prepared = adapter.prepareInvocation({
    profile,
    messages: [{ role: "user", content: "question" }],
    history: [],
    providerOptions: { include: ["message.output_text.logprobs"], store: true, previousResponseId: "old" },
  });
  assert.deepEqual(prepared.messages, [{ role: "user", content: "question" }]);
  assert.deepEqual(prepared.providerOptions, {
    include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
    store: false,
  });
  assert.equal(prepared.includeRawChunks, true);

  const registry = new DefaultProviderConversationStateAdapterRegistry();
  assert.equal(registry.resolve(profile)?.protocol, "openai-responses");
  assert.equal(registry.resolve({ ...profile, provider: { ...profile.provider, npm: "@ai-sdk/openai-compatible" } }), null);
  assert.equal(registry.resolve({ ...profile, provider: { ...profile.provider, npm: "@ai-sdk/anthropic" } }), null);
});

test("每个 OpenAI Attempt 独立采集终态与 reasoning metadata", () => {
  const adapter = new OpenAIResponsesConversationStateAdapter(profile);
  const first = adapter.createAttempt();
  const initial = first.observeChunk({
    type: "reasoning-start",
    id: "rs-1:0",
    providerMetadata: { openai: { itemId: "rs-1", reasoningEncryptedContent: "cipher" } },
  });
  assert.equal(initial.partUpdate?.type, "reasoning");
  const terminal = first.observeChunk({ type: "raw", rawValue: completedRaw() });
  assert.equal(terminal.terminalPartUpdates?.length, 1);
  assert.deepEqual(first.finalizeAttempt(), { ok: true });

  const replacement = adapter.createAttempt();
  assert.deepEqual(replacement.finalizeAttempt(), {
    ok: false,
    code: "OPENAI_RESPONSES_COMPLETED_MISSING",
    message: "OpenAI Responses stream ended without response.completed",
  });
});

test("OpenAI Attempt 拒绝 failed、incomplete 与 unknown finish", () => {
  const adapter = new OpenAIResponsesConversationStateAdapter(profile);
  for (const rawValue of [
    { type: "response.failed", response: {} },
    { type: "response.incomplete", response: {} },
  ]) {
    const attempt = adapter.createAttempt();
    attempt.observeChunk({ type: "raw", rawValue: completedRaw() });
    attempt.observeChunk({ type: "raw", rawValue });
    assert.deepEqual(attempt.finalizeAttempt(), {
      ok: false,
      code: "OPENAI_RESPONSES_TERMINAL_FAILURE",
      message: "OpenAI Responses stream contained a failed or incomplete terminal event",
    });
  }
  const unknown = adapter.createAttempt();
  unknown.observeChunk({ type: "raw", rawValue: completedRaw() });
  unknown.observeChunk({ type: "finish", finishReason: "unknown" });
  assert.deepEqual(unknown.finalizeAttempt(), {
    ok: false,
    code: "OPENAI_RESPONSES_UNKNOWN_FINISH_REASON",
    message: "OpenAI Responses finish reason was unknown",
  });
});

test("OpenAI Attempt 对 failed/incomplete 优先给出终态失败诊断", () => {
  const adapter = new OpenAIResponsesConversationStateAdapter(profile);
  for (const rawValue of [
    { type: "response.failed", response: {} },
    { type: "response.incomplete", response: {} },
  ]) {
    const attempt = adapter.createAttempt();
    attempt.observeChunk({ type: "raw", rawValue });
    assert.deepEqual(attempt.finalizeAttempt(), {
      ok: false,
      code: "OPENAI_RESPONSES_TERMINAL_FAILURE",
      message: "OpenAI Responses stream contained a failed or incomplete terminal event",
    });
  }
});

test("OpenAI Attempt 终态冲突保持失败诊断优先于 unknown 和 completed", () => {
  const adapter = new OpenAIResponsesConversationStateAdapter(profile);
  const attempt = adapter.createAttempt();
  attempt.observeChunk({ type: "raw", rawValue: completedRaw() });
  attempt.observeChunk({ type: "finish", finishReason: "unknown" });
  attempt.observeChunk({ type: "raw", rawValue: { type: "response.failed", response: {} } });
  assert.deepEqual(attempt.finalizeAttempt(), {
    ok: false,
    code: "OPENAI_RESPONSES_TERMINAL_FAILURE",
    message: "OpenAI Responses stream contained a failed or incomplete terminal event",
  });
});
