import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import { createMessageRunRecord } from "../agent-message.store.js";
import { appendMessage, createMessageSession } from "../agent-message.store.js";
import { SqliteSubtaskRunQuery } from "./sqlite-subtask-run-query.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
  return db;
}

function appendTextMessage(params: {
  db: Database.Database;
  id: string;
  sessionId: string;
  previousMessageId: string | null;
  revision: number;
  type: "user" | "system" | "assistant";
  text: string;
  originRunId?: string | null;
  createdAt: number;
}) {
  return appendMessage(params.db, {
    id: params.id,
    workspaceId: "ws",
    sessionId: params.sessionId,
    expectedHeadMessageId: params.previousMessageId,
    expectedRevision: params.revision,
    type: params.type,
    status: "completed",
    originRunId: params.originRunId ?? null,
    parts: [{ id: `${params.id}-part`, position: 0, type: "text", text: params.text }],
    createdAt: params.createdAt,
  });
}

test("SQLite subtask result query prioritizes current-run assistant and isolates session/run sources", () => {
  const db = createDb();
  createMessageSession(db, { id: "child", workspaceId: "ws", title: "child", kind: "subtask", createdAt: 1 });
  createMessageSession(db, { id: "other", workspaceId: "ws", title: "other", kind: "subtask", createdAt: 1 });

  appendTextMessage({ db, id: "system", sessionId: "child", previousMessageId: null, revision: 0, type: "system", text: "child fallback", createdAt: 2 });
  appendTextMessage({ db, id: "trigger", sessionId: "child", previousMessageId: "system", revision: 1, type: "user", text: "child prompt", createdAt: 3 });
  createMessageRunRecord(db, {
    runId: "run-current", workspaceId: "ws", sessionId: "child", triggerMessageId: "trigger",
    agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 4,
  });
  appendTextMessage({ db, id: "answer", sessionId: "child", previousMessageId: "trigger", revision: 2, type: "assistant", text: "current answer", originRunId: "run-current", createdAt: 5 });

  createMessageRunRecord(db, {
    runId: "run-other", workspaceId: "ws", sessionId: "child", triggerMessageId: "trigger",
    agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 6,
  });
  appendTextMessage({ db, id: "other-answer", sessionId: "child", previousMessageId: "answer", revision: 3, type: "assistant", text: "other run answer", originRunId: "run-other", createdAt: 7 });
  appendTextMessage({ db, id: "foreign-user", sessionId: "other", previousMessageId: null, revision: 0, type: "user", text: "other prompt", createdAt: 8 });
  createMessageRunRecord(db, {
    runId: "run-foreign", workspaceId: "ws", sessionId: "other", triggerMessageId: "foreign-user",
    agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 9,
  });
  appendTextMessage({ db, id: "foreign-answer", sessionId: "other", previousMessageId: "foreign-user", revision: 1, type: "assistant", text: "foreign answer", originRunId: "run-foreign", createdAt: 10 });

  const query = new SqliteSubtaskRunQuery(db);
  assert.deepEqual(
    query.listMessageTextsByRun({ workspaceId: "ws", sessionId: "child", runId: "run-current" }),
    [
      { type: "assistant", text: "current answer" },
      { type: "system", text: "child fallback" },
    ],
  );
});

test("SQLite subtask result query falls back only to current child trigger ancestors", () => {
  const db = createDb();
  createMessageSession(db, { id: "child", workspaceId: "ws", title: "child", kind: "subtask", createdAt: 1 });
  createMessageSession(db, { id: "other", workspaceId: "ws", title: "other", kind: "subtask", createdAt: 1 });

  appendTextMessage({ db, id: "system", sessionId: "child", previousMessageId: null, revision: 0, type: "system", text: "fallback only", createdAt: 2 });
  appendTextMessage({ db, id: "trigger", sessionId: "child", previousMessageId: "system", revision: 1, type: "user", text: "prompt", createdAt: 3 });
  createMessageRunRecord(db, {
    runId: "run-current", workspaceId: "ws", sessionId: "child", triggerMessageId: "trigger",
    agentId: "agent", providerId: "provider", modelId: "model", status: "failed", createdAt: 4,
  });
  appendTextMessage({ db, id: "foreign-user", sessionId: "other", previousMessageId: null, revision: 0, type: "user", text: "foreign prompt", createdAt: 5 });
  createMessageRunRecord(db, {
    runId: "run-foreign", workspaceId: "ws", sessionId: "other", triggerMessageId: "foreign-user",
    agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 6,
  });
  appendTextMessage({ db, id: "foreign-answer", sessionId: "other", previousMessageId: "foreign-user", revision: 1, type: "assistant", text: "foreign answer", originRunId: "run-foreign", createdAt: 7 });

  const query = new SqliteSubtaskRunQuery(db);
  assert.deepEqual(
    query.listMessageTextsByRun({ workspaceId: "ws", sessionId: "child", runId: "run-current" }),
    [{ type: "system", text: "fallback only" }],
  );
});
