import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../infra/db/schema.js";
import { createMessageSession, getMessageSession, getMessageRunState } from "../agent/agent-message.store.js";
import {
  findAgentSessionKindInWorkspace, readWorkspaceAgentTabState,
  updateWorkspaceSessionTabState, workspaceExistsForAgentTabState
} from "./workspace-session-tab-state.store.js";

function createDb() {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); initSchema(db);
  for (const id of ["ws-a", "ws-b"]) db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values (?,?,?,?,1,1)")
    .run(id, id, id, `/workspace/${id}`);
  return db;
}
function insertSession(db: Database.Database, id: string, kind: "primary" | "subtask", visibility: "listed" | "unlisted" = "listed", workspaceId = "ws-a") {
  createMessageSession(db, { id, workspaceId, title: id, kind, visibility, createdAt: 1 });
}

test("tab state narrow ownership lookup and exact UPDATE retain each real state row", () => {
  const db = createDb();
  try {
    insertSession(db, "primary", "primary"); insertSession(db, "foreign", "subtask", "listed", "ws-b");
    assert.equal(workspaceExistsForAgentTabState(db, "ws-a"), true);
    assert.equal(workspaceExistsForAgentTabState(db, "missing"), false);
    assert.equal(findAgentSessionKindInWorkspace(db, "ws-a", "primary"), "primary");
    assert.equal(findAgentSessionKindInWorkspace(db, "ws-a", "foreign"), null);
    for (const visible of [false, true, true, false]) updateWorkspaceSessionTabState(db, { workspaceId: "ws-a", sessionId: "primary", visible, updatedAt: 20 });
    assert.deepEqual(db.prepare("select visible,updated_at as updatedAt from workspace_session_tab_state where session_id = 'primary'").get(), { visible: 0, updatedAt: 20 });
    assert.equal((db.prepare("select count(*) n from workspace_session_tab_state").get() as {n:number}).n, 2);
    assert.throws(() => updateWorkspaceSessionTabState(db, { workspaceId: "ws-a", sessionId: "missing", visible: true, updatedAt: 2 }), { code: "AGENT_TAB_STATE_INVALID" });
  } finally { db.close(); }
});

test("all kind/visibility combinations initialize actual state and project only permitted IDs", () => {
  const db = createDb();
  try {
    for (const kind of ["primary", "subtask"] as const) for (const visibility of ["listed", "unlisted"] as const) {
      const id = `${kind}-${visibility}`; insertSession(db, id, kind, visibility);
      assert.deepEqual(db.prepare("select visible from workspace_session_tab_state where session_id = ?").get(id), { visible: Number(kind === "primary" && visibility === "listed") });
      assert.equal(getMessageSession(db, "ws-a", id)?.visibility, visibility);
      assert.equal(getMessageRunState(db, "ws-a", id)?.status, "idle");
    }
    updateWorkspaceSessionTabState(db, { workspaceId: "ws-a", sessionId: "primary-listed", visible: false, updatedAt: 2 });
    updateWorkspaceSessionTabState(db, { workspaceId: "ws-a", sessionId: "subtask-unlisted", visible: true, updatedAt: 2 });
    assert.deepEqual(readWorkspaceAgentTabState(db, "ws-a"), {
      workspaceId: "ws-a", openedSessionIds: ["subtask-unlisted"], closedSessionIds: ["primary-listed"], openedSubtaskSessionIds: ["subtask-unlisted"]
    });
  } finally { db.close(); }
});

test("missing/orphan/cross-workspace state fails presentation without blocking Session or RunState reads", () => {
  const db = createDb();
  try {
    insertSession(db, "primary", "primary");
    db.prepare("delete from workspace_session_tab_state where session_id = 'primary'").run();
    assert.throws(() => readWorkspaceAgentTabState(db, "ws-a"), { code: "AGENT_TAB_STATE_INVALID" });
    assert.throws(() => updateWorkspaceSessionTabState(db, { workspaceId: "ws-a", sessionId: "primary", visible: true, updatedAt: 2 }), { code: "AGENT_TAB_STATE_INVALID" });
    assert.ok(getMessageSession(db, "ws-a", "primary")); assert.ok(getMessageRunState(db, "ws-a", "primary"));
    assert.equal((db.prepare("select count(*) n from workspace_session_tab_state").get() as {n:number}).n, 0);
    db.prepare("insert into workspace_session_tab_state values ('ws-a','primary',1,1),('ws-a','orphan',0,1)").run();
    assert.throws(() => readWorkspaceAgentTabState(db, "ws-a"), { code: "AGENT_TAB_STATE_INVALID" });
    db.prepare("delete from workspace_session_tab_state where session_id = 'orphan'").run();
    db.prepare("insert into workspace_session_tab_state values ('ws-b','primary',0,1)").run();
    assert.throws(() => readWorkspaceAgentTabState(db, "ws-a"), { code: "AGENT_TAB_STATE_INVALID" });
    assert.throws(() => updateWorkspaceSessionTabState(db, { workspaceId: "ws-a", sessionId: "primary", visible: false, updatedAt: 2 }), { code: "AGENT_TAB_STATE_INVALID" });
  } finally { db.close(); }
});

test("Tab or RunState insertion failure rolls back the entire Session creation", () => {
  for (const table of ["workspace_session_tab_state", "session_run_state"]) {
    const db = createDb();
    try {
      db.exec(`create trigger fail_creation before insert on ${table} begin select raise(abort, 'injected'); end`);
      assert.throws(() => insertSession(db, "new-session", "primary"), /injected/);
      for (const target of ["agent_session", "workspace_session_tab_state", "session_run_state"]) {
        assert.deepEqual(db.prepare(`select count(*) n from ${target}`).get(), { n: 0 });
      }
    } finally { db.close(); }
  }
});


test("a deferred commit failure also leaves no partial Session/RunState/Tab state", () => {
  const db = createDb();
  try {
    db.pragma("defer_foreign_keys=ON");
    assert.throws(() => insertSession(db, "deferred", "primary", "listed", "missing"), /FOREIGN KEY/);
    for (const table of ["agent_session", "session_run_state", "workspace_session_tab_state"]) assert.deepEqual(db.prepare(`select count(*) n from ${table}`).get(), { n: 0 });
  } finally { db.close(); }
});
