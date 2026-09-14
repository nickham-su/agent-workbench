import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import {
  createAgentSession,
  getAgentSession,
  setManualAgentSessionTitle,
  updateAutoAgentSessionTitle
} from "../agent.store.js";

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
  createAgentSession(db, { id, workspaceId, title: "初始", kind: "primary", createdAt: 10 });
}

test("updateAutoAgentSessionTitle updates title and updated_at when not manually set", () => {
  const db = createDb();
  insertSession(db);
  const ok = updateAutoAgentSessionTitle(db, { sessionId: "sess-a", title: "自动", updatedAt: 99 });
  assert.equal(ok, true);
  const row = db.prepare("select title as title, updated_at as updatedAt, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number; flag: number };
  assert.equal(row.title, "自动");
  assert.equal(row.updatedAt, 99);
  assert.equal(row.flag, 0);
  db.close();
});

test("updateAutoAgentSessionTitle skips sessions already manually set", () => {
  const db = createDb();
  insertSession(db);
  setManualAgentSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-a", title: "手动" });
  const ok = updateAutoAgentSessionTitle(db, { sessionId: "sess-a", title: "自动", updatedAt: 99 });
  assert.equal(ok, false);
  const row = db.prepare("select title as title, updated_at as updatedAt from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number };
  assert.equal(row.title, "手动");
  assert.equal(row.updatedAt, 10);
  db.close();
});

test("updateAutoAgentSessionTitle returns false for missing session", () => {
  const db = createDb();
  const ok = updateAutoAgentSessionTitle(db, { sessionId: "missing", title: "自动", updatedAt: 99 });
  assert.equal(ok, false);
  db.close();
});

test("setManualAgentSessionTitle atomically writes title and flag without touching updated_at", () => {
  const db = createDb();
  insertSession(db);
  const ok = setManualAgentSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-a", title: "手动" });
  assert.equal(ok, true);
  const row = db.prepare("select title as title, updated_at as updatedAt, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number; flag: number };
  assert.equal(row.title, "手动");
  assert.equal(row.updatedAt, 10);
  assert.equal(row.flag, 1);

  // 再次手动修改：允许，且仍不更新 updated_at
  const okAgain = setManualAgentSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-a", title: "手动2" });
  assert.equal(okAgain, true);
  const again = db.prepare("select title as title, updated_at as updatedAt, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; updatedAt: number; flag: number };
  assert.equal(again.title, "手动2");
  assert.equal(again.updatedAt, 10);
  assert.equal(again.flag, 1);
  db.close();
});

test("setManualAgentSessionTitle rejects workspace mismatch", () => {
  const db = createDb();
  insertSession(db);
  const ok = setManualAgentSessionTitle(db, { sessionId: "sess-a", workspaceId: "ws-other", title: "手动" });
  assert.equal(ok, false);
  const row = db.prepare("select title as title, title_manually_set as flag from agent_session where id = 'sess-a'").get() as { title: string; flag: number };
  assert.equal(row.title, "初始");
  assert.equal(row.flag, 0);
  db.close();
});

test("setManualAgentSessionTitle returns false for missing session", () => {
  const db = createDb();
  const ok = setManualAgentSessionTitle(db, { sessionId: "missing", workspaceId: "ws-a", title: "手动" });
  assert.equal(ok, false);
  db.close();
});

test("createAgentSession always starts with title_manually_set = 0", () => {
  const db = createDb();
  insertSession(db, "sess-b");
  // 即使先手动接管一个 Session，新建 Session 也必须是 0（Fork 语义）
  setManualAgentSessionTitle(db, { sessionId: "sess-b", workspaceId: "ws-a", title: "手动" });
  createAgentSession(db, { id: "sess-c", workspaceId: "ws-a", title: "Fork 目标", kind: "subtask", createdAt: 20, forkedFromSessionId: "sess-b", forkedFromItemId: 1 });
  const row = db.prepare("select title_manually_set as flag from agent_session where id = 'sess-c'").get() as { flag: number };
  assert.equal(row.flag, 0);
  const record = getAgentSession(db, "sess-c");
  assert.ok(record);
  assert.equal(record.title, "Fork 目标");
  db.close();
});
