import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createAgentIntegrationFixture } from "./testkit/agent-integration-testkit.js";
import { createAgentSession, getSessionAgentModelOverride } from "./agent.store.js";
import { setSettingJson } from "../settings/settings.store.js";

async function createFixture(t: TestContext) {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => fixture.dispose());
  return fixture;
}

async function createPrimarySession(app: any, workspaceId: string) {
  const response = await app.inject({ method: "POST", url: "/api/agent/sessions", payload: { workspaceId, title: "model test" } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { id: string };
}

test("session model override public API isolates sessions and never changes agent defaults", async (t) => {
  const fixture = await createFixture(t);
  const first = await createPrimarySession(fixture.app, fixture.workspaceId);
  const second = await createPrimarySession(fixture.app, fixture.workspaceId);
  const defaultsBefore = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });

  const put = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${first.id}/agents/default/model-override`,
    payload: { workspaceId: fixture.workspaceId, providerId: "ppchat", modelId: "gpt-5.2" }
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((put.json() as any).source, "session_override");

  const firstGet = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${first.id}/model-overrides?workspaceId=${fixture.workspaceId}` });
  const secondGet = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${second.id}/model-overrides?workspaceId=${fixture.workspaceId}` });
  assert.equal((firstGet.json() as any).items[0].override.modelId, "gpt-5.2");
  assert.equal((secondGet.json() as any).items[0].override, null);

  const defaultsAfter = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.deepEqual(defaultsAfter.json(), defaultsBefore.json());
});

test("session model override DELETE clears stale records and session deletion cascades", async (t) => {
  const fixture = await createFixture(t);
  const session = await createPrimarySession(fixture.app, fixture.workspaceId);
  fixture.db.prepare(`insert into agent_session_agent_model_override (session_id, agent_id, provider_id, model_id, updated_at) values (?, ?, ?, ?, ?)`)
    .run(session.id, "default", "removed_provider", "removed_model", 1);

  const before = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/model-overrides?workspaceId=${fixture.workspaceId}` });
  assert.equal((before.json() as any).items[0].status, "invalid");
  const deleted = await fixture.app.inject({ method: "DELETE", url: `/api/agent/sessions/${session.id}/agents/default/model-override?workspaceId=${fixture.workspaceId}` });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((deleted.json() as any).source, "agent_default");
  assert.equal(getSessionAgentModelOverride(fixture.db, { sessionId: session.id, agentId: "default" }), null);

  const cascadeId = "sess_model_cascade";
  createAgentSession(fixture.db, { id: cascadeId, workspaceId: fixture.workspaceId, title: "cascade", kind: "primary", createdAt: 10 });
  fixture.db.prepare(`insert into agent_session_agent_model_override (session_id, agent_id, provider_id, model_id, updated_at) values (?, ?, ?, ?, ?)`)
    .run(cascadeId, "default", "ppchat", "gpt-5.2", 1);
  fixture.db.prepare("delete from agent_session where id = ?").run(cascadeId);
  assert.equal(getSessionAgentModelOverride(fixture.db, { sessionId: cascadeId, agentId: "default" }), null);
});

test("session model state projects disabled and non-user-scope agents as invalid on GET and DELETE", async (t) => {
  const fixture = await createFixture(t);
  const session = await createPrimarySession(fixture.app, fixture.workspaceId);
  const override = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${session.id}/agents/default/model-override`,
    payload: { workspaceId: fixture.workspaceId, providerId: "ppchat", modelId: "gpt-5.2" }
  });
  assert.equal(override.statusCode, 200, override.body);

  const now = Date.now();
  setSettingJson(fixture.db, "workspace_agent_enablement_v1", {
    workspaces: {
      [fixture.workspaceId]: { mode: "subset", enabledAgentIds: [], updatedAt: now }
    }
  }, now);
  const disabledGet = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/model-overrides?workspaceId=${fixture.workspaceId}` });
  const disabledState = (disabledGet.json() as any).items[0];
  assert.equal(disabledGet.statusCode, 200, disabledGet.body);
  assert.equal(disabledState.status, "invalid");
  assert.equal(disabledState.reasonCode, "AGENT_DISABLED_IN_WORKSPACE");
  assert.equal(disabledState.effectiveModel, null);

  const disabledDelete = await fixture.app.inject({ method: "DELETE", url: `/api/agent/sessions/${session.id}/agents/default/model-override?workspaceId=${fixture.workspaceId}` });
  assert.equal(disabledDelete.statusCode, 200, disabledDelete.body);
  assert.equal((disabledDelete.json() as any).status, "invalid");
  assert.equal((disabledDelete.json() as any).reasonCode, "AGENT_DISABLED_IN_WORKSPACE");

  setSettingJson(fixture.db, "workspace_agent_enablement_v1", {
    workspaces: {
      [fixture.workspaceId]: { mode: "all", enabledAgentIds: [], updatedAt: now + 1 }
    }
  }, now + 1);
  fixture.db.prepare(`insert into agent_session_agent_model_override (session_id, agent_id, provider_id, model_id, updated_at) values (?, ?, ?, ?, ?)`)
    .run(session.id, "default", "ppchat", "gpt-5.2", now + 1);
  setSettingJson(fixture.db, "agent_agents_v1", {
    agents: [{
      id: "default", name: "default", summary: "", prompt: "You are a helpful coding assistant.",
      tools: ["bash", "read", "write"], pluginTools: [], mcpServers: [],
      defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "subtask", order: 0
    }]
  }, now + 1);
  const scopeGet = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/model-overrides?workspaceId=${fixture.workspaceId}` });
  assert.equal(scopeGet.statusCode, 200, scopeGet.body);
  assert.equal((scopeGet.json() as any).items[0].status, "invalid");
  assert.equal((scopeGet.json() as any).items[0].reasonCode, "AGENT_SCOPE_NOT_ALLOWED");

  const scopeDelete = await fixture.app.inject({ method: "DELETE", url: `/api/agent/sessions/${session.id}/agents/default/model-override?workspaceId=${fixture.workspaceId}` });
  assert.equal(scopeDelete.statusCode, 200, scopeDelete.body);
  assert.equal((scopeDelete.json() as any).status, "invalid");
  assert.equal((scopeDelete.json() as any).reasonCode, "AGENT_SCOPE_NOT_ALLOWED");
});

test("session model override API rejects subtask and hides cross-workspace session", async (t) => {
  const fixture = await createFixture(t);
  createAgentSession(fixture.db, { id: "sess_subtask_model", workspaceId: fixture.workspaceId, title: "subtask", kind: "subtask", createdAt: 1 });
  const subtask = await fixture.app.inject({
    method: "PUT",
    url: "/api/agent/sessions/sess_subtask_model/agents/default/model-override",
    payload: { workspaceId: fixture.workspaceId, providerId: "ppchat", modelId: "gpt-5.2" }
  });
  assert.equal(subtask.statusCode, 409, subtask.body);
  assert.equal((subtask.json() as any).code, "AGENT_SESSION_MODEL_OVERRIDE_NOT_EDITABLE");

  const primary = await createPrimarySession(fixture.app, fixture.workspaceId);
  const crossWorkspace = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${primary.id}/model-overrides?workspaceId=wrong_workspace`
  });
  assert.equal(crossWorkspace.statusCode, 404, crossWorkspace.body);
});
