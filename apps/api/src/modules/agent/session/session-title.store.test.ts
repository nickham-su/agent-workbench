import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import {
  createMessageSession,
  getMessageSessionById,
  setManualMessageSessionTitle,
  updateAutoMessageSessionTitle
} from "../agent-message.store.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run("ws-a", "ws-a-dir", "A", "/workspaces/ws-a", 1, 1);
  return db;
}

type Db = Database.Database;

function insertSession(db: Db, id = "sess-a", workspaceId = "ws-a") {
  createMessageSession(db, { id, workspaceId, title: "初始", kind: "primary", createdAt: 10 });
}

test("updateAutoMessageSessionTitle updates title and updated_at when not manually set", () => {
  const db = createDb();
  insertSession(db);
  const ok = updateAutoMessageSessionTitle(db, { sessionId: "sess-a", title: "自动", updatedAt: 99 });
  assert.equal(ok, true);
  const row = db.prepare("select title as title, updated_at as updatedAt, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number; flag: number };
  assert.equal(row.title, "自动");
  assert.equal(row.updatedAt, 99);
  assert.equal(row.flag, 0);
  db.close();
});

test("updateAutoMessageSessionTitle skips sessions already manually set", () => {
  const db = createDb();
  insertSession(db);
  setManualMessageSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-a", title: "手动" });
  const ok = updateAutoMessageSessionTitle(db, { sessionId: "sess-a", title: "自动", updatedAt: 99 });
  assert.equal(ok, false);
  const row = db.prepare("select title as title, updated_at as updatedAt from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number };
  assert.equal(row.title, "手动");
  assert.equal(row.updatedAt, 10);
  db.close();
});

test("updateAutoMessageSessionTitle returns false for missing session", () => {
  const db = createDb();
  const ok = updateAutoMessageSessionTitle(db, { sessionId: "missing", title: "自动", updatedAt: 99 });
  assert.equal(ok, false);
  db.close();
});

test("setManualMessageSessionTitle atomically writes title and flag without touching updated_at", () => {
  const db = createDb();
  insertSession(db);
  const ok = setManualMessageSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-a", title: "手动" });
  assert.equal(ok, true);
  const row = db.prepare("select title as title, updated_at as updatedAt, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number; flag: number };
  assert.equal(row.title, "手动");
  assert.equal(row.updatedAt, 10);
  assert.equal(row.flag, 1);

  // 再次手动修改：允许，且仍不更新 updated_at
  const okAgain = setManualMessageSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-a", title: "手动2" });
  assert.equal(okAgain, true);
  const again = db.prepare("select title as title, updated_at as updatedAt, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number; flag: number };
  assert.equal(again.title, "手动2");
  assert.equal(again.updatedAt, 10);
  assert.equal(again.flag, 1);
  db.close();
});

test("setManualMessageSessionTitle rejects workspace mismatch", () => {
  const db = createDb();
  insertSession(db);
  const ok = setManualMessageSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-other", title: "手动" });
  assert.equal(ok, false);
  const row = db.prepare("select title as title, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; flag: number };
  assert.equal(row.title, "初始");
  assert.equal(row.flag, 0);
  db.close();
});

test("setManualMessageSessionTitle returns false for missing session", () => {
  const db = createDb();
  const ok = setManualMessageSessionTitle(db, { sessionId: "missing", workspaceId: "ws-a", title: "手动" });
  assert.equal(ok, false);
  db.close();
});

test("createMessageSession always starts with title_manually_set = 0", () => {
  const db = createDb();
  insertSession(db, "sess-b");
  // 即使先手动接管一个 Session，新建 Session 也必须是 0（Fork 语义）
  setManualMessageSessionTitle(db, { sessionId: "sess-b", workspaceId: "ws-a", title: "手动" });
  createMessageSession(db, { id: "sess-c", workspaceId: "ws-a", title: "Fork 目标", kind: "subtask", createdAt: 20, forkedFromSessionId: "sess-b", forkedFromMessageId: null });
  const row = db.prepare("select title_manually_set as flag from agent_session where id = 'sess-c'").get() as { flag: number };
  assert.equal(row.flag, 0);
  const record = getMessageSessionById(db, "sess-c");
  assert.ok(record);
  assert.equal(record.title, "Fork 目标");
  db.close();
});
