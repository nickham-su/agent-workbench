import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderNpmSchema, mergeReasoningProviderOptions, sanitizeReasoningProviderOptions } from "../src/index.js";
import { Value } from "@sinclair/typebox/value";
import {
  assertAgentProviderReplayUpdateCompatible,
  isLegacyChatReplayWithoutEndpointDigest,
  parseAgentProviderReplay,
  serializeAgentProviderReplay,
} from "../src/internal-contracts/agent-provider-replay.js";
import { AgentApiFlushAssistantPartsRequestSchema } from "../src/internal-contracts/agent-api-message.js";

const provider = { npm: "@ai-sdk/deepseek" as const, api: "chat-completions" as const,
  protocolVersion: 1 as const, providerId: "config-1", model: "deepseek-v4-pro", endpointDigest: "a".repeat(64) };

test("new Provider enums, strict reserved options and fixed-last merge", () => {
  assert.equal(Value.Check(AgentProviderNpmSchema, "@ai-sdk/moonshotai"), true);
  assert.equal(Value.Check(AgentProviderNpmSchema, "@ai-sdk/deepseek"), true);
  const user = JSON.parse('{" parallelToolCalls ":true," thinking ":{"type":"disabled"},"reasoning-history":"drop","REASONING_EFFORT":"high","extra":{"__proto__":"unsafe","thinking":"ordinary"},"constructor":{}}');
  assert.deepEqual(mergeReasoningProviderOptions(user, { thinking: { type: "enabled" } }), {
    parallelToolCalls: true, extra: { thinking: "ordinary" }, thinking: { type: "enabled" },
  });
  assert.deepEqual(sanitizeReasoningProviderOptions([]), {});
  assert.deepEqual(sanitizeReasoningProviderOptions(new Date()), {});
});

test("only closed pre-digest Chat v1 can be recognized as a non-replayable legacy boundary", () => {
  for (const npm of ["@ai-sdk/moonshotai", "@ai-sdk/deepseek"] as const) {
    for (const type of ["reasoning", "text", "tool_call"] as const) {
      const old = { version: 1, provider: { npm, api: "chat-completions", protocolVersion: 1,
        providerId: "config-1", model: "model-1" }, item: { type } };
      assert.equal(isLegacyChatReplayWithoutEndpointDigest(JSON.stringify(old)), true);
      assert.equal(parseAgentProviderReplay(JSON.stringify(old)), null, "legacy must never become replayable");
      for (const altered of [
        { ...old, version: 2 },
        { ...old, provider: { ...old.provider, extra: "unknown" } },
        { ...old, item: { ...old.item, text: "private" } },
        { ...old, provider: { ...old.provider, endpointDigest: "not-a-digest" } },
      ]) assert.equal(isLegacyChatReplayWithoutEndpointDigest(JSON.stringify(altered)), false);
    }
  }
  assert.equal(isLegacyChatReplayWithoutEndpointDigest("{broken"), false);
  assert.equal(isLegacyChatReplayWithoutEndpointDigest('{"version":1,"provider":{"npm":"@ai-sdk/openai"}}'), false);
});

test("chat replay is minimal and cannot mutate a Part's provenance", () => {
  const reasoning = { version: 1 as const, provider, item: { type: "reasoning" as const } };
  const serialized = serializeAgentProviderReplay(reasoning);
  assert.deepEqual(parseAgentProviderReplay(serialized), reasoning);
  assert.equal(parseAgentProviderReplay(JSON.stringify({ ...reasoning, secret: "no" })), null);
  assert.equal(parseAgentProviderReplay(JSON.stringify({ ...reasoning, item: { type: "reasoning", text: "private" } })), null);
  assert.equal(parseAgentProviderReplay(JSON.stringify({ ...reasoning, version: 2 })), null);
  assert.throws(() => assertAgentProviderReplayUpdateCompatible(reasoning, { ...reasoning, provider: { ...provider, model: "another" } }));
  assert.throws(() => assertAgentProviderReplayUpdateCompatible(reasoning, { ...reasoning, provider: { ...provider, npm: "@ai-sdk/moonshotai" } }));
  assert.throws(() => assertAgentProviderReplayUpdateCompatible(reasoning, { ...reasoning, provider: { ...provider, endpointDigest: "b".repeat(64) } }));
  assert.equal(parseAgentProviderReplay(JSON.stringify({ ...reasoning, provider: { ...provider, endpointDigest: "not a digest" } })), null);
  assert.equal(parseAgentProviderReplay(JSON.stringify({ ...reasoning, provider: { ...provider, endpointDigest: undefined } })), null);
  assert.throws(() => assertAgentProviderReplayUpdateCompatible(reasoning, { ...reasoning, item: { type: "text" } }));
});

test("historical OpenAI JSON survives replay normalization", () => {
  const raw = '{"version":1,"provider":{"npm":"@ai-sdk/openai","api":"responses","providerId":"o","model":"gpt"},"item":{"type":"reasoning","itemId":"rs","encryptedContent":"cipher","summaryIndex":0}}';
  assert.equal(serializeAgentProviderReplay(JSON.parse(raw)), raw);
  assert.deepEqual(parseAgentProviderReplay(raw), JSON.parse(raw));
});
test("chat tool provenance is accepted by the protected flush contract", () => {
  const value = {
    workspaceId: "workspace", sessionId: "session", runId: "run", messageId: "message", updatedAt: 1,
    parts: [{ id: "part", position: 0, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: "call",
      providerReplay: { version: 1, provider, item: { type: "tool_call" } } }],
  };
  assert.equal(Value.Check(AgentApiFlushAssistantPartsRequestSchema, value), true);
  assert.equal(Value.Check(AgentApiFlushAssistantPartsRequestSchema, {
    ...value, parts: [{ ...value.parts[0], providerReplay: { ...value.parts[0]!.providerReplay,
      item: { type: "tool_call", itemId: "not-allowed" } } }],
  }), false);
});
