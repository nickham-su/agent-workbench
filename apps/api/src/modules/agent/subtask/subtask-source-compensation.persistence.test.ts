import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { test, type TestContext } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendMessage, createMessageRunRecord, createMessageSession, forkStableSourceSession,
  getMessageSession, getMessageRunState,
} from "../agent-message.store.js";
import { SqliteSubtaskMaintenancePersistence } from "./sqlite-subtask-maintenance-persistence.js";

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  t.after(() => db.close());
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','ws',?,1,1)")
    .run(path.resolve(".tmp-tests", "compensation"));
  for (const id of ["parent", "source"]) {
    createMessageSession(db, { id, workspaceId: "ws", title: id, kind: "primary", createdAt: 1 });
  }
  appendMessage(db, { id: "shared", workspaceId: "ws", sessionId: "source", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [{ id: "shared-text", position: 0, type: "text", text: "shared history" }], createdAt: 2 });
  const session = forkStableSourceSession(db, { id: "child", workspaceId: "ws", sourceSessionId: "source", title: "child", createdAt: 3 });
  const input = { workspaceId: "ws", createdSessionId: session.id, expectedParentSessionId: "parent",
    expectedForkedFromSessionId: session.forkedFromSessionId, expectedForkedFromMessageId: session.forkedFromMessageId,
    expectedHeadMessageId: session.headMessageId, expectedContextRootMessageId: session.contextRootMessageId };
  return { db, session, input, maintenance: new SqliteSubtaskMaintenancePersistence(db) };
}

function run(db: Database.Database, sessionId = "child", id = "run") {
  createMessageRunRecord(db, { runId: id, workspaceId: "ws", sessionId, triggerMessageId: "shared",
    agentId: "default", providerId: "provider", modelId: "model", subtaskDepth: 1, status: "running", createdAt: 4 });
}

function assertSharedGraph(db: Database.Database) {
  assert.ok(getMessageSession(db, "ws", "source"));
  assert.equal((db.prepare("select text from agent_message_part where id = 'shared-text'").get() as { text: string }).text, "shared history");
  assert.equal((db.prepare("select count(*) as count from agent_message where id = 'shared'").get() as { count: number }).count, 1);
}

test("source!=caller compensation removes only a request-owned empty shell and its run state", (t) => {
  const { db, input, maintenance } = fixture(t);
  assert.equal(maintenance.deleteCreatedSessionIfStillSafe(input), true);
  assert.equal(getMessageSession(db, "ws", "child"), null);
  assert.equal(getMessageRunState(db, "ws", "child"), null);
  assertSharedGraph(db);
  assert.ok(getMessageSession(db, "ws", "parent"));
});

for (const change of [
  { workspaceId: "other" }, { createdSessionId: "source" }, { expectedParentSessionId: "missing" },
  { expectedForkedFromSessionId: "parent" }, { expectedForkedFromMessageId: "other-message" },
  { expectedHeadMessageId: null }, { expectedContextRootMessageId: null },
]) {
  test(`compensation preserves shell when captured identity differs (${Object.keys(change)[0]})`, (t) => {
    const { db, input, maintenance } = fixture(t);
    assert.equal(maintenance.deleteCreatedSessionIfStillSafe({ ...input, ...change }), false);
    assert.ok(getMessageSession(db, "ws", "child"));
    assertSharedGraph(db);
  });
}

for (const protection of ["revision", "root", "kind", "running", "active-run", "active-assistant", "pending-message", "pending-tool",
  "run", "own-message", "own-tool", "client-request", "override", "descendant"] as const) {
  test(`compensation preserves an already changed or owned target (${protection})`, (t) => {
    const { db, input, maintenance } = fixture(t);
    if (protection === "revision") db.prepare("update agent_session set revision = 1 where id = 'child'").run();
    if (protection === "root") db.prepare("update agent_session set context_root_message_id = null where id = 'child'").run();
    if (protection === "kind") db.prepare("update agent_session set kind = 'primary' where id = 'child'").run();
    if (protection === "running") db.prepare("update session_run_state set status = 'running' where session_id = 'child'").run();
    if (protection === "active-run") {
      run(db, "source");
      db.prepare("update session_run_state set active_run_id = 'run' where session_id = 'child'").run();
    }
    if (protection === "active-assistant") {
      const source = getMessageSession(db, "ws", "source")!;
      appendMessage(db, { id: "source-assistant", workspaceId: "ws", sessionId: "source", expectedHeadMessageId: source.headMessageId,
        expectedRevision: source.revision, type: "assistant", status: "completed",
        parts: [{ id: "assistant-text", position: 0, type: "text", text: "source assistant" }], createdAt: 4 });
      db.prepare("update session_run_state set active_assistant_message_id = 'source-assistant' where session_id = 'child'").run();
    }
    if (protection === "pending-message") db.prepare(`update session_run_state set non_terminal_message_ids_json = '["shared"]' where session_id = 'child'`).run();
    if (protection === "pending-tool") db.prepare(`update session_run_state set non_terminal_tool_execution_ids_json = '["execution"]' where session_id = 'child'`).run();
    if (protection === "run") run(db);
    if (protection === "own-message") {
      appendMessage(db, { id: "own", workspaceId: "ws", sessionId: "child", expectedHeadMessageId: "shared", expectedRevision: 0,
        type: "user", status: "completed", parts: [{ id: "own-text", position: 0, type: "text", text: "own work" }], createdAt: 4 });
    }
    if (protection === "own-tool") {
      const source = getMessageSession(db, "ws", "source")!;
      appendMessage(db, { id: "source-tool", workspaceId: "ws", sessionId: "source", expectedHeadMessageId: source.headMessageId,
        expectedRevision: source.revision, type: "assistant", status: "completed",
        parts: [{ id: "source-call", position: 0, type: "tool_call", toolName: "bash", input: { command: "test" }, providerToolCallId: null }], createdAt: 4 });
      db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,updated_revision,created_at,updated_at)
        values ('execution','source-call','child',null,'queued',0,4,4)`).run();
    }
    if (protection === "client-request") {
      run(db, "source");
      db.prepare("insert into agent_client_request (workspace_id,session_id,client_request_id,message_id,run_id,created_at) values ('ws','child','request','shared','run',4)").run();
    }
    if (protection === "override") {
      db.prepare("insert into agent_session_agent_model_override (session_id,agent_id,provider_id,model_id,updated_at) values ('child','default','provider','model',4)").run();
    }
    if (protection === "descendant") {
      createMessageSession(db, { id: "descendant", workspaceId: "ws", title: "descendant", kind: "subtask",
        forkedFromSessionId: "child", forkedFromMessageId: "shared", createdAt: 4 });
    }
    assert.equal(maintenance.deleteCreatedSessionIfStillSafe(input), false);
    assert.ok(getMessageSession(db, "ws", "child"));
    assertSharedGraph(db);
  });
}
