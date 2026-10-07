import assert from "node:assert/strict";
import test from "node:test";
import { createSessionActivityFixture } from "./test-fixtures/session-activity.fixture.js";

test("activity fixture only contains workspace/session/run-state/message metadata", (t) => {
  const { db, insertSession, insertMessage } = createSessionActivityFixture();
  t.after(() => db.close());
  assert.deepEqual(db.prepare("select name from sqlite_master where type = 'table' order by name").all(), [
    { name: "agent_message" }, { name: "agent_session" }, { name: "session_run_state" }, { name: "workspaces" }
  ]);
  insertSession({ id: "primary" });
  insertSession({ id: "fork", kind: "subtask", forkedFromSessionId: "primary", status: "running" });
  insertMessage({ id: "user", originSessionId: "primary", type: "user" });
  insertMessage({ id: "assistant", originSessionId: "fork", type: "assistant", status: "failed" });
  assert.deepEqual(db.prepare("select session_id, status from session_run_state order by session_id").all(), [
    { session_id: "fork", status: "running" }, { session_id: "primary", status: "idle" }
  ]);
  assert.deepEqual(db.prepare("select id, origin_session_id, status from agent_message order by id").all(), [
    { id: "assistant", origin_session_id: "fork", status: "failed" },
    { id: "user", origin_session_id: "primary", status: "completed" }
  ]);
});

test("activity fixture can represent missing and corrupt state without changing legacy fixtures", (t) => {
  const { db, insertSession } = createSessionActivityFixture();
  t.after(() => db.close());
  insertSession({ id: "missing-state", status: null });
  insertSession({ id: "corrupt-state", status: "broken" });
  assert.deepEqual(db.prepare("select session_id, status from session_run_state").all(), [
    { session_id: "corrupt-state", status: "broken" }
  ]);
});
