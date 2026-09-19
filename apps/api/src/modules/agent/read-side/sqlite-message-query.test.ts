import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { AGENT_TIMELINE_TEXT_MAX_LENGTH } from "@agent-workbench/shared";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendMessage,
  appendStreamingAssistant,
  commitCompactionMessage,
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

test("timeline 对历史超长工具预览和错误做契约内截断", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "user-1", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [{ id: "user-1-text", position: 0, type: "text", text: "first" }], createdAt: 2
  });
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('assistant-1','ws','user-1',null,1,'assistant','completed',null,null,2,3,3)`).run();
  db.prepare(`insert into agent_message_part (id,message_id,position,type,tool_name,tool_input_json,updated_revision,created_at,updated_at)
    values ('call-1','assistant-1',0,'tool_call','skill','{}',2,3,3)`).run();
  const longPreview = "p".repeat(AGENT_TIMELINE_TEXT_MAX_LENGTH + 683);
  const longError = "e".repeat(AGENT_TIMELINE_TEXT_MAX_LENGTH + 17);
  db.prepare(`insert into agent_tool_execution
    (id,call_part_id,origin_session_id,origin_run_id,status,result_preview,result_truncated,error,updated_revision,created_at,updated_at)
    values ('execution-1','call-1',null,null,'failed',?,0,?,2,3,3)`)
    .run(longPreview, longError);
  db.prepare("update agent_session set head_message_id='assistant-1',revision=2,updated_at=3 where id='session'").run();

  const snapshot = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "snapshot" });
  assert.equal(snapshot.toolExecutions[0]?.resultPreview?.length, AGENT_TIMELINE_TEXT_MAX_LENGTH);
  assert.equal(snapshot.toolExecutions[0]?.error?.length, AGENT_TIMELINE_TEXT_MAX_LENGTH);
  assert.equal(snapshot.toolExecutions[0]?.resultTruncated, true);

  const delta = query.getTimeline({
    workspaceId: "ws",
    sessionId: "session",
    mode: "delta",
    sinceRevision: 0,
    knownHeadMessageId: "assistant-1",
  });
  assert.equal(delta.toolExecutions[0]?.resultPreview?.length, AGENT_TIMELINE_TEXT_MAX_LENGTH);
  assert.equal(delta.toolExecutions[0]?.error?.length, AGENT_TIMELINE_TEXT_MAX_LENGTH);
  assert.equal(delta.toolExecutions[0]?.resultTruncated, true);
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

test("压缩后 Timeline 保留完整展示历史，运行时上下文仅从最新 compaction 开始", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "user-1", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [{ id: "user-1-text", position: 0, type: "text", text: "old request" }], createdAt: 2,
  });
  appendMessage(db, {
    id: "assistant-1", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "user-1", expectedRevision: 1,
    type: "assistant", status: "completed", parts: [{ id: "assistant-1-text", position: 0, type: "text", text: "old answer" }], createdAt: 3,
  });
  commitCompactionMessage(db, {
    id: "compaction-1", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "assistant-1", expectedRevision: 2,
    textPartId: "compaction-1-text", text: "summary one", createdAt: 4,
  });
  appendMessage(db, {
    id: "user-2", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "compaction-1", expectedRevision: 3,
    type: "user", status: "completed", parts: [{ id: "user-2-text", position: 0, type: "text", text: "new request" }], createdAt: 5,
  });
  commitCompactionMessage(db, {
    id: "compaction-2", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "user-2", expectedRevision: 4,
    textPartId: "compaction-2-text", text: "summary two", createdAt: 6,
  });

  const timeline = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "snapshot", limit: 10 });
  assert.deepEqual(timeline.messages.map((message) => message.id), ["user-1", "assistant-1", "compaction-1", "user-2", "compaction-2"]);
  assert.deepEqual(timeline.messages.map((message) => message.inActiveContext), [false, false, false, false, true]);
  assert.equal(timeline.messages.at(-1)?.type, "compaction");
  assert.equal(timeline.messages.at(-1)?.parts[0]?.type, "text");
  assert.equal(timeline.messages.at(-1)?.parts[0] && (timeline.messages.at(-1)?.parts[0] as { text: string }).text, "summary two");

  const runtime = query.getRuntimeTranscriptSource({ workspaceId: "ws", sessionId: "session" });
  assert.deepEqual(runtime.messages.map((message) => message.id), ["compaction-2"]);
  assert.equal(runtime.messages[0]?.inActiveContext, undefined);
  assert.equal(runtime.messages[0]?.parts[0] && (runtime.messages[0]?.parts[0] as { text: string }).text, "summary two");
  db.close();
});

test("压缩后 Timeline 的 snapshot 与 before 分页可继续读取压缩前历史", () => {
  const { db, query } = createFixture();
  let head: string | null = null;
  for (let index = 1; index <= 3; index += 1) {
    const id = `user-${index}`;
    appendMessage(db, {
      id, workspaceId: "ws", sessionId: "session", expectedHeadMessageId: head, expectedRevision: index - 1,
      type: "user", status: "completed", parts: [], createdAt: index + 1,
    });
    head = id;
  }
  commitCompactionMessage(db, {
    id: "compaction", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: head, expectedRevision: 3,
    textPartId: "compaction-text", text: "summary", createdAt: 6,
  });
  const tail = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "snapshot", limit: 2 });
  assert.deepEqual(tail.messages.map((message) => message.id), ["user-3", "compaction"]);
  assert.equal(tail.hasMore, true);
  const previous = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "before", beforeMessageId: tail.nextBeforeMessageId!, limit: 2 });
  assert.deepEqual(previous.messages.map((message) => message.id), ["user-1", "user-2"]);
  assert.equal(previous.hasMore, false);
  db.close();
});

test("超长展示链的 Timeline 分页保持有界，并可跨越压缩边界", () => {
  const { db, query } = createFixture();
  let head: string | null = null;
  for (let index = 1; index <= 1_100; index += 1) {
    const id = `message-${index}`;
    appendMessage(db, {
      id, workspaceId: "ws", sessionId: "session", expectedHeadMessageId: head, expectedRevision: index - 1,
      type: "user", status: "completed", parts: [
        { id: `${id}-text-1`, position: 0, type: "text", text: `first ${index}` },
        { id: `${id}-text-2`, position: 1, type: "text", text: `second ${index}` },
      ], createdAt: index + 1,
    });
    head = id;
  }
  appendMessage(db, {
    id: "tool-message", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: head, expectedRevision: 1_100,
    type: "assistant", status: "completed", parts: [{ id: "tool-call", position: 0, type: "tool_call", toolName: "write", input: {} }], createdAt: 1_102,
  });
  db.prepare(`
    insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_preview,result_truncated,updated_revision,created_at,updated_at)
    values ('tool-execution','tool-call','session',null,'completed',null,0,1101,1102,1102)
  `).run();
  head = "tool-message";
  commitCompactionMessage(db, {
    id: "compaction", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: head, expectedRevision: 1_101,
    textPartId: "compaction-text", text: "summary", createdAt: 1_103,
  });

  const tail = query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "snapshot", limit: 2 });
  assert.deepEqual(tail.messages.map((message) => message.id), ["tool-message", "compaction"]);
  assert.equal(tail.hasMore, true);
  const previous = query.getTimeline({
    workspaceId: "ws", sessionId: "session", mode: "before", beforeMessageId: tail.nextBeforeMessageId!, limit: 2,
  });
  assert.deepEqual(previous.messages.map((message) => message.id), ["message-1099", "message-1100"]);
  assert.equal(previous.hasMore, true);
  assert.deepEqual(
    query.getTimeline({ workspaceId: "ws", sessionId: "session", mode: "delta", sinceRevision: 0, knownHeadMessageId: "compaction", knownContextRootMessageId: "compaction" })
      .toolExecutions.map((execution) => execution.id),
    ["tool-execution"],
  );
  assert.equal(query.getToolExecutionDetail({ workspaceId: "ws", sessionId: "session", toolExecutionId: "tool-execution" }).id, "tool-execution");
  assert.deepEqual(
    query.getArtifactToolExecution({ workspaceId: "ws", sessionId: "session", toolExecutionId: "tool-execution", toolName: "write" }),
    { workspaceId: "ws", toolExecutionId: "tool-execution" },
  );

  const delta = query.getTimeline({
    workspaceId: "ws", sessionId: "session", mode: "delta", sinceRevision: 0,
    knownHeadMessageId: "compaction", knownContextRootMessageId: "compaction",
  });
  assert.equal(delta.messages.length, 1_102);
  assert.deepEqual(
    delta.messages.find((message) => message.id === "message-1")?.parts.map((part) => [part.id, part.position, part.type]),
    [["message-1-text-1", 0, "text"], ["message-1-text-2", 1, "text"]],
  );
  assert.deepEqual(
    delta.messages.find((message) => message.id === "message-500")?.parts.map((part) => [part.id, part.position, part.type]),
    [["message-500-text-1", 0, "text"], ["message-500-text-2", 1, "text"]],
  );
  assert.deepEqual(
    delta.messages.find((message) => message.id === "message-501")?.parts.map((part) => [part.id, part.position, part.type]),
    [["message-501-text-1", 0, "text"], ["message-501-text-2", 1, "text"]],
  );
  db.close();
});

test("Provider replay 不会跨越 compaction 进入运行时上下文", () => {
  const { db, query } = createFixture();
  appendMessage(db, {
    id: "user", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [], createdAt: 2,
  });
  createMessageRunRecord(db, {
    runId: "run", workspaceId: "ws", sessionId: "session", triggerMessageId: "user",
    agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 3,
  });
  startMessageRun(db, { workspaceId: "ws", sessionId: "session", runId: "run", updatedAt: 3 });
  appendStreamingAssistant(db, {
    id: "assistant", workspaceId: "ws", sessionId: "session", runId: "run",
    expectedHeadMessageId: "user", expectedRevision: 1, createdAt: 4,
  });
  flushStreamingParts(db, {
    workspaceId: "ws", sessionId: "session", runId: "run", messageId: "assistant", updatedAt: 5,
    parts: [{
      id: "replay-part", position: 0, type: "reasoning", text: "",
      providerReplay: {
        version: 1,
        provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "provider", model: "gpt-5" },
        item: { type: "reasoning", itemId: "reasoning-1", encryptedContent: "ciphertext" },
      },
    }],
  });
  completeAssistantWithExecutions(db, {
    workspaceId: "ws", sessionId: "session", runId: "run", messageId: "assistant", executions: [], updatedAt: 6,
  });
  assert.deepEqual([...query.getRuntimeProviderReplaySource({ workspaceId: "ws", sessionId: "session" }).keys()], ["replay-part"]);
  commitCompactionMessage(db, {
    id: "compaction", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "assistant", expectedRevision: 4,
    textPartId: "compaction-text", text: "summary", createdAt: 7,
  });
  assert.deepEqual([...query.getRuntimeProviderReplaySource({ workspaceId: "ws", sessionId: "session" }).keys()], []);
  db.close();
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
