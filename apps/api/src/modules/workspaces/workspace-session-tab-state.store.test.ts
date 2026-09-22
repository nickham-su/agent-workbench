import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../infra/db/schema.js";
import {
  deleteWorkspaceSessionTabStateOverride,
  findAgentSessionKindInWorkspace,
  listEffectiveWorkspaceSessionTabStateOverrides,
  upsertWorkspaceSessionTabStateOverride,
  workspaceExistsForAgentTabState
} from "./workspace-session-tab-state.store.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run("ws-a", "ws-a", "Workspace A", "/workspace/a", 1, 1);
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run("ws-b", "ws-b", "Workspace B", "/workspace/b", 1, 1);
  return db;
}

function insertSession(db: Database.Database, id: string, workspaceId: string, kind: "primary" | "subtask") {
  db.prepare("insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, id, kind, 1, 1);
}

test("tab state store uses narrow Workspace and Session ownership lookups", () => {
  const db = createDb();
  insertSession(db, "primary-a", "ws-a", "primary");
  insertSession(db, "subtask-b", "ws-b", "subtask");

  assert.equal(workspaceExistsForAgentTabState(db, "ws-a"), true);
  assert.equal(workspaceExistsForAgentTabState(db, "missing"), false);
  assert.equal(findAgentSessionKindInWorkspace(db, "ws-a", "primary-a"), "primary");
  assert.equal(findAgentSessionKindInWorkspace(db, "ws-a", "subtask-b"), null);
  assert.equal(findAgentSessionKindInWorkspace(db, "ws-a", "missing"), null);
  db.close();
});

test("tab state store reads only effective same-Workspace overrides", () => {
  const db = createDb();
  insertSession(db, "primary-closed", "ws-a", "primary");
  insertSession(db, "primary-default", "ws-a", "primary");
  insertSession(db, "subtask-open", "ws-a", "subtask");
  insertSession(db, "subtask-default", "ws-a", "subtask");
  insertSession(db, "foreign-session", "ws-b", "primary");

  upsertWorkspaceSessionTabStateOverride(db, { workspaceId: "ws-a", sessionId: "primary-closed", visible: false, updatedAt: 1 });
  upsertWorkspaceSessionTabStateOverride(db, { workspaceId: "ws-a", sessionId: "primary-default", visible: true, updatedAt: 2 });
  upsertWorkspaceSessionTabStateOverride(db, { workspaceId: "ws-a", sessionId: "subtask-open", visible: true, updatedAt: 3 });
  upsertWorkspaceSessionTabStateOverride(db, { workspaceId: "ws-a", sessionId: "subtask-default", visible: false, updatedAt: 4 });
  upsertWorkspaceSessionTabStateOverride(db, { workspaceId: "ws-a", sessionId: "orphan-session", visible: false, updatedAt: 5 });
  upsertWorkspaceSessionTabStateOverride(db, { workspaceId: "ws-a", sessionId: "foreign-session", visible: false, updatedAt: 6 });

  assert.deepEqual(listEffectiveWorkspaceSessionTabStateOverrides(db, "ws-a"), [
    { sessionId: "primary-closed", visible: false, kind: "primary" },
    { sessionId: "subtask-open", visible: true, kind: "subtask" }
  ]);
  db.close();
});

test("tab state store upserts and deletes exact parameterized identities", () => {
  const db = createDb();
  const sessionId = "session-'quoted-?";
  const workspaceId = "ws-'quoted-?";
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run(workspaceId, "quoted", "Quoted", "/workspace/quoted", 1, 1);

  upsertWorkspaceSessionTabStateOverride(db, { workspaceId, sessionId, visible: false, updatedAt: 10 });
  upsertWorkspaceSessionTabStateOverride(db, { workspaceId, sessionId, visible: true, updatedAt: 20 });
  assert.deepEqual(
    db.prepare("select visible, updated_at as updatedAt from workspace_session_tab_state where workspace_id = ? and session_id = ?").get(workspaceId, sessionId),
    { visible: 1, updatedAt: 20 }
  );
  deleteWorkspaceSessionTabStateOverride(db, workspaceId, sessionId);
  assert.equal((db.prepare("select count(*) as count from workspace_session_tab_state where workspace_id = ? and session_id = ?").get(workspaceId, sessionId) as { count: number }).count, 0);
  db.close();
});
