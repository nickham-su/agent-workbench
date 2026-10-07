import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteSessionQuery } from "./sqlite-session-query.js";

// No message/run/model tables: a metadata read must not touch them.
function fixture() {
  const db = new Database(":memory:");
  db.exec(`create table workspaces(id text primary key);
    create table agent_session(id text primary key, workspace_id text, title text, kind text,
      head_message_id text, context_root_message_id text, revision integer,
      forked_from_session_id text, forked_from_message_id text, created_at integer, updated_at integer);
    insert into workspaces values ('a'), ('b');
    insert into agent_session values ('primary','a','Title','primary',null,null,0,null,null,1,2);
    insert into agent_session values ('subtask','a','Task','subtask',null,null,0,'primary',null,1,2);`);
  return { db, query: new SqliteSessionQuery(db) };
}

test("single-session metadata reads complete primary/subtask records without ancillary tables", () => {
  const { db, query } = fixture();
  try {
    for (const sessionId of ["primary", "subtask"]) {
      const record = query.getSession({ workspaceId: "a", sessionId });
      assert.equal(record.id, sessionId);
      assert.equal(record.workspaceId, "a");
      assert.equal(Object.keys(record).length, 11);
    }
    assert.equal(db.inTransaction, false);
  } finally { db.close(); }
});

test("single-session metadata separates workspace 404 from missing/cross-workspace target", () => {
  const { db, query } = fixture();
  try {
    for (const input of [{ workspaceId: "b", sessionId: "primary" }, { workspaceId: "a", sessionId: "missing" }]) {
      assert.throws(() => query.getSession(input), { statusCode: 404, code: "SESSION_NOT_FOUND" });
    }
    assert.throws(() => query.getSession({ workspaceId: "missing", sessionId: "primary" }), { statusCode: 404, code: "WORKSPACE_NOT_FOUND" });
    assert.equal(db.inTransaction, false);
  } finally { db.close(); }
});
