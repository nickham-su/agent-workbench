import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import { restoreChatReasoning } from "./chat-replay.js";

const identity = { providerNpm: "@ai-sdk/deepseek" as const, providerId: "config-a", model: "deepseek-v4-pro",
  protocol: "deepseek-chat" as const, protocolVersion: 1 as const, endpointDigest: "a".repeat(64) };
const replay = { version: 1 as const, provider: { npm: identity.providerNpm, api: "chat-completions" as const,
  providerId: identity.providerId, model: identity.model, protocolVersion: 1 as const, endpointDigest: identity.endpointDigest }, item: { type: "reasoning" as const } };
type History = NonNullable<AgentApiPromptContextResponse["providerReplay"]>;
const source = (index: number, text: string): History[number] => ({ assistantOrdinal: index,
  assistantProvenance: identity, parts: [{ type: "reasoning", text, visibleIndex: 0, providerReplay: replay }] });

const assistant = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });

test("recovers current continuous Assistant suffix without moving tool messages", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "go" }, assistant("first"),
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call-a", toolName: "a", output: { type: "text", value: "ok" } }] },
    assistant("second"), { role: "user", content: "again" }, assistant("last"),
  ];
  const result = restoreChatReasoning({ messages, history: [source(1, "r1"), source(3, "r2"), source(5, "r3")], identity });
  assert.deepEqual(result.map((m) => m.role), messages.map((m) => m.role));
  assert.equal((result[1] as { content: Array<{ text: string }> }).content[0]?.text, "r1");
  assert.equal((result[3] as { content: Array<{ text: string }> }).content[0]?.text, "r2");
  assert.equal((result[5] as { content: Array<{ text: string }> }).content[0]?.text, "r3");
});

test("missing, untrusted or switched Assistant is a hard boundary; empty placeholders never reach SDK", () => {
  const messages: ModelMessage[] = [assistant("past"), { role: "assistant", content: [] }, assistant("recent")];
  const result = restoreChatReasoning({ messages, history: [source(0, "stale"),
    { assistantOrdinal: 1, assistantProvenance: null, parts: [] }, source(2, "fresh")], identity });
  assert.equal(result.length, 2);
  assert.deepEqual((result[0] as { content: Array<{ text: string }> }).content[0], { type: "text", text: "past" });
  assert.equal((result[1] as { content: Array<{ text: string }> }).content[0]?.text, "fresh");
  const switched = restoreChatReasoning({ messages: [assistant("old"), assistant("new")], history: [source(0, "old"), {
    ...source(1, "new"), assistantProvenance: { ...identity, providerId: "config-b" },
  }], identity });
  assert.deepEqual(switched, [assistant("old"), assistant("new")]);
});
