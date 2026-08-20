import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAgentSession, createRunRecord } from "./agent.store.js";
import { newSortableId } from "../../utils/ids.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  injectJson,
  type AgentTestFixture
} from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Read-side API fixture cleanup failed");
});

async function configureReadSideDefaults(fixture: AgentTestFixture) {
  assert.ok(fixture.app);
  const providers = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{
        id: "ppchat",
        name: "ppchat",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
        models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }]
      }]
    }
  });
  assert.equal(providers.statusCode, 200, providers.body);
  const agents = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "You are a helpful coding assistant.",
        tools: ["bash", "read", "write"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agents.statusCode, 200, agents.body);
}

async function createReadSideFixture() {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, { title: "read-side API test workspace" });
  await configureReadSideDefaults(fixture);
  return { fixture, workspace };
}

function createRun(fixture: AgentTestFixture, workspaceId: string) {
  const sessionId = newSortableId("sess");
  const runId = newSortableId("run");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId,
    title: "read-side API test session",
    kind: "primary",
    createdAt
  });
  createRunRecord(fixture.db, {
    runId,
    workspaceId,
    sessionId,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });
  return { sessionId, runId };
}

test("read-side internal routes preserve token, body validation, and missing-resource responses", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const endpoints = [
    {
      path: "/api/internal/agent/execution-profile",
      validBody: { workspaceId: workspace.id, sessionId, runId },
      invalidBody: { workspaceId: "", sessionId: "", runId: "" },
      missingBody: { workspaceId: workspace.id, sessionId, runId: "missing-run" }
    },
    {
      path: "/api/internal/agent/prompt-context",
      validBody: { workspaceId: workspace.id, sessionId, runId },
      invalidBody: { workspaceId: "", sessionId: "", runId: "" },
      missingBody: { workspaceId: workspace.id, sessionId, runId: "missing-run" }
    },
    {
      path: "/api/internal/agent/messages-context",
      validBody: { workspaceId: workspace.id, sessionId },
      invalidBody: { workspaceId: "", sessionId: "" },
      missingBody: { workspaceId: workspace.id, sessionId: "missing-session" }
    }
  ];

  for (const endpoint of endpoints) {
    const invalidToken = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: "invalid-token",
      payload: endpoint.invalidBody
    });
    assert.equal(invalidToken.statusCode, 401, `${endpoint.path} should retain current invalid-token behavior`);

    const invalidBody = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: endpoint.invalidBody
    });
    assert.equal(invalidBody.statusCode, 400, `${endpoint.path} should retain current invalid-body behavior`);

    const missing = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: endpoint.missingBody
    });
    assert.equal(missing.statusCode, 404, `${endpoint.path} should retain current missing-resource behavior`);

    const workspaceMismatch = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: { ...endpoint.validBody, workspaceId: "workspace-mismatch" }
    });
    assert.equal(workspaceMismatch.statusCode, 400, `${endpoint.path} should retain workspace-mismatch behavior`);
    assert.deepEqual(workspaceMismatch.json(), { message: "workspaceId mismatch" });

    const success = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: endpoint.validBody
    });
    assert.equal(success.statusCode, 200, `${endpoint.path} should retain current successful response`);
  }

  const messagesWithoutRunId = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/messages-context",
    internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId }
  });
  assert.equal(messagesWithoutRunId.statusCode, 200, messagesWithoutRunId.body);

  const profile = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    internalToken: fixture.internalToken,
    payload: endpoints[0]?.validBody
  });
  assert.equal(profile.statusCode, 200, profile.body);
  const profileBody = profile.json() as any;
  assert.equal(profileBody.resolved.runId, runId);
  for (const key of ["agentId", "providerId", "modelId"]) assert.equal(typeof profileBody.resolved[key], "string");
  assert.equal(typeof profileBody.agent?.id, "string");
  assert.equal(typeof profileBody.provider?.id, "string");
  assert.equal(typeof profileBody.provider?.name, "string");
  assert.equal(typeof profileBody.provider?.npm, "string");
  assert.equal(typeof profileBody.provider?.options, "object");
  assert.equal(typeof profileBody.model?.id, "string");
  assert.equal(typeof profileBody.model?.name, "string");
  assert.equal(typeof profileBody.model?.contextWindowTokens, "number");
  assert.equal(typeof profileBody.runtime?.modelIdleTimeoutMs, "number");
  assert.equal(typeof profileBody.runtime?.modelTotalTimeoutMs, "number");
  assert.equal(typeof profileBody.runtime?.modelRequestMaxRetries, "number");
  assert.equal(typeof profileBody.runtime?.autoCompactThresholdPct, "number");
  assert.ok(profileBody.vision === null || typeof profileBody.vision === "object");
  assert.ok(profileBody.compaction === null || typeof profileBody.compaction === "object");

  const prompt = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    internalToken: fixture.internalToken,
    payload: endpoints[1]?.validBody
  });
  assert.equal(prompt.statusCode, 200, prompt.body);
  const promptBody = prompt.json() as any;
  assert.ok(promptBody.headItemId === null || typeof promptBody.headItemId === "number");
  assert.equal(typeof promptBody.system, "string");
  assert.equal(Array.isArray(promptBody.messages), true);
  assert.equal(Array.isArray(promptBody.tools), true);
  assert.equal(Array.isArray(promptBody.pendingTools), true);
  assert.ok(promptBody.lastResponseTotalTokens === null || typeof promptBody.lastResponseTotalTokens === "number");
  assert.ok(promptBody.uiLocale === null || promptBody.uiLocale === "zh-CN" || promptBody.uiLocale === "en-US");
  assert.equal(Array.isArray(promptBody.externalSkillRoots), true);
  for (const tool of promptBody.tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.inputSchema, "object");
  }
  for (const pending of promptBody.pendingTools) {
    assert.equal(typeof pending.itemId, "number");
    assert.equal(typeof pending.status, "string");
    assert.equal(typeof pending.toolName, "string");
    assert.equal(typeof pending.args, "object");
  }
  for (const root of promptBody.externalSkillRoots) {
    assert.ok(root.sourceType === "workspace" || root.sourceType === "repo");
    assert.equal(typeof root.rootDir, "string");
    assert.equal(typeof root.rootPath, "string");
  }
});
