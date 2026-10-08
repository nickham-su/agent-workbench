import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { AgentSessionQueryResponse } from "@agent-workbench/shared/contracts/agent-session-query";
import { AUTH_COOKIE_NAME, createSessionCookieValue } from "../../../infra/auth/sessionCookie.js";
import { createMessageSession } from "../agent-message.store.js";
import { createAgentTestFixture, createTestWorkspace } from "../testkit/agent-testkit.js";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

async function createFixture(t: TestContext, authToken: string | null = null) {
  const fixture = await createAgentTestFixture({
    repoRoot, dataDirPrefix: "session-activity-http-", withApp: true, authToken, agentWorkerConcurrency: 0
  });
  t.after(() => fixture.dispose());
  const app = fixture.app;
  if (!app) throw new Error("session activity HTTP fixture requires an app");
  const workspace = await createTestWorkspace(fixture);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const queryUrl = `${origin}/api/agent/sessions/query?workspaceId=${encodeURIComponent(workspace.id)}&updatedWithinSeconds=3600`;
  return {
    ...fixture, app, origin, workspaceId: workspace.id, queryUrl,
    seedSession(id: string, kind: "primary" | "subtask" = "primary", title = "session") {
      createMessageSession(fixture.db, { id, workspaceId: workspace.id, title, kind, createdAt: Date.now() - 1000 });
    },
    seedMessage(id: string, sessionId: string, type: "user" | "assistant" | "compaction", status = "completed") {
      fixture.db.prepare(`insert into agent_message
        (id, workspace_id, depth, type, status, origin_session_id, updated_revision, created_at, updated_at)
        values (?, ?, 0, ?, ?, ?, 0, 1, 1)`).run(id, workspace.id, type, status, sessionId);
    }
  };
}

async function body(response: Response): Promise<AgentSessionQueryResponse> {
  assert.equal(response.status, 200);
  return response.json() as Promise<AgentSessionQueryResponse>;
}

test("activity HTTP supports zero/default/max windows and the static query route wins over :sessionId", async (t) => {
  const f = await createFixture(t);
  const before = Date.now();
  const empty = await body(await fetch(f.queryUrl));
  const after = Date.now();
  assert.equal(empty.workspaceId, f.workspaceId);
  assert.equal(empty.updatedWithinSeconds, 3600);
  assert.equal(empty.kind, "all");
  assert.equal(empty.status, "all");
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.updatedTo - empty.updatedFrom, 3600_000);
  assert.ok(empty.updatedTo >= before && empty.updatedTo <= after);
  assert.equal((await body(await fetch(f.queryUrl.replace("3600", "7776000")))).updatedWithinSeconds, 7776000);
  assert.equal((await body(await fetch(f.queryUrl.replace("3600", "1")))).total, 0);
  f.seedSession("query", "primary", "");
  f.seedSession("detail-session");
  const result = await body(await fetch(f.queryUrl));
  assert.equal(result.total, 2);
  assert.ok(result.items.some((item) => item.id === "query"));
  assert.equal(result.items.find((item) => item.id === "query")!.title, "");
  const missingTime = await fetch(`${f.origin}/api/agent/sessions/query?workspaceId=${f.workspaceId}`);
  assert.equal(missingTime.status, 400);
  assert.equal((await missingTime.json()).code, "AGENT_SESSION_QUERY_INVALID");
  const detail = await fetch(`${f.origin}/api/agent/sessions/detail-session?workspaceId=${f.workspaceId}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).id, "detail-session");
});

test("activity HTTP uniformly rejects raw unknown/duplicate/noncanonical parameters", async (t) => {
  const f = await createFixture(t);
  const workspace = `workspaceId=${encodeURIComponent(f.workspaceId)}`;
  const invalid = [
    "", workspace, "updatedWithinSeconds=10", "workspaceId=&updatedWithinSeconds=10",
    "workspaceId=%20%09&updatedWithinSeconds=10",
    ...["0", "-1", "%2B1", "01", "1.5", "1e2", "", "true", "%2010", "10%20", "7776001", "9007199254740992"].map((seconds) => `${workspace}&updatedWithinSeconds=${seconds}`),
    `${workspace}&updatedWithinSeconds=10&limit=1`, `${workspace}&updatedWithinSeconds=10&cursor=x`,
    `${workspace}&updatedWithinSeconds=10&unknown=x`, `${workspace}&updatedWithinSeconds=10&kind=`,
    `${workspace}&updatedWithinSeconds=10&kind=Primary`, `${workspace}&updatedWithinSeconds=10&status=`,
    `${workspace}&updatedWithinSeconds=10&status=failed`, `${workspace}&${workspace}&updatedWithinSeconds=10`,
    `${workspace}&updatedWithinSeconds=10&updatedWithinSeconds=20`,
    `${workspace}&updatedWithinSeconds=10&kind=all&kind=all`,
    `${workspace}&updatedWithinSeconds=10&status=idle&status=running`,
    `${workspace}&updatedWithinSeconds=10&%77orkspaceId=${f.workspaceId}`
  ];
  for (const query of invalid) {
    const response = await fetch(`${f.origin}/api/agent/sessions/query?${query}`);
    assert.equal(response.status, 400, `query should fail: ${query}`);
    assert.equal((await response.json()).code, "AGENT_SESSION_QUERY_INVALID", `query should have a uniform error: ${query}`);
  }
});

test("activity HTTP returns all 165 records, current state and counts independent of tab visibility", async (t) => {
  const f = await createFixture(t);
  for (let i = 0; i < 160; i++) f.seedSession(`session-${String(i).padStart(3, "0")}`);
  for (const id of ["Z", "a", "é", "中", "😀"]) f.seedSession(id, "subtask");
  const updatedAt = Date.now() - 1000;
  f.db.prepare("update agent_session set updated_at = ? where workspace_id = ?").run(updatedAt, f.workspaceId);
  f.db.prepare("update session_run_state set status = 'running' where workspace_id = ? and session_id = 'session-000'").run(f.workspaceId);
  f.db.prepare("insert into workspace_session_tab_state (workspace_id,session_id,visible,updated_at) values (?, ?, 0, ?)").run(f.workspaceId, "session-001", updatedAt);
  f.seedMessage("user-one", "session-000", "user");
  f.seedMessage("user-two", "session-000", "user");
  for (let i = 0; i < 3; i++) f.seedMessage(`assistant-${i}`, "session-000", "assistant");
  f.seedMessage("failed", "session-000", "assistant", "failed");
  f.seedMessage("summary", "session-000", "compaction");
  const result = await body(await fetch(f.queryUrl));
  assert.equal(result.total, 165);
  assert.equal(result.items.length, 165);
  assert.equal("nextCursor" in result, false);
  const expected = f.db.prepare("select id from agent_session where workspace_id = ? order by updated_at desc,id collate binary desc").all(f.workspaceId) as { id: string }[];
  assert.deepEqual(result.items.map((item) => item.id), expected.map((row) => row.id));
  const running = result.items.find((item) => item.id === "session-000")!;
  assert.equal(running.status, "running");
  assert.equal(running.userMessageCount, 2);
  assert.equal(running.completedAssistantMessageCount, 3);
  assert.ok(result.items.some((item) => item.id === "session-001"));
  assert.equal((await body(await fetch(`${f.queryUrl}&kind=subtask&status=idle`))).total, 5);
  assert.equal((await body(await fetch(`${f.queryUrl}&kind=primary&status=running`))).total, 1);
  const tabs = await fetch(`${f.origin}/api/agent/sessions?workspaceId=${f.workspaceId}&scope=tabs`);
  assert.equal(tabs.status, 200);
  const oldItems = (await tabs.json()).items as { id: string }[];
  assert.equal(oldItems.length, 159);
  assert.ok(oldItems.every((item) => !["Z", "a", "é", "中", "😀", "session-001"].includes(item.id)));
});

test("activity HTTP reports Workspace/state/numeric errors without hiding corrupt candidates", async (t) => {
  const f = await createFixture(t);
  const missingWorkspace = await fetch(f.queryUrl.replace(f.workspaceId, "unknown-workspace"));
  assert.equal(missingWorkspace.status, 404);
  assert.equal((await missingWorkspace.json()).code, "WORKSPACE_NOT_FOUND");
  f.seedSession("missing-state");
  f.db.prepare("delete from session_run_state where workspace_id = ? and session_id = 'missing-state'").run(f.workspaceId);
  for (const status of ["all", "idle", "running"]) {
    const response = await fetch(`${f.queryUrl}&status=${status}`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, "AGENT_SESSION_QUERY_STATE_INVALID");
  }
  // Old metadata still works without RunState; the new query must not expand its dependencies.
  const old = await fetch(`${f.origin}/api/agent/sessions?workspaceId=${f.workspaceId}&scope=tabs`);
  assert.equal(old.status, 200);
  assert.equal((await old.json()).items.length, 1);
  f.db.prepare("insert into session_run_state (workspace_id, session_id, status, updated_at) values (?, 'missing-state', 'idle', ?)").run(f.workspaceId, Date.now());
  f.db.pragma("ignore_check_constraints = ON");
  f.db.prepare("update session_run_state set status = 'broken' where session_id = 'missing-state'").run();
  f.db.pragma("ignore_check_constraints = OFF");
  const corrupt = await fetch(`${f.queryUrl}&status=running`);
  assert.equal(corrupt.status, 500);
  assert.equal((await corrupt.json()).code, "AGENT_SESSION_QUERY_STATE_INVALID");
  f.db.prepare("update session_run_state set status = 'idle' where session_id = 'missing-state'").run();
  f.db.prepare("update agent_session set updated_at = ? where id = 'missing-state'").run(Date.now() - 0.5);
  const fractional = await fetch(f.queryUrl);
  assert.equal(fractional.status, 500);
  assert.equal((await fractional.json()).code, "AGENT_SESSION_QUERY_STATE_INVALID");
});

test("activity HTTP uses only the existing public Cookie auth, not internal token headers", async (t) => {
  const authToken = randomUUID();
  const f = await createFixture(t, authToken);
  assert.equal((await fetch(f.queryUrl)).status, 401);
  assert.equal((await fetch(f.queryUrl, { headers: { "x-awb-agent-internal-token": f.internalToken } })).status, 401);
  const expired = createSessionCookieValue({ authToken, nowMs: Date.now() - 60_000, ttlMs: 1000 });
  assert.equal((await fetch(f.queryUrl, { headers: { cookie: `${AUTH_COOKIE_NAME}=${expired}` } })).status, 401);
  const login = await fetch(`${f.origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: authToken, remember: true })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("test login did not produce a Cookie");
  const result = await body(await fetch(f.queryUrl, { headers: { cookie } }));
  assert.equal(result.total, 0);
});
