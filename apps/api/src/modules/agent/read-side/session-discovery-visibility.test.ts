import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema } from "../../../infra/db/schema.js";
import { createMessageSession, getMessageSession, listMessageSessions, listRecentMessageSessionsAcrossWorkspaces,
  createMessageRunRecord, startMessageRun } from "../agent-message.store.js";
import { SqliteRunLifecyclePersistence } from "../lifecycle/sqlite-run-lifecycle-persistence.js";
import { createSessionListFixture } from "./session-list-query.testkit.js";
import { createSessionActivityFixture } from "./test-fixtures/session-activity.fixture.js";
import { SqliteSessionActivityQuery } from "./sqlite-session-activity-query.js";

test("continuable excludes hidden before limit+1/cursor, including explicitly opened hidden Sessions", (t) => {
  const f = createSessionListFixture();
  t.after(() => f.db.close());
  for (let i = 0; i < 105; i++) {
    f.add(`hidden-${i}`, { visibility: "unlisted", time: 300 - i });
    f.add(`listed-${String(i).padStart(3, "0")}`, { time: 200 - i });
  }
  f.db.prepare("update workspace_session_tab_state set visible=1 where session_id like 'hidden-%'").run();
  for (const limit of [1, 50, 100]) {
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = f.query.listSessions({ workspaceId: "a", scope: "continuable", limit, cursor });
      assert.equal(page.scope, "continuable");
      if (page.scope !== "continuable") throw new Error("unexpected scope");
      assert.equal(page.items.length, Math.min(limit, 105 - ids.length));
      assert.ok(page.items.every((session) => session.visibility === "listed"));
      ids.push(...page.items.map((session) => session.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, Array.from({ length: 105 }, (_, i) => `listed-${String(i).padStart(3, "0")}`));
  }
  const tabs = f.query.listSessions({ workspaceId: "a", scope: "tabs" });
  if (tabs.scope !== "tabs") throw new Error("unexpected scope");
  assert.equal(tabs.items.length, 210);
  assert.deepEqual(tabs.items.map((item) => item.id).sort(), tabs.tabState.openedSessionIds);
  assert.equal(f.query.getSession({ workspaceId: "a", sessionId: "hidden-0" }).visibility, "unlisted");
  assert.throws(() => f.query.getSession({ workspaceId: "b", sessionId: "hidden-0" }), { code: "SESSION_NOT_FOUND" });
});

test("activity candidate/aggregate/total excludes hidden across every kind/status without hiding corrupt listed candidates", (t) => {
  const f = createSessionActivityFixture();
  t.after(() => f.db.close());
  for (const kind of ["primary", "subtask"] as const) {
    for (const status of ["idle", "running"] as const) {
      for (const visibility of ["listed", "unlisted"] as const) {
        const id = `${visibility}-${kind}-${status}`;
        f.insertSession({ id, kind, status, visibility, updatedAt: 100_000 });
        f.insertMessage({ id: `${id}-user`, originSessionId: id, type: "user" });
        f.insertMessage({ id: `${id}-assistant`, originSessionId: id, type: "assistant" });
      }
    }
  }
  // A hidden candidate with missing RunState is not discoverable, but listed
  // candidates retain the existing corruption failure, even for another status.
  f.insertSession({ id: "hidden-no-state", visibility: "unlisted", status: null, updatedAt: 100_000 });
  const query = new SqliteSessionActivityQuery(f.db, () => 100_000);
  for (const kind of ["primary", "subtask", "all"] as const) {
    for (const status of ["idle", "running", "all"] as const) {
      const result = query.querySessions({ workspaceId: "a", updatedWithinSeconds: 10, kind, status });
      assert.equal(result.total, (kind === "all" ? 2 : 1) * (status === "all" ? 2 : 1));
      assert.ok(result.items.every((item) => item.id.startsWith("listed-") && item.userMessageCount === 1 && item.completedAssistantMessageCount === 1));
    }
  }
  f.insertSession({ id: "listed-no-state", status: null, updatedAt: 100_000 });
  assert.throws(() => query.querySessions({ workspaceId: "a", updatedWithinSeconds: 10, kind: "all", status: "running" }),
    { code: "AGENT_SESSION_QUERY_STATE_INVALID" });
});

test("legacy discovery and recent filter before limit across Workspaces; directed reads and recovery still include hidden", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.pragma("foreign_keys=ON");
  initSchema(db);
  for (const id of ["one", "two"]) db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values (?,?,?,?,1,1)").run(id, id, id, id);
  for (const workspaceId of ["one", "two"]) {
    for (const kind of ["primary", "subtask"] as const) {
      for (const visibility of ["listed", "unlisted"] as const) {
        const id = `${workspaceId}-${kind}-${visibility}`;
        createMessageSession(db, { id, workspaceId, title: id, kind, visibility, createdAt: visibility === "unlisted" ? 100 : 1 });
      }
    }
  }
  for (const kind of ["primary", "subtask", "all"] as const) {
    const recent = listRecentMessageSessionsAcrossWorkspaces(db, 2, kind);
    assert.equal(recent.length, 2);
    assert.ok(recent.every((item) => item.sessionId.endsWith("-listed")));
    assert.ok(recent.every((item) => kind === "all" || item.sessionId.includes(kind)));
  }
  assert.ok(listMessageSessions(db, "one").every((item) => item.visibility === "listed"));
  const hidden = "one-primary-unlisted";
  assert.equal(getMessageSession(db, "one", hidden)?.visibility, "unlisted");
  createMessageRunRecord(db, { workspaceId: "one", sessionId: hidden, runId: "hidden-run", triggerMessageId: null,
    agentId: "agent", providerId: "provider", modelId: "model", subtaskDepth: 0, status: "running", createdAt: 101 });
  startMessageRun(db, { workspaceId: "one", sessionId: hidden, runId: "hidden-run", updatedAt: 101 });
  assert.ok(new SqliteRunLifecyclePersistence(db).listRecoverableRunCandidates().some((item) => item.runId === "hidden-run"));
});
