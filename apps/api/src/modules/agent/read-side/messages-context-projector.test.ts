import assert from "node:assert/strict";
import { test } from "node:test";
import { MessagesContextProjector } from "./messages-context-projector.js";

test("MessagesContextProjector preserves dynamic context inputs and appends only to the response array", async () => {
  const calls: string[] = [];
  const builtMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: unknown }> = [
    { role: "user", content: "persisted" }
  ];
  const projector = new MessagesContextProjector({
    async buildMessages(input) {
      calls.push(`messages:${input.workspaceId}:${input.sessionId}`);
      return { messages: builtMessages };
    },
    getActiveRunId(input) {
      calls.push(`active:${input.workspaceId}:${input.sessionId}`);
      return "active-run";
    },
    resolveUiLocale(input) {
      calls.push(`locale:${input.workspaceId}:${input.sessionId}:${input.activeRunId}`);
      return "zh-CN";
    },
    buildOneShotSystem(input) {
      calls.push(`system:${input.uiLocale}`);
      return "一次性系统消息";
    }
  });

  const result = await projector.getMessagesContext({
    workspaceId: "workspace",
    sessionId: "session",
    headItemId: 12,
    appendMessage: { role: "user", content: "one-shot" }
  });

  assert.deepEqual(calls, [
    "messages:workspace:session",
    "active:workspace:session",
    "locale:workspace:session:active-run",
    "system:zh-CN"
  ]);
  assert.equal(result.headItemId, 12);
  assert.equal(result.system, "一次性系统消息");
  assert.deepEqual(result.messages, [
    { role: "user", content: "persisted" },
    { role: "user", content: "one-shot" }
  ]);
  assert.equal(result.messages, builtMessages);
});

test("MessagesContextProjector ignores blank append messages while retaining locale fallback inputs", async () => {
  let activeRunId: string | null | undefined;
  let locale: string | null | undefined;
  const projector = new MessagesContextProjector({
    async buildMessages() {
      return { messages: [{ role: "assistant" as const, content: "reply" }] };
    },
    getActiveRunId: () => null,
    resolveUiLocale(input) {
      activeRunId = input.activeRunId;
      return null;
    },
    buildOneShotSystem(input) {
      locale = input.uiLocale;
      return "";
    }
  });

  const result = await projector.getMessagesContext({
    workspaceId: "workspace",
    sessionId: "session",
    headItemId: null,
    appendMessage: { role: "system", content: "   " }
  });

  assert.equal(activeRunId, null);
  assert.equal(locale, null);
  assert.deepEqual(result, {
    headItemId: null,
    messages: [{ role: "assistant", content: "reply" }],
    system: ""
  });
});
