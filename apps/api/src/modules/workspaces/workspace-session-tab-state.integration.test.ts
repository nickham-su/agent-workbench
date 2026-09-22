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

test("Workspace Agent Tab State GET returns an empty state and PUT normalizes visibility overrides", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const primary = await createSession(fixture.app, fixture.workspaceId);
  const subtask = createSubtaskSessionForTest(fixture);

  const empty = await fixture.app.inject({ method: "GET", url: tabStateUrl(fixture.workspaceId) });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), {
    workspaceId: fixture.workspaceId,
    closedSessionIds: [],
    openedSubtaskSessionIds: []
  });

  const hiddenPrimary = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, primary.id),
    payload: { visible: false }
  });
  assert.equal(hiddenPrimary.statusCode, 200, hiddenPrimary.body);
  assert.deepEqual(hiddenPrimary.json(), { workspaceId: fixture.workspaceId, sessionId: primary.id, visible: false });
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), [{ sessionId: primary.id, visible: 0 }]);

  const hiddenPrimaryAgain = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, primary.id),
    payload: { visible: false }
  });
  assert.equal(hiddenPrimaryAgain.statusCode, 200, hiddenPrimaryAgain.body);
  assert.deepEqual(hiddenPrimaryAgain.json(), { workspaceId: fixture.workspaceId, sessionId: primary.id, visible: false });
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), [{ sessionId: primary.id, visible: 0 }]);

  const restoredPrimary = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, primary.id),
    payload: { visible: true }
  });
  assert.equal(restoredPrimary.statusCode, 200, restoredPrimary.body);
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), []);

  const openedSubtask = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, subtask.id),
    payload: { visible: true }
  });
  assert.equal(openedSubtask.statusCode, 200, openedSubtask.body);
  assert.deepEqual(openedSubtask.json(), { workspaceId: fixture.workspaceId, sessionId: subtask.id, visible: true });
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), [{ sessionId: subtask.id, visible: 1 }]);

  const closedSubtask = await fixture.app.inject({
    method: "PUT",
    url: tabVisibilityUrl(fixture.workspaceId, subtask.id),
    payload: { visible: false }
  });
  assert.equal(closedSubtask.statusCode, 200, closedSubtask.body);
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), []);

  const state = await fixture.app.inject({ method: "GET", url: tabStateUrl(fixture.workspaceId) });
  assert.equal(state.statusCode, 200, state.body);
  assert.deepEqual(state.json(), {
    workspaceId: fixture.workspaceId,
    closedSessionIds: [],
    openedSubtaskSessionIds: []
  });
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
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), []);
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
  assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), []);
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
  for (const status of ["400", "404", "409"]) {
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
    assert.deepEqual(tabStateRows(fixture.db, fixture.workspaceId), []);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});
