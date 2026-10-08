import assert from "node:assert/strict";
import test from "node:test";
import { createAgentIntegrationFixture, createPrimarySession } from "../testkit/agent-integration-testkit.js";
import { createTestWorkspace } from "../testkit/agent-testkit.js";

test("public metadata route: complete record, scoped errors and strict query validation", async () => {
  const fixture = await createAgentIntegrationFixture();
  try {
    const created = await createPrimarySession(fixture);
    const url = `/api/agent/sessions/${created.id}`;
    const valid = await fixture.app.inject({ method: "GET", url: `${url}?workspaceId=${fixture.workspaceId}` });
    assert.equal(valid.statusCode, 200, valid.body);
    assert.equal(valid.json().id, created.id);
    assert.equal(Object.keys(valid.json()).length, 11);
    const other = await createTestWorkspace(fixture, { title: "other" });
    const cross = await fixture.app.inject({ method: "GET", url: `${url}?workspaceId=${other.id}` });
    assert.equal(cross.statusCode, 404);
    assert.equal(cross.json().code, "SESSION_NOT_FOUND");
    const missingWorkspace = await fixture.app.inject({ method: "GET", url: `${url}?workspaceId=missing-workspace` });
    assert.equal(missingWorkspace.statusCode, 404);
    assert.equal(missingWorkspace.json().code, "WORKSPACE_NOT_FOUND");
    const questionMark = await fixture.app.inject({ method: "GET", url: `${url}?workspaceId=${fixture.workspaceId}?extra=x` });
    assert.equal(questionMark.statusCode, 404, "literal question mark belongs to the workspace ID, not a query truncation alias");
    assert.equal(questionMark.json().code, "WORKSPACE_NOT_FOUND");
    const missing = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/missing?workspaceId=${fixture.workspaceId}` });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "SESSION_NOT_FOUND");
    for (const query of ["", "?workspaceId=", `?workspaceId=${fixture.workspaceId}&extra=x`, `?workspaceId=${fixture.workspaceId}&workspaceId=${fixture.workspaceId}`]) {
      const result = await fixture.app.inject({ method: "GET", url: url + query });
      assert.equal(result.statusCode, 400, `query must be rejected: ${query}`);
    }
  } finally { await fixture.dispose(); }
});

test("metadata route uses the public cookie authentication guard", async () => {
  const fixture = await createAgentIntegrationFixture({ authToken: "metadata-test-auth" });
  try {
    const url = `/api/agent/sessions/unknown?workspaceId=${fixture.workspaceId}`;
    const denied = await fixture.app.inject({ method: "GET", url });
    assert.equal(denied.statusCode, 401);
    const login = await fixture.app.inject({ method: "POST", url: "/api/auth/login", payload: { token: "metadata-test-auth" } });
    const allowed = await fixture.app.inject({ method: "GET", url, headers: { cookie: String(login.headers["set-cookie"]) } });
    assert.equal(allowed.statusCode, 404);
    assert.equal(allowed.json().code, "SESSION_NOT_FOUND");
  } finally { await fixture.dispose(); }
});

test("session list route requires scope and enforces branch-specific strict query parameters", async () => {
  const fixture = await createAgentIntegrationFixture();
  try {
    const created = await createPrimarySession(fixture);
    const url = `/api/agent/sessions?workspaceId=${fixture.workspaceId}`;
    const tabs = await fixture.app.inject({ method: "GET", url: `${url}&scope=tabs` });
    assert.equal(tabs.statusCode, 200, tabs.body);
    assert.equal(tabs.json().scope, "tabs");
    assert.deepEqual(tabs.json().items.map((record: { id: string }) => record.id), [created.id]);
    assert.equal(tabs.json().tabState.workspaceId, fixture.workspaceId);
    assert.equal("nextCursor" in tabs.json(), false);
    const page = await fixture.app.inject({ method: "GET", url: `${url}&scope=continuable` });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(page.json(), { scope: "continuable", items: [], nextCursor: null });
    for (const query of ["", "&scope=bad", "&scope=tabs&limit=", "&scope=tabs&limit=50", "&scope=tabs&cursor=x", "&scope=tabs&extra=x", "&scope=tabs&scope=tabs", "&scope=tabs&workspaceId=x", ...["", "0", "101", "1.5"].map((limit) => `&scope=continuable&limit=${limit}`), "&scope=continuable&cursor=", "&scope=continuable&cursor=!"]) {
      const result = await fixture.app.inject({ method: "GET", url: url + query });
      assert.equal(result.statusCode, 400, `invalid query ${query}: ${result.body}`);
    }
    for (const scope of ["tabs", "continuable"]) {
      const missing = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=missing&scope=${scope}` });
      assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, "WORKSPACE_NOT_FOUND");
    }
  } finally { await fixture.dispose(); }
});

test("scoped lists retain public cookie authentication", async () => {
  const fixture = await createAgentIntegrationFixture({ authToken: "scoped-list-test-auth" });
  try {
    for (const scope of ["tabs", "continuable"]) {
      const denied = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}&scope=${scope}` });
      assert.equal(denied.statusCode, 401);
    }
  } finally { await fixture.dispose(); }
});

test("production connection registers JS trim; reopening an existing database preserves Sessions and Tab overrides", async () => {
  const { openDb } = await import("../../../infra/db/db.js");
  const fixture = await createAgentIntegrationFixture();
  try {
    const created = await createPrimarySession(fixture);
    const mutation = await fixture.app.inject({ method: "PUT", url: `/api/workspaces/${fixture.workspaceId}/agent-tab-state/${created.id}`, payload: { visible: false } });
    assert.equal(mutation.statusCode, 200, mutation.body);
    const before = {
      sessions: fixture.db.prepare("select * from agent_session order by id").all(),
      overrides: fixture.db.prepare("select * from workspace_session_tab_state order by session_id").all()
    };
    const reopened = await openDb(fixture.dataDir);
    try {
      assert.deepEqual(reopened.prepare("select * from agent_session order by id").all(), before.sessions);
      assert.deepEqual(reopened.prepare("select * from workspace_session_tab_state order by session_id").all(), before.overrides);
      assert.deepEqual(reopened.prepare("select agent_trim_title(?) title").get("\u00a0\ufeffTitle\u3000"), { title: "Title" });
    } finally { reopened.close(); }
    const tabs = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}&scope=tabs` });
    assert.equal(tabs.statusCode, 200, tabs.body);
    assert.deepEqual(tabs.json().items, []);
    assert.deepEqual(tabs.json().tabState.closedSessionIds, [created.id]);
  } finally { await fixture.dispose(); }
});

test("a read-side query failure is a server error, never an empty candidate page", async (t) => {
  const { SqliteSessionQuery } = await import("../read-side/sqlite-session-query.js");
  const fixture = await createAgentIntegrationFixture();
  try {
    t.mock.method(SqliteSessionQuery.prototype, "listSessions", () => { throw new Error("synthetic read-side fault"); });
    const page = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}&scope=continuable` });
    assert.equal(page.statusCode, 500, page.body);
    assert.equal("items" in page.json(), false);
  } finally { await fixture.dispose(); }
});

test("continuable HTTP traversal binds cursor limit and workspace; a forged boundary remains workspace-filtered", async () => {
  const { appendMessage } = await import("../agent-message.store.js");
  const { encodeSessionCursor } = await import("../read-side/session-list-query.js");
  const fixture = await createAgentIntegrationFixture();
  try {
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push(await createPrimarySession(fixture));
    appendMessage(fixture.db, { id: "shared-synthetic-head", workspaceId: fixture.workspaceId, sessionId: sessions[0]!.id,
      expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: Date.now() });
    fixture.db.prepare("update agent_session set title='Candidate', head_message_id='shared-synthetic-head', updated_at=10 where workspace_id=?").run(fixture.workspaceId);
    const base = `/api/agent/sessions?workspaceId=${fixture.workspaceId}&scope=continuable&limit=1`;
    const first = await fixture.app.inject({ method: "GET", url: base });
    assert.equal(first.statusCode, 200, first.body);
    const cursor = first.json().nextCursor as string;
    for (const url of [base.replace("limit=1", "limit=2"), base.replace(fixture.workspaceId, "other-workspace")]) {
      const invalid = await fixture.app.inject({ method: "GET", url: `${url}&cursor=${cursor}` });
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(invalid.json().code, "AGENT_SESSION_CURSOR_INVALID");
    }
    const seen: string[] = [];
    let next: string | null = null;
    do {
      const url: string = base + (next ? `&cursor=${next}` : "");
      const response = await fixture.app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, response.body);
      seen.push(...response.json().items.map((record: { id: string }) => record.id));
      next = response.json().nextCursor;
    } while (next);
    assert.deepEqual(seen, sessions.map((record) => record.id).sort().reverse());
    const forged = encodeSessionCursor({ v: 1, workspaceId: fixture.workspaceId, scope: "continuable", limit: 1, id: "unrelated-workspace-id", updatedAt: 1000 });
    const response = await fixture.app.inject({ method: "GET", url: `${base}&cursor=${forged}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items.length, 1);
    assert.equal(response.json().items[0].workspaceId, fixture.workspaceId);
    assert.ok(seen.includes(response.json().items[0].id));
  } finally { await fixture.dispose(); }
});
