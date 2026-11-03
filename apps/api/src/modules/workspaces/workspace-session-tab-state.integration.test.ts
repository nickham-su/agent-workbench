import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { createIntegrationFixture, createSession } from "../agent/integration/context-writeback.helpers.js";
import { createSubtaskSessionForTest } from "../agent/integration/subtask.helpers.js";
import { createTestWorkspace } from "../agent/testkit/agent-testkit.js";
import { createMessageSession } from "../agent/agent-message.store.js";

function tabStateUrl(workspaceId: string) {
  return `/api/workspaces/${workspaceId}/agent-tab-state`;
}

function tabVisibilityUrl(workspaceId: string, sessionId: string) {
  return `${tabStateUrl(workspaceId)}/${sessionId}`;
}

function tabStateRows(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }, workspaceId: string) {
  return db.prepare("select session_id as sessionId, visible from workspace_session_tab_state where workspace_id = ? order by session_id asc").all(workspaceId);
}

test("Workspace Agent Tab State stores actual visibility for every kind and lists opened IDs", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const primary = await createSession(fixture.app, fixture.workspaceId);
  const subtask = createSubtaskSessionForTest(fixture);
  const rows = (primaryVisible: number, subtaskVisible: number) => [
    { sessionId: primary.id, visible: primaryVisible }, { sessionId: subtask.id, visible: subtaskVisible }
  ].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const initial = await fixture.app.inject({ method: "GET", url: tabStateUrl(fixture.workspaceId) });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json(), { workspaceId: fixture.workspaceId, openedSessionIds: [primary.id], closedSessionIds: [], openedSubtaskSessionIds: [] });
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), rows(1, 0));
  for (const target of [primary, subtask]) for (const visible of [false, false, true, true, false]) {
    const response = await fixture.app.inject({ method: "PUT", url: tabVisibilityUrl(fixture.workspaceId, target.id), payload: { visible } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { workspaceId: fixture.workspaceId, sessionId: target.id, visible });
    assert.equal(tabStateRows(fixture.db, fixture.workspaceId).length, 2, "open/close never deletes or creates a state row");
  }
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), rows(0, 0));
  const state = await fixture.app.inject({ method: "GET", url: tabStateUrl(fixture.workspaceId) });
  assert.deepEqual(state.json(), { workspaceId: fixture.workspaceId, openedSessionIds: [], closedSessionIds: [primary.id], openedSubtaskSessionIds: [] });
});

test("Workspace Agent Tab State validates PUT bodies before mutation", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const primary = await createSession(fixture.app, fixture.workspaceId);

  const unknownField = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, primary.id),
    payload: { visible: false, unexpected: true }
  });
  assert.equal(unknownField.statusCode, 400, unknownField.body);
  assert.equal(unknownField.json().code, "WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD");

  const missingVisible = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, primary.id),
    payload: {}
  });
  assert.equal(missingVisible.statusCode, 400, missingVisible.body);

  const nonBooleanVisible = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, primary.id),
    payload: { visible: "false" }
  });
  assert.equal(nonBooleanVisible.statusCode, 400, nonBooleanVisible.body);
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), [{ sessionId: primary.id, visible: 1 }]);
});

test("Workspace Agent Tab State returns stable Workspace and Session ownership errors", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const primary = await createSession(fixture.app, fixture.workspaceId);
  const otherWorkspace = await createTestWorkspace(fixture, { title: "other tab-state workspace" });
  const otherSessionId = "other-workspace-primary";
  createMessageSession(fixture.db, {
    id: otherSessionId,
    workspaceId: otherWorkspace.id,
    title: "other session",
    kind: "primary",
    createdAt: Date.now()
  });

  const unknownWorkspaceGet = await fixture.app.inject({ method: "GET", url: tabStateUrl("missing-workspace") });
  assert.equal(unknownWorkspaceGet.statusCode, 404, unknownWorkspaceGet.body);
  assert.equal(unknownWorkspaceGet.json().code, "WORKSPACE_NOT_FOUND");

  const unknownWorkspacePut = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl("missing-workspace", primary.id),
    payload: { visible: false }
  });
  assert.equal(unknownWorkspacePut.statusCode, 404, unknownWorkspacePut.body);
  assert.equal(unknownWorkspacePut.json().code, "WORKSPACE_NOT_FOUND");

  const unknownSession = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, "missing-session"),
    payload: { visible: false }
  });
  assert.equal(unknownSession.statusCode, 404, unknownSession.body);
  assert.equal(unknownSession.json().code, "AGENT_SESSION_NOT_FOUND_IN_WORKSPACE");

  const foreignSession = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, otherSessionId),
    payload: { visible: false }
  });
  assert.equal(foreignSession.statusCode, 404, foreignSession.body);
  assert.equal(foreignSession.json().code, "AGENT_SESSION_NOT_FOUND_IN_WORKSPACE");
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), [{ sessionId: primary.id, visible: 1 }]);
});

test("Workspace Agent Tab State inherits API authentication", async (t: TestContext) => {
  const token = "workspace-tab-state-auth-token";
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0, authToken: token });

  const unauthenticated = await fixture.app.inject({ method: "GET", url: tabStateUrl(fixture.workspaceId) });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  const login = await fixture.app.inject({ method: "POST", url: "/api/auth/login", payload: { token } });
  assert.equal(login.statusCode, 200, login.body);
  const authenticated = await fixture.app.inject({
    method: "GET",
    url: tabStateUrl(fixture.workspaceId),
    headers: { cookie: String(login.headers["set-cookie"]) }
  });
  assert.equal(authenticated.statusCode, 200, authenticated.body);
});

test("Workspace Agent Tab State OpenAPI documents paths, schemas and declared errors", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const document = fixture.app.swagger() as unknown as {
    paths: Record<string, {
      get?: {
        tags?: string[];
        parameters?: Array<{ name: string; in: string; required?: boolean }>;
        responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>;
      };
      put?: {
        tags?: string[];
        parameters?: Array<{ name: string; in: string; required?: boolean }>;
        requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, { type?: string }>; required?: string[]; additionalProperties?: boolean } }> };
        responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>;
      };
    }>;
  };

  const getOperation = document.paths["/api/workspaces/{workspaceId}/agent-tab-state"]?.get;
  assert.ok(getOperation, "GET tab state route must be documented");
  assert.ok(getOperation.tags?.includes("workspaces"));
  assert.ok(getOperation.parameters?.some((parameter) => parameter.name === "workspaceId" && parameter.in === "path" && parameter.required));
  assert.deepEqual(Object.keys(getOperation.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {}).sort(), [
    "closedSessionIds",
    "openedSessionIds",
    "openedSubtaskSessionIds",
    "workspaceId"
  ]);
  assert.ok(getOperation.responses?.["404"], "GET must declare its Workspace-not-found response");

  const putOperation = document.paths["/api/workspaces/{workspaceId}/agent-tab-state/{sessionId}"]?.put;
  assert.ok(putOperation, "PUT tab visibility route must be documented");
  assert.ok(putOperation.tags?.includes("workspaces"));
  for (const name of ["workspaceId", "sessionId"]) {
    assert.ok(putOperation.parameters?.some((parameter) => parameter.name === name && parameter.in === "path" && parameter.required));
  }
  const body = putOperation.requestBody?.content?.["application/json"]?.schema;
  assert.ok(body, "PUT request body must be documented as application/json");
  assert.deepEqual(Object.keys(body.properties ?? {}), ["visible"]);
  assert.deepEqual(body.required, ["visible"]);
  assert.equal(body.additionalProperties, false);
  assert.equal(body.properties?.visible?.type, "boolean");
  assert.deepEqual(Object.keys(putOperation.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {}).sort(), [
    "sessionId",
    "visible",
    "workspaceId"
  ]);
  for (const status of ["400", "404", "409", "500"]) {
    assert.ok(putOperation.responses?.[status], `PUT must declare its ${status} error response`);
  }
});

test("Workspace Agent Tab State PUT is rejected by the Workspace deleting fence", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const primary = await createSession(fixture.app, fixture.workspaceId);
  workspaceDeletingFence.restore(fixture.workspaceId);
  try {
    const response = await fixture.app.inject({
      method: "PUT",
      url: tabVisibilityUrl(fixture.workspaceId, primary.id),
      payload: { visible: false }
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "WORKSPACE_DELETING");
    assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), [{ sessionId: primary.id, visible: 1 }]);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});


test("hidden sessions open in the same persistent Tab projection; closed hidden IDs are not enumerated", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  for (const kind of ["primary", "subtask"] as const) createMessageSession(fixture.db, {
    id: `hidden-${kind}`, workspaceId: fixture.workspaceId, title: kind, kind, visibility: "unlisted", createdAt: 1
  });
  const get = () => fixture.app.inject({ method: "GET", url: tabStateUrl(fixture.workspaceId) });
  assert.deepEqual((await get()).json(), { workspaceId: fixture.workspaceId, openedSessionIds: [], closedSessionIds: [], openedSubtaskSessionIds: [] });
  for (const id of ["hidden-primary", "hidden-subtask"]) {
    const put = await fixture.app.inject({ method: "PUT", url: tabVisibilityUrl(fixture.workspaceId, id), payload: { visible: true } });
    assert.equal(put.statusCode, 200, put.body);
  }
  const tabs = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}&scope=tabs` });
  assert.equal(tabs.statusCode, 200, tabs.body);
  assert.deepEqual(tabs.json().tabState, (await get()).json());
  assert.deepEqual(tabs.json().items.map((item: {id: string}) => item.id).sort(), ["hidden-primary", "hidden-subtask"]);
  assert.ok(tabs.json().items.every((item: {visibility: string}) => item.visibility === "unlisted"));
  for (const id of ["hidden-primary", "hidden-subtask"]) await fixture.app.inject({ method: "PUT", url: tabVisibilityUrl(fixture.workspaceId, id), payload: { visible: false } });
  assert.deepEqual((await get()).json(), { workspaceId: fixture.workspaceId, openedSessionIds: [], closedSessionIds: [], openedSubtaskSessionIds: [] });
  assert.equal(tabStateRows(fixture.db, fixture.workspaceId).length, 2);
});

test("missing Tab state returns a fixed 500 without repair while direct metadata/run-state reads remain usable", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const primary = await createSession(fixture.app, fixture.workspaceId);
  fixture.db.prepare("delete from workspace_session_tab_state where session_id=?").run(primary.id);
  for (const request of [
    { method: "GET" as const, url: tabStateUrl(fixture.workspaceId) },
    { method: "GET" as const, url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}&scope=tabs` },
    { method: "PUT" as const, url: tabVisibilityUrl(fixture.workspaceId, primary.id), payload: { visible: false } }
  ]) {
    const response = await fixture.app.inject(request); assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().code, "AGENT_TAB_STATE_INVALID");
  }
  const metadata = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${primary.id}?workspaceId=${fixture.workspaceId}` });
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.ok(fixture.db.prepare("select 1 from session_run_state where session_id=?").get(primary.id));
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), []);
});
