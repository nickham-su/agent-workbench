import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { initSchema } from "../../../infra/db/schema.js";
import { createMessageSession } from "../agent-message.store.js";
import { SqliteRunLifecyclePersistence } from "./sqlite-run-lifecycle-persistence.js";

function fixture(t: TestContext, visibility: "listed" | "unlisted") {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.pragma("foreign_keys=ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','ws','ws',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", kind: "primary", visibility, title: "Scheduled task", createdAt: 1 });
  const persistence = new SqliteRunLifecyclePersistence(db);
  const input = { workspaceId: "ws", sessionId: "session", clientRequestId: "scheduled-execution:test", text: "work",
    images: [], runId: "run", agentId: "agent", providerId: "provider", modelId: "model", uiLocale: null, createdAt: 2,
    expectedSessionTitle: "Scheduled task", expectedSessionVisibility: visibility } as const;
  const snapshot = () => ["agent_session", "session_run_state", "workspace_session_tab_state", "agent_message", "agent_message_part", "agent_run", "agent_client_request"]
    .map((table) => db.prepare(`select * from ${table} order by rowid`).all());
  return { db, persistence, input: { ...input, images: [] }, snapshot };
}

for (const visibility of ["listed", "unlisted"] as const) {
  test(`scheduled ${visibility} activation rejects opposite visibility without any DB or image publication side effect`, (t) => {
    const f = fixture(t, visibility);
    const before = f.snapshot();
    let published = 0;
    assert.throws(() => f.persistence.activateUserRun({ ...f.input, expectedSessionVisibility: visibility === "listed" ? "unlisted" : "listed" }, () => published++),
      { statusCode: 409, code: "SESSION_ID_CONFLICT" });
    assert.equal(published, 0);
    assert.deepEqual(f.snapshot(), before);
  });

  test(`accepted ${visibility} activation replay validates stable identity but ignores changed pristine state and Tab`, (t) => {
    const f = fixture(t, visibility);
    assert.equal(f.persistence.activateUserRun(f.input).kind, "activated");
    f.db.prepare("update agent_session set title='User changed title',revision=revision+1 where id='session'").run();
    f.db.prepare("update workspace_session_tab_state set visible=?,updated_at=42 where session_id='session'").run(visibility === "listed" ? 0 : 1);
    const before = f.snapshot();
    assert.deepEqual(f.persistence.activateUserRun({ ...f.input, runId: "never-created", expectedSessionTitle: "old pristine title" }),
      { kind: "deduplicated", messageId: "message-run", runId: "run" });
    assert.deepEqual(f.snapshot(), before);
    assert.throws(() => f.persistence.activateUserRun({ ...f.input, runId: "also-never-created", expectedSessionVisibility: visibility === "listed" ? "unlisted" : "listed" }),
      { statusCode: 409, code: "SESSION_ID_CONFLICT" });
    assert.deepEqual(f.snapshot(), before);
  });
}

test("accepted scheduled replay rejects a corrupt request-to-Run trigger link before its dedup return", (t) => {
  const f = fixture(t, "unlisted");
  f.persistence.activateUserRun(f.input);
  f.db.prepare("update agent_run set trigger_message_id=null where run_id='run'").run();
  const before = f.snapshot();
  assert.throws(() => f.persistence.activateUserRun({ ...f.input, runId: "never-created" }), { code: "SESSION_ID_CONFLICT" });
  assert.deepEqual(f.snapshot(), before);
});
