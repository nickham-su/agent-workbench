import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionAgentModelApplication } from "./session-agent-model-application.js";

const primarySession = {
  id: "sess_primary",
  workspaceId: "ws_1",
  title: "primary",
  kind: "primary" as const,
  forkedFromSessionId: null,
  forkedFromItemId: null,
  headItemId: null,
  createdAt: 1,
  updatedAt: 1
};

function createHarness(input?: {
  kind?: "primary" | "subtask";
  agents?: any[];
  providers?: any[];
  enablement?: { mode: "all" | "subset"; enabledAgentIds: string[] };
}) {
  const records = new Map<string, any>();
  const agents = input?.agents ?? [{
    id: "agent_a", name: "Agent A", scope: "both", order: 0, summary: "", prompt: "", globalPromptIds: [], tools: [], mcpServers: [], pluginTools: [],
    defaultModel: { providerId: "provider_default", modelId: "model_default" }
  }];
  const providers = input?.providers ?? [
    { id: "provider_default", name: "Default", npm: "@ai-sdk/openai", options: { baseURL: "https://example.test", apiKey: "key" }, models: [{ id: "model_default", name: "Default Model", contextWindowTokens: 1000 }] },
    { id: "provider_override", name: "Override", npm: "@ai-sdk/openai", options: { baseURL: "https://example.test", apiKey: "key" }, models: [{ id: "model_override", name: "Override Model", contextWindowTokens: 2000 }] }
  ];
  const app = new SessionAgentModelApplication({
    sessions: { get: (sessionId) => sessionId === primarySession.id ? { ...primarySession, kind: input?.kind ?? "primary" } : null },
    overrides: {
      get: ({ sessionId, agentId }) => records.get(`${sessionId}:${agentId}`) ?? null,
      list: ({ sessionId }) => [...records.values()].filter((record) => record.sessionId === sessionId),
      upsert: (record) => records.set(`${record.sessionId}:${record.agentId}`, record),
      delete: ({ sessionId, agentId }) => records.delete(`${sessionId}:${agentId}`)
    },
    settings: {
      getAgents: () => agents,
      getProviders: () => ({ default: null, providers, updatedAt: 1 }),
      getWorkspaceEnablement: () => input?.enablement ?? { mode: "all", enabledAgentIds: [] }
    },
    clock: { nowMs: () => 123 }
  });
  return { app, records };
}

test("session agent model application stores an override and returns write-after state", () => {
  const { app, records } = createHarness();
  const state = app.put({
    sessionId: "sess_primary",
    agentId: "agent_a",
    body: { workspaceId: "ws_1", providerId: "provider_override", modelId: "model_override" }
  });
  assert.equal(records.size, 1);
  assert.equal(state.source, "session_override");
  assert.equal(state.status, "ready");
  assert.equal(state.effectiveModel?.modelId, "model_override");
  assert.equal(state.override?.updatedAt, 123);
});

test("session agent model application resolves a complete override pair for a new Run", () => {
  const { app, records } = createHarness();
  records.set("sess_primary:agent_a", {
    sessionId: "sess_primary", agentId: "agent_a", providerId: "provider_override", modelId: "model_override", updatedAt: 2
  });
  assert.deepEqual(
    app.resolveForNewRun({ sessionId: "sess_primary", workspaceId: "ws_1", agentId: "agent_a" }),
    { providerId: "provider_override", modelId: "model_override", source: "session_override" }
  );

  records.set("sess_primary:agent_a", {
    sessionId: "sess_primary", agentId: "agent_a", providerId: "provider_override", modelId: "missing", updatedAt: 3
  });
  assert.throws(
    () => app.resolveForNewRun({ sessionId: "sess_primary", workspaceId: "ws_1", agentId: "agent_a" }),
    (error: any) => error?.code === "AGENT_MODEL_NOT_FOUND"
  );
});

test("session agent model application deletes stale overrides and projects the default", () => {
  const { app, records } = createHarness();
  records.set("sess_primary:agent_a", {
    sessionId: "sess_primary", agentId: "agent_a", providerId: "missing", modelId: "missing", updatedAt: 2
  });
  const state = app.delete({ sessionId: "sess_primary", agentId: "agent_a", workspaceId: "ws_1" });
  assert.equal(records.size, 0);
  assert.equal(state.source, "agent_default");
  assert.equal(state.status, "ready");
  assert.equal(state.effectiveModel?.modelId, "model_default");
});

test("session agent model application keeps invalid persisted override visible instead of falling back", () => {
  const { app, records } = createHarness();
  records.set("sess_primary:agent_a", {
    sessionId: "sess_primary", agentId: "agent_a", providerId: "missing", modelId: "missing", updatedAt: 2
  });
  const response = app.list({ sessionId: "sess_primary", workspaceId: "ws_1" });
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.source, "session_override");
  assert.equal(response.items[0]?.status, "invalid");
  assert.equal(response.items[0]?.effectiveModel, null);
});

test("session agent model application rejects subtask edits and disabled agents", () => {
  const subtask = createHarness({ kind: "subtask" });
  assert.throws(
    () => subtask.app.list({ sessionId: "sess_primary", workspaceId: "ws_1" }),
    (error: any) => error?.code === "AGENT_SESSION_MODEL_OVERRIDE_NOT_EDITABLE"
  );

  const disabled = createHarness({ enablement: { mode: "subset", enabledAgentIds: [] } });
  assert.throws(
    () => disabled.app.put({ sessionId: "sess_primary", agentId: "agent_a", body: { workspaceId: "ws_1", providerId: "provider_override", modelId: "model_override" } }),
    (error: any) => error?.code === "AGENT_DISABLED_IN_WORKSPACE"
  );
});
