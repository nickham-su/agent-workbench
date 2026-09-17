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
  createMessageRunRecord(db, { runId: "run", workspaceId: "ws", sessionId: "session-a", triggerMessageId: "one", agentId: "agent", providerId: "provider", modelId: "model", status: "completed", createdAt: 4 });
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
