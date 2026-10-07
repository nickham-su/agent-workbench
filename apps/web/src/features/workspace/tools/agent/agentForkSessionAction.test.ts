import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionRecord } from "@agent-workbench/shared";
import { runAgentSessionForkAction } from "./agentForkSessionAction";
import { runAgentSessionMessageMutation } from "./agentMessageMutationAction";
import { createAgentMessageMutationState } from "./agentMessageMutationState";

const forkRecord: AgentSessionRecord = { id: "forked-session", workspaceId: "ws", title: "fork", kind: "primary", headMessageId: "msg", contextRootMessageId: null, revision: 0, forkedFromSessionId: "source-session", forkedFromMessageId: "historical-message", createdAt: 1, updatedAt: 1 };

test("时间线 Fork 使用来源 Session 与消息构造请求，并在成功后通知新 Session", async () => {
  const requests: unknown[] = [];
  const forked: AgentSessionRecord[] = [];
  await runAgentSessionForkAction({
    sourceSessionId: "source-session",
    sourceMessageId: "historical-message",
    fork: async (request) => {
      requests.push(request);
      return forkRecord;
    },
    onForked: (sessionId) => forked.push(sessionId),
  });
  assert.deepEqual(requests, [{ fromSessionId: "source-session", fromMessageId: "historical-message" }]);
  assert.deepEqual(forked, [forkRecord]);
  assert.equal(forked[0], forkRecord, "完整返回记录沿事件链保留，不额外读取");
});

test("时间线 Fork 失败时不发送成功通知，由外层 mutation 负责释放 pending", async () => {
  const forked: AgentSessionRecord[] = [];
  const state = createAgentMessageMutationState();
  const errors: unknown[] = [];
  const accepted = await runAgentSessionMessageMutation({
    state,
    sessionId: "source-session",
    mutate: async () => await runAgentSessionForkAction({
      sourceSessionId: "source-session",
      sourceMessageId: "historical-message",
      fork: async () => { throw new Error("fork failed"); },
      onForked: (sessionId) => forked.push(sessionId),
    }),
    onError: (error) => errors.push(error),
  });
  assert.equal(accepted, false);
  assert.equal(state.isPending("source-session"), false);
  assert.equal(errors.length, 1);
  assert.deepEqual(forked, []);
});
