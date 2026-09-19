import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  createMessageSession,
  flushStreamingParts,
  startMessageRun,
  settleMessageRunIfCurrent,
  updateToolExecution
} from "../agent-message.store.js";
import { createMessageRunRecord } from "../agent-message.store.js";
import { HttpError } from "../../../app/errors.js";
import { SqliteMessageQuery } from "./sqlite-message-query.js";

function createFixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  return { db, query: new SqliteMessageQuery(db) };
}

test("Message timeline follows current Session ancestry and projects lightweight executions", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "user-1", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [{ id: "user-1-text", position: 0, type: "text", text: "first" }], createdAt: 2
  });
  createMessageRunRecord(db, {
    runId: "run-1", workspaceId: "ws", sessionId: "session", triggerMessageId: "user-1",
    agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 4
  });
  startMessageRun(db, { workspaceId: "ws", sessionId: "session", runId: "run-1", updatedAt: 4 });
  appendStreamingAssistant(db, {
    id: "assistant-1", workspaceId: "ws", sessionId: "session", runId: "run-1",
    expectedHeadMessageId: "user-1", expectedRevision: 1, createdAt: 5
  });
  flushStreamingParts(db, {
    workspaceId: "ws", sessionId: "session", runId: "run-1", messageId: "assistant-1", updatedAt: 6,
    parts: [{ id: "call-1", position: 0, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: "provider-call" }]
  });
  completeAssistantWithExecutions(db, {
    workspaceId: "ws", sessionId: "session", runId: "run-1", messageId: "assistant-1", updatedAt: 7,
    executions: [{ id: "execution-1", callPartId: "call-1", originSessionId: "session", originRunId: "run-1", status: "queued" }]
  });
  updateToolExecution(db, { workspaceId: "ws", sessionId: "session", runId: "run-1", executionId: "execution-1", status: "running", updatedAt: 8 });
  updateToolExecution(db, { workspaceId: "ws", sessionId: "session", runId: "run-1", executionId: "execution-1", status: "completed", resultPreview: "done", updatedAt: 9 });

  const timeline = query.getTimeline({ workspaceId: "ws", sessionId: "session" });
  assert.equal(timeline.timelineReset, false);
  assert.deepEqual(timeline.messages.map((message) => message.id), ["user-1", "assistant-1"]);
  assert.deepEqual(timeline.toolExecutions.map((execution) => ({
    id: execution.id,
    callPartId: execution.callPartId,
    status: execution.status,
    resultPreview: execution.resultPreview,
    error: execution.error,
    resultTruncated: execution.resultTruncated
  })), [{
    id: "execution-1", callPartId: "call-1", status: "completed", resultPreview: "done", error: null, resultTruncated: false
  }]);
  assert.throws(
    () => query.getMessage({ workspaceId: "ws", sessionId: "session", messageId: "not-on-chain" }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
});

test("Message timeline resets for stale root cursor and final text joins terminal assistant TextParts", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "user-1", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [{ id: "user-1-text", position: 0, type: "text", text: "first" }], createdAt: 2
  });
  db.prepare("update agent_session set context_root_message_id = 'user-1', revision = 4 where id = 'session'").run();
  createMessageRunRecord(db, {
    runId: "run-final", workspaceId: "ws", sessionId: "session", triggerMessageId: "user-1",
    agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 3
  });
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('assistant-final','ws','user-1',null,1,'assistant','completed','session','run-final',4,4,4)`).run();
  db.prepare(`insert into agent_message_part (id,message_id,position,type,text,updated_revision,created_at,updated_at)
    values ('final-1','assistant-final',0,'text','hello ',4,4,4), ('final-2','assistant-final',1,'text','world',4,4,4)`).run();
  db.prepare("update agent_session set head_message_id = 'assistant-final' where id = 'session'").run();

  assert.equal(query.getTimeline({ workspaceId: "ws", sessionId: "session", sinceRevision: 0 }).timelineReset, true);
  assert.deepEqual(query.getRunFinalText("run-final"), { found: true, text: "hello world" });
});


test("timeline snapshot 使用有界尾页，before cursor 按链向前分页", () => {
  const { db, query } = createFixture();
  let head: string | null = null;
  for (let index = 1; index <= 5; index += 1) {
    const id = `m-${index}`;
    appendMessage(db, {
      id, workspaceId: "ws", sessionId: "session", expectedHeadMessageId: head, expectedRevision: index - 1,
      type: "user", status: "completed", parts: [{ id: `${id}-text`, position: 0, type: "text", text: id }], createdAt: index + 1,
    });
    head = id;
  }
  const tail = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "snapshot", limit: 2 });
  assert.deepEqual(tail.messages.map((message) => message.id), ["m-4", "m-5"]);
  assert.equal(tail.hasMore, true);
  assert.equal(tail.nextBeforeMessageId, "m-4");
  const previous = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "before", beforeMessageId: tail.nextBeforeMessageId!, limit: 2 });
  assert.deepEqual(previous.messages.map((message) => message.id), ["m-2", "m-3"]);
  assert.equal(previous.hasMore, true);
  const first = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "before", beforeMessageId: previous.nextBeforeMessageId!, limit: 2 });
  assert.deepEqual(first.messages.map((message) => message.id), ["m-1"]);
  assert.equal(first.hasMore, false);
  assert.throws(
    () => query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "before", beforeMessageId: "not-visible" }),
    (error: unknown) => error instanceof HttpError && error.code === "TIMELINE_CURSOR_NOT_FOUND",
  );
});

test("timeline delta 在 head 或 contextRoot 前提失效时返回尾部 reset snapshot", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "root", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [], createdAt: 2,
  });
  appendMessage(db, {
    id: "head", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "root", expectedRevision: 1,
    type: "assistant", status: "completed", parts: [], createdAt: 3,
  });
  db.prepare("update agent_session set context_root_message_id = 'head', revision = 3 where id = 'session'").run();
  const reset = query.getTimeline({
    workspaceId: "ws", sessionId: "session", mode: "delta", sinceRevision: 2,
    knownHeadMessageId: "root", knownContextRootMessageId: "root", limit: 1,
  });
  assert.equal(reset.timelineReset, true);
  assert.deepEqual(reset.messages.map((message) => message.id), ["head"]);
  assert.equal(reset.toolExecutions.length, 0);
});

test("run state 投影最近响应 Token、当前 Run 起点与最近终态 Run 耗时", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "user", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [], createdAt: 2,
  });
  createMessageRunRecord(db, {
    runId: "run-completed", workspaceId: "ws", sessionId: "session", triggerMessageId: "user",
    agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 10,
  });
  db.prepare("update agent_run set updated_at = 70 where run_id = 'run-completed'").run();
  createMessageRunRecord(db, {
    runId: "run-active", workspaceId: "ws", sessionId: "session", triggerMessageId: "user",
    agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 100,
  });
  startMessageRun(db, { workspaceId: "ws", sessionId: "session", runId: "run-active", updatedAt: 100 });
  appendStreamingAssistant(db, {
    id: "assistant", workspaceId: "ws", sessionId: "session", runId: "run-active",
    expectedHeadMessageId: "user", expectedRevision: 1, createdAt: 101,
  });

  assert.equal(completeAssistantWithExecutions(db, {
    workspaceId: "ws", sessionId: "session", runId: "run-active", messageId: "assistant",
    executions: [], responseTotalTokens: 1234, updatedAt: 102,
  }), "updated");

  assert.deepEqual(
    (({ lastResponseTotalTokens, activeRunStartedAt, lastRunDurationMs }) => ({ lastResponseTotalTokens, activeRunStartedAt, lastRunDurationMs }))(
      query.getRunState({ workspaceId: "ws", sessionId: "session" }),
    ),
    { lastResponseTotalTokens: 1234, activeRunStartedAt: 100, lastRunDurationMs: 60 },
  );

  assert.equal(completeAssistantWithExecutions(db, {
    workspaceId: "ws", sessionId: "session", runId: "run-active", messageId: "assistant",
    executions: [], responseTotalTokens: null, updatedAt: 102,
  }), "updated");
  assert.equal(query.getRunState({ workspaceId: "ws", sessionId: "session" }).lastResponseTotalTokens, 1234);

  settleMessageRunIfCurrent(db, { workspaceId: "ws", sessionId: "session", runId: "run-active", updatedAt: 103 });
  const idleState = query.getRunState({ workspaceId: "ws", sessionId: "session" });
  assert.equal(idleState.activeRunStartedAt, null);
  assert.equal(idleState.lastRunDurationMs, 60);
  db.close();
});
