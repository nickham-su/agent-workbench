import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOpenAiResponsesReplay,
  buildOpenAiResponsesProviderOptions,
  collectOpenAiResponsesReplayChunk,
  collectOpenAiResponsesTerminalReplay,
  collectOpenAiResponsesToolCallReplay,
  openAiResponsesTerminalStatus,
} from "./openai-responses-replay.js";

const profile = {
  provider: { id: "provider-a", npm: "@ai-sdk/openai" },
  model: { id: "internal-model", providerModelId: "gpt-5" },
};
const provider = { npm: "@ai-sdk/openai" as const, api: "responses" as const, providerId: "provider-a", model: "gpt-5" };

test("OpenAI Responses options force local encrypted reasoning replay mode", () => {
  assert.deepEqual(buildOpenAiResponsesProviderOptions({
    include: ["message.output_text.logprobs"], store: true,
    previousResponseId: "resp-old", previous_response_id: "resp-snake",
    conversation: "conv-old", reasoningContext: "all_turns", reasoning_context: "current_turn",
    textVerbosity: "low",
  }), {
    include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
    store: false,
    textVerbosity: "low",
  });
});

test("normalizes assistant string content only when compatible replay exists", () => {
  const messages = [{ role: "assistant" as const, content: "plain answer" }];
  const source = [{ assistantOrdinal: 0, parts: [
    { visibleIndex: 0, type: "reasoning" as const, text: "summary", providerReplay: { version: 1 as const, provider, item: { type: "reasoning" as const, itemId: "rs-1", encryptedContent: "cipher" } } },
    { visibleIndex: 0, type: "text" as const, providerReplay: { version: 1 as const, provider, item: { type: "text" as const, itemId: "msg-1", phase: "final_answer" as const } } },
  ] }];
  assert.deepEqual(applyOpenAiResponsesReplay({ profile, messages, source })[0], {
    role: "assistant", content: [
      { type: "reasoning", text: "summary", providerOptions: { openai: { itemId: "rs-1", reasoningEncryptedContent: "cipher" } } },
      { type: "text", text: "plain answer", providerOptions: { openai: { itemId: "msg-1", phase: "final_answer" } } },
    ],
  });
  assert.equal(applyOpenAiResponsesReplay({ profile, messages, source: [] })[0], messages[0]);
});

test("replay-only Assistant becomes a reasoning-only model message without visible placeholder", () => {
  const messages = [{ role: "assistant" as const, content: [] }];
  const source = [{ assistantOrdinal: 0, parts: [{
    visibleIndex: 0,
    type: "reasoning" as const,
    text: "",
    providerReplay: { version: 1 as const, provider, item: { type: "reasoning" as const, itemId: "rs-only", encryptedContent: "cipher-only" } },
  }] }];
  assert.deepEqual(applyOpenAiResponsesReplay({ profile, messages, source }), [{
    role: "assistant",
    content: [{ type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs-only", reasoningEncryptedContent: "cipher-only" } } }],
  }]);
  assert.deepEqual(applyOpenAiResponsesReplay({ profile: { ...profile, provider: { ...profile.provider, id: "other" } }, messages, source }), []);
  assert.deepEqual(applyOpenAiResponsesReplay({ profile: { ...profile, provider: { ...profile.provider, npm: "@ai-sdk/openai-compatible" } }, messages, source }), []);
});

test("applies compatible replay in original assistant part order", () => {
  const messages = [{
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: "answer" },
      { type: "tool-call" as const, toolCallId: "call-1", toolName: "read", input: { filePath: "a" } },
    ],
  }, {
    role: "tool" as const,
    content: [{ type: "tool-result" as const, toolCallId: "call-1", toolName: "read", output: { type: "text" as const, value: "ok" } }],
  }];
  const replayed = applyOpenAiResponsesReplay({
    profile,
    messages,
    source: [{
      assistantOrdinal: 0,
      parts: [
        { visibleIndex: 0, type: "reasoning", text: "summary", providerReplay: { version: 1, provider, item: { type: "reasoning", itemId: "rs-1", encryptedContent: "cipher" } } },
        { visibleIndex: 0, type: "text", providerReplay: { version: 1, provider, item: { type: "text", itemId: "msg-1", phase: "final_answer" } } },
        { visibleIndex: 1, type: "tool_call", providerReplay: { version: 1, provider, item: { type: "function_call", itemId: "fc-1" } } },
      ],
    }],
  });
  assert.deepEqual(replayed[0], {
    role: "assistant",
    content: [
      { type: "reasoning", text: "summary", providerOptions: { openai: { itemId: "rs-1", reasoningEncryptedContent: "cipher" } } },
      { type: "text", text: "answer", providerOptions: { openai: { itemId: "msg-1", phase: "final_answer" } } },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { filePath: "a" }, providerOptions: { openai: { itemId: "fc-1" } } },
    ],
  });
  assert.equal(replayed[1], messages[1]);
});

test("compatibility only uses provider configuration id and final model", () => {
  const message = [{ role: "assistant" as const, content: [{ type: "text" as const, text: "answer" }] }];
  const source = [{ assistantOrdinal: 0, parts: [{ visibleIndex: 0, type: "text" as const, providerReplay: { version: 1 as const, provider, item: { type: "text" as const, itemId: "msg-1" } } }] }];
  assert.notEqual(applyOpenAiResponsesReplay({ profile: { ...profile, model: { id: "different-internal", providerModelId: "gpt-5" } }, messages: message, source })[0], message[0]);
  // `OpenAiReplayProfile` intentionally has no base URL or model options: neither is a
  // compatibility input. Extra runtime profile fields must likewise have no effect.
  const profileWithChangedEndpointAndOptions = {
    ...profile,
    provider: { ...profile.provider, options: { baseURL: "https://new-endpoint.example/v1" } },
    model: {
      ...profile.model,
      options: { temperature: 0.9, providerOptionsByKey: { openai: { textVerbosity: "low" } } },
    },
  };
  assert.notEqual(applyOpenAiResponsesReplay({
    profile: profileWithChangedEndpointAndOptions,
    messages: message,
    source,
  })[0], message[0]);
  assert.equal(applyOpenAiResponsesReplay({ profile: { ...profile, provider: { ...profile.provider, id: "other" } }, messages: message, source })[0], message[0]);
  assert.equal(applyOpenAiResponsesReplay({ profile: { ...profile, model: { id: "x", providerModelId: "gpt-5-mini" } }, messages: message, source })[0], message[0]);
  assert.equal(applyOpenAiResponsesReplay({ profile: { ...profile, provider: { id: "provider-a", npm: "@ai-sdk/openai-compatible" } }, messages: message, source })[0], message[0]);
});

test("collects reasoning end, text phase and function item metadata", () => {
  assert.deepEqual(collectOpenAiResponsesReplayChunk({ profile, chunk: { type: "reasoning-end", id: "rs-1:0", providerMetadata: { openai: { itemId: "rs-1", reasoningEncryptedContent: "cipher" } } } }), {
    id: "rs-1:0", type: "reasoning", providerReplay: { version: 1, provider, item: { type: "reasoning", itemId: "rs-1", encryptedContent: "cipher", summaryIndex: 0 } },
  });
  assert.deepEqual(collectOpenAiResponsesReplayChunk({ profile, chunk: { type: "text-end", id: "msg-1", providerMetadata: { openai: { itemId: "msg-1", phase: "commentary" } } } }), {
    id: "msg-1", type: "text", providerReplay: { version: 1, provider, item: { type: "text", itemId: "msg-1", phase: "commentary" } },
  });
  assert.deepEqual(collectOpenAiResponsesToolCallReplay({ profile, chunk: { type: "tool-call", toolCallId: "call-1", providerMetadata: { openai: { itemId: "fc-1" } } } }), {
    providerToolCallId: "call-1", providerReplay: { version: 1, provider, item: { type: "function_call", itemId: "fc-1" } },
  });
});

test("terminal response.completed fills final-only encrypted content", () => {
  const updates = collectOpenAiResponsesTerminalReplay({
    profile,
    reasoningPartIdsByItem: new Map([["rs-1", ["rs-1:0", "rs-1:1"]]]),
    rawValue: { type: "response.completed", response: { output: [{ type: "reasoning", id: "rs-1", encrypted_content: "final-cipher" }] } },
  });
  assert.equal(updates.length, 2);
  assert.equal(updates[1]?.providerReplay.item.type, "reasoning");
  if (updates[1]?.providerReplay.item.type === "reasoning") assert.equal(updates[1].providerReplay.item.encryptedContent, "final-cipher");
});

test("recognizes only OpenAI Responses terminal raw events", () => {
  assert.equal(openAiResponsesTerminalStatus({ type: "response.completed", response: {} }), "completed");
  assert.equal(openAiResponsesTerminalStatus({ type: "response.incomplete", response: {} }), "incomplete");
  assert.equal(openAiResponsesTerminalStatus({ type: "response.failed", response: {} }), "failed");
  assert.equal(openAiResponsesTerminalStatus({ type: "response.output_item.done" }), null);
});
