import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "./schema.js";
import { deleteWorkspaceAgentData } from "./workspace-agent-data-cleanup.js";
import { appendMessage, createMessageSession } from "../../modules/agent/agent-message.store.js";
import { createMessageRunRecord } from "../../modules/agent/agent-message.store.js";

test("workspace agent cleanup removes shared graph, FTS/map, runs and attachments in one FK-safe transaction", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
  createMessageSession(db, { id: "session-a", workspaceId: "ws", title: "A", kind: "primary", createdAt: 1 });
  appendMessage(db, { id: "one", workspaceId: "ws", sessionId: "session-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "one-text", position: 0, type: "text", text: "archive cleanup test" }], createdAt: 2 });
  createMessageSession(db, { id: "session-b", workspaceId: "ws", title: "B", kind: "primary", headMessageId: "one", contextRootMessageId: "one", createdAt: 3 });
  createMessageRunRecord(db, { runId: "run", workspaceId: "ws", sessionId: "session-a", triggerMessageId: "one", agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 4 });
  db.prepare("insert into agent_attachment (id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values ('attachment','ws','attachment','a.png','image/png',1,5)").run();
  db.transaction(() => {
    deleteWorkspaceAgentData(db, "ws");
    db.prepare("delete from workspaces where id = ?").run("ws");
  })();
  for (const table of ["agent_archived_text_fts", "agent_text_part_fts_map", "agent_run", "agent_session", "agent_message", "agent_message_part", "agent_attachment"]) {
    assert.equal((db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count, 0, table);
  }
  assert.equal((db.prepare("select count(*) as count from workspaces").get() as { count: number }).count, 0);
  db.close();
});

test("workspace agent cleanup 按 retained、previous 与 replaces 混合图逆拓扑删除且不影响其他 Workspace", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  for (const id of ["ws-a", "ws-b"]) {
    db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values (?,?,? ,?,1,1)")
      .run(id, id, id, `/${id}`);
    createMessageSession(db, { id: `session-${id}`, workspaceId: id, title: id, kind: "primary", createdAt: 1 });
  }
  appendMessage(db, { id: "root", workspaceId: "ws-a", sessionId: "session-ws-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendMessage(db, { id: "replaced", workspaceId: "ws-a", sessionId: "session-ws-a", expectedHeadMessageId: "root", expectedRevision: 1, type: "assistant", status: "completed", parts: [], createdAt: 3 });
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('replacement','ws-a','root','replaced',null,1,'assistant','completed','session-ws-a',null,3,4,4)`).run();
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('compaction','ws-a','replacement',null,'root',2,'compaction','completed','session-ws-a',null,4,5,5)`).run();
  appendMessage(db, { id: "other", workspaceId: "ws-b", sessionId: "session-ws-b", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });

  db.transaction(() => deleteWorkspaceAgentData(db, "ws-a"))();

  assert.equal((db.prepare("select count(*) as count from agent_message where workspace_id='ws-a'").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_message where workspace_id='ws-b'").get() as { count: number }).count, 1);
  assert.ok(db.prepare("select 1 from agent_message where id='other'").get());
  db.close();
});

test("workspace cleanup 先删除 ToolExecution，并解除 Run trigger 与 Session head/root 引用", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/ws',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  createMessageRunRecord(db, { runId: "run", workspaceId: "ws", sessionId: "session", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 1 });
  appendMessage(db, { id: "message", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0, type: "assistant", status: "completed", originRunId: "run", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: {} }], createdAt: 2 });
  db.prepare("update agent_run set trigger_message_id='message' where run_id='run'").run();
  db.prepare("insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at) values ('execution','call','session','run','completed',0,1,2,2)").run();

  db.transaction(() => deleteWorkspaceAgentData(db, "ws"))();

  for (const table of ["agent_tool_execution", "agent_message_part", "agent_run", "agent_session", "agent_message"]) {
    assert.equal((db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count, 0, table);
  }
  db.close();
});

test("workspace cleanup 不会通过 UPDATE 改写三条 Message 图边", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/ws',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  appendMessage(db, { id: "a", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('c','ws','a',null,'a',1,'compaction','completed','session',null,2,3,3)`).run();
  db.exec(`create trigger forbid_message_edge_update before update of previous_message_id, replaces_message_id, retained_from_message_id on agent_message
    begin select raise(abort, 'message edges must not be updated'); end;`);

  assert.doesNotThrow(() => db.transaction(() => deleteWorkspaceAgentData(db, "ws"))());
  db.close();
});

test("workspace cleanup 失败时由外层事务回滚此前删除", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/ws',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  appendMessage(db, { id: "message", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "text", position: 0, type: "text", text: "keep" }], createdAt: 2 });
  db.prepare("insert into agent_attachment (id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values ('attachment','ws','attachment','a.png','image/png',1,2)").run();
  db.exec(`create trigger fail_message_delete before delete on agent_message begin select raise(abort, 'injected cleanup failure'); end;`);

  assert.throws(() => db.transaction(() => deleteWorkspaceAgentData(db, "ws"))(), /injected cleanup failure/);
  for (const table of ["agent_message", "agent_message_part", "agent_attachment"]) {
    assert.equal((db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count, 1, table);
  }
  db.close();
});

test("workspace agent cleanup 在 Message 图成环时 fail-closed", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/ws',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  appendMessage(db, { id: "a", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendMessage(db, { id: "b", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "a", expectedRevision: 1, type: "assistant", status: "completed", parts: [], createdAt: 3 });
  db.prepare("update agent_message set replaces_message_id='b' where id='a'").run();

  assert.throws(() => deleteWorkspaceAgentData(db, "ws"), /agent message graph contains a cycle/);
  assert.equal((db.prepare("select count(*) as count from agent_message where workspace_id='ws'").get() as { count: number }).count, 2);
  db.close();
});
