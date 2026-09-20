import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendStreamingAssistant,
  convergeRunTerminal,
  persistRunTerminalIntent,
  completeAssistantWithExecutions,
  createMessageSession,
  flushStreamingParts,
  getMessageRunState,
  getToolExecution,
  updateToolExecution,
} from "../agent-message.store.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws-a','ws-a','Workspace A','/workspace/a',1,1)",
  ).run();
  createMessageSession(db, {
    id: "session-a",
    workspaceId: "ws-a",
    title: "Session A",
    kind: "primary",
    createdAt: 1,
  });
  db.prepare(
    "insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('run-a','ws-a','session-a',null,'agent-a','provider-a','model-a','running',1,1)",
  ).run();
  db.prepare(
    "update session_run_state set status='running',active_run_id='run-a',updated_at=1 where workspace_id='ws-a' and session_id='session-a'",
  ).run();
  return db;
}

function createQueuedExecution(db: Database.Database) {
  appendStreamingAssistant(db, {
    workspaceId: "ws-a",
    sessionId: "session-a",
    runId: "run-a",
    id: "message-assistant-a",
    expectedHeadMessageId: null,
    expectedRevision: 0,
    createdAt: 2,
  });
  flushStreamingParts(db, {
    workspaceId: "ws-a",
    sessionId: "session-a",
    runId: "run-a",
    messageId: "message-assistant-a",
    parts: [
      {
        id: "part-call-a",
        position: 0,
        type: "tool_call",
        toolName: "todolist",
        input: { goal: "迁移消息写回" },
        providerToolCallId: "call-a",
      },
    ],
    updatedAt: 3,
  });
  assert.equal(
    completeAssistantWithExecutions(db, {
      workspaceId: "ws-a",
      sessionId: "session-a",
      runId: "run-a",
      messageId: "message-assistant-a",
      executions: [
        {
          id: "execution-a",
          callPartId: "part-call-a",
          originSessionId: "session-a",
          originRunId: "run-a",
          status: "queued",
        },
      ],
      updatedAt: 4,
    }),
    "updated",
  );
}

test("Message writeback persists a ToolExecution through fenced terminal transitions", () => {
  const db = createDb();
  createQueuedExecution(db);

  assert.equal(
    updateToolExecution(db, {
      workspaceId: "ws-a",
      sessionId: "session-a",
      runId: "run-a",
      executionId: "execution-a",
      status: "running",
      startedAt: 5,
      updatedAt: 5,
    }),
    "updated",
  );
  assert.equal(
    updateToolExecution(db, {
      workspaceId: "ws-a",
      sessionId: "session-a",
      runId: "run-a",
      executionId: "execution-a",
      status: "completed",
      structuredResult: { goal: "迁移消息写回" },
      completedAt: 6,
      updatedAt: 6,
    }),
    "updated",
  );

  assert.equal(getToolExecution(db, "execution-a")?.status, "completed");
  assert.deepEqual(
    getMessageRunState(db, "ws-a", "session-a")?.nonTerminalToolExecutionIds,
    [],
  );
});

test("Message cancellation converges queued ToolExecution through ToolExecution convergence", () => {
  const db = createDb();
  createQueuedExecution(db);

  assert.equal(persistRunTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "session-a", runId: "run-a",
    status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 5,
  }), "updated");
  assert.deepEqual(convergeRunTerminal(db, {
    workspaceId: "ws-a", sessionId: "session-a", runId: "run-a", updatedAt: 5,
  }), { kind: "transitioned", finalStatus: "cancelled" });
  assert.equal(getToolExecution(db, "execution-a")?.status, "cancelled");
  assert.deepEqual(getMessageRunState(db, "ws-a", "session-a"), {
    workspaceId: "ws-a",
    sessionId: "session-a",
    status: "idle",
    activeRunId: null,
    runNoticeText: "",
    retryCount: 0,
    nextRetryAt: null,
    lastResponseTotalTokens: null,
    activeRunStartedAt: null,
    lastRunDurationMs: 4,
    activeAssistantMessageId: null,
    nonTerminalMessageIds: [],
    nonTerminalToolExecutionIds: [],
    updatedAt: 5,
  });
});
