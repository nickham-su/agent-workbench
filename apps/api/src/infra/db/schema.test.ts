import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "./schema.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function insertWorkspace(db: Database.Database, id = "ws-a") {
  db.prepare(
    "insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
  ).run(id, `${id}-dir`, "Workspace", `/workspaces/${id}`, 1, 1);
}

function insertContextItem(db: Database.Database, params: { workspaceId?: string; sessionId?: string; id?: number } = {}) {
  const workspaceId = params.workspaceId ?? "ws-a";
  const sessionId = params.sessionId ?? "sess-a";
  db.prepare(
    "insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
  ).run(sessionId, workspaceId, "Session", "primary", 1, 1);
  const result = db.prepare(
    "insert into agent_context_item (workspace_id, session_id, kind, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
  ).run(workspaceId, sessionId, "user", "completed", 1, 1);
  return params.id ?? Number(result.lastInsertRowid);
}

function insertAttachment(db: Database.Database, input: Partial<{
  id: string;
  workspaceId: string;
  storageKey: string;
  filename: string;
  mediaType: string;
  byteSize: number;
}> = {}) {
  db.prepare(
    "insert into agent_attachment (id, workspace_id, storage_key, filename, media_type, byte_size, created_at) values (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    input.id ?? "att-a",
    input.workspaceId ?? "ws-a",
    input.storageKey ?? "att-a",
    input.filename ?? "image.png",
    input.mediaType ?? "image/png",
    input.byteSize ?? 1,
    1
  );
}

test("agent attachment tables preserve the documented constraints and indexes", () => {
  const db = createDb();

  const tables = db.prepare("select name from sqlite_master where type = 'table' and name like 'agent_%attachment%' order by name").all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), ["agent_attachment", "agent_context_item_attachment"]);
  const indexes = db.prepare("select name from sqlite_master where type = 'index' and name in (?, ?) order by name").all(
    "idx_agent_attachment_workspace_created",
    "idx_agent_context_item_attachment_attachment"
  ) as Array<{ name: string }>;
  assert.deepEqual(indexes.map((row) => row.name), [
    "idx_agent_attachment_workspace_created",
    "idx_agent_context_item_attachment_attachment"
  ]);

  const attachmentForeignKeys = db.prepare("pragma foreign_key_list(agent_attachment)").all() as Array<{ table: string; on_delete: string }>;
  assert.deepEqual(attachmentForeignKeys.map((row) => [row.table, row.on_delete]), [["workspaces", "RESTRICT"]]);
  const relationForeignKeys = db.prepare("pragma foreign_key_list(agent_context_item_attachment)").all() as Array<{ table: string; on_delete: string }>;
  assert.deepEqual(relationForeignKeys.map((row) => [row.table, row.on_delete]).sort(), [
    ["agent_attachment", "RESTRICT"],
    ["agent_context_item", "CASCADE"]
  ]);

  db.close();
});

test("agent attachment schema accepts valid relations and enforces metadata constraints", () => {
  const db = createDb();
  insertWorkspace(db);
  const contextItemId = insertContextItem(db);
  insertAttachment(db);
  db.prepare("insert into agent_context_item_attachment (context_item_id, attachment_id, position) values (?, ?, ?)").run(
    contextItemId,
    "att-a",
    0
  );

  assert.equal((db.prepare("select count(*) as count from agent_context_item_attachment").get() as { count: number }).count, 1);
  assert.throws(() => insertAttachment(db, { id: "att-svg", storageKey: "att-svg", mediaType: "image/svg+xml" }), /CHECK constraint failed/);
  assert.throws(() => insertAttachment(db, { id: "att-empty", storageKey: "att-empty", byteSize: 0 }), /CHECK constraint failed/);
  assert.throws(() => insertAttachment(db, { id: "att-large", storageKey: "att-large", byteSize: 10 * 1024 * 1024 + 1 }), /CHECK constraint failed/);
  assert.throws(() => insertAttachment(db, { id: "att-no-name", storageKey: "att-no-name", filename: "" }), /CHECK constraint failed/);
  assert.throws(() => insertAttachment(db, { id: "att-long-name", storageKey: "att-long-name", filename: "a".repeat(256) }), /CHECK constraint failed/);
  assert.throws(() => insertAttachment(db, { id: "att-duplicate-key", storageKey: "att-a" }), /UNIQUE constraint failed/);

  db.close();
});

test("agent attachment relations enforce position uniqueness and foreign key delete behavior", () => {
  const db = createDb();
  insertWorkspace(db);
  const firstContextItemId = insertContextItem(db);
  insertAttachment(db, { id: "att-a", storageKey: "att-a" });
  insertAttachment(db, { id: "att-b", storageKey: "att-b" });
  db.prepare("insert into agent_context_item_attachment (context_item_id, attachment_id, position) values (?, ?, ?)").run(
    firstContextItemId,
    "att-a",
    0
  );

  assert.throws(
    () => db.prepare("insert into agent_context_item_attachment (context_item_id, attachment_id, position) values (?, ?, ?)").run(firstContextItemId, "att-b", 0),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => db.prepare("insert into agent_context_item_attachment (context_item_id, attachment_id, position) values (?, ?, ?)").run(firstContextItemId, "att-b", 4),
    /CHECK constraint failed/
  );
  assert.throws(() => db.prepare("delete from agent_attachment where id = ?").run("att-a"), /FOREIGN KEY constraint failed/);

  db.prepare("delete from agent_context_item where id = ?").run(firstContextItemId);
  assert.equal((db.prepare("select count(*) as count from agent_context_item_attachment where attachment_id = ?").get("att-a") as { count: number }).count, 0);
  assert.doesNotThrow(() => db.prepare("delete from agent_attachment where id = ?").run("att-a"));

  db.close();
});
