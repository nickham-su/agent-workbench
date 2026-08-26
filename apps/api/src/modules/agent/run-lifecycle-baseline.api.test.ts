import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newSortableId } from "../../utils/ids.js";
import { AgentRunCompletedEventHub } from "./run-completed-events.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentService } from "./agent.service.js";
import { createAgentService } from "./agent.composition.js";
import { createAgentSession, getRunRecord, getRunState, getSessionTranscriptItems } from "./agent.store.js";
import {
  createAgentTestFixture,
  createFakeAgentRuntime,
  createTestWorkspace,
  type AgentTestFixture
} from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];
const routeApps: FastifyInstance[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const app of routeApps.splice(0)) {
    try {
      await app.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Run Lifecycle baseline fixture cleanup failed");
});

async function configureAgentDefaults(app: FastifyInstance) {
  const providers = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "p0-provider", modelId: "p0-model" },
      providers: [{
        id: "p0-provider",
        name: "P0 provider",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://example.test/v1", apiKey: "p0-test-key" },
        models: [{ id: "p0-model", name: "P0 model", contextWindowTokens: 128000 }]
      }]
    }
  });
  assert.equal(providers.statusCode, 200, providers.body);

  const agents = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "P0 characterization agent",
        tools: ["read"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: { providerId: "p0-provider", modelId: "p0-model" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agents.statusCode, 200, agents.body);
}

function createRouteApp(params: { fixture: AgentTestFixture; enqueueError: Error }) {
  const app = Fastify({ logger: false });
  const runtime = createFakeAgentRuntime({ enqueueRunError: params.enqueueError });
  const eventHub = new AgentRunCompletedEventHub();
  const service = createAgentService(params.fixture.ctx, app.log, eventHub);
  return { app, runtime, register: registerAgentRoutes(app, { service, runtime, internalToken: params.fixture.ctx.agentInternalToken, dataDir: params.fixture.ctx.dataDir, runCompletedEventHub: eventHub }) };
}

test("P3: public send enqueue failure conditionally settles failed/idle while preserving durable dedup retry without re-enqueue", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  await configureAgentDefaults(fixture.app);

  const workspace = await createTestWorkspace(fixture, { title: "P0 enqueue failure workspace" });
  const sessionId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P0 enqueue failure session",
    kind: "primary",
    createdAt: Date.now()
  });

  const route = createRouteApp({ fixture, enqueueError: new Error("P0 enqueue failure") });
  routeApps.push(route.app);
  await route.register;
  await route.app.ready();

  const payload = {
    workspaceId: workspace.id,
    agentId: "default",
    text: "P0 enqueue failure characterization",
    clientRequestId: "p0-public-enqueue-failure-dedup"
  };
  const first = await route.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${sessionId}/messages`,
    payload
  });
  assert.notEqual(first.statusCode, 201, first.body);
  assert.equal(route.runtime.enqueueRunCalls.length, 1);

  const [userItem] = getSessionTranscriptItems(fixture.db, workspace.id, sessionId);
  assert.ok(userItem);
  assert.equal(userItem.kind, "user");
  assert.equal(userItem.status, "completed");
  assert.equal(userItem.output.type, "user_text");
  const stateAfterFailure = getRunState(fixture.db, workspace.id, sessionId);
  assert.equal(stateAfterFailure.status, "idle");
  assert.equal(stateAfterFailure.activeRunId, null);
  const failedEnqueueRun = getRunRecord(fixture.db, route.runtime.enqueueRunCalls[0]?.runId ?? "");
  assert.equal(failedEnqueueRun?.status, "failed");
  assert.equal(failedEnqueueRun?.triggerItemId, userItem.id);

  const retry = await route.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${sessionId}/messages`,
    payload
  });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.deepEqual(retry.json(), {
    sessionId,
    messageItemId: userItem.id,
    runId: failedEnqueueRun?.runId,
    deduplicated: true
  });
  assert.equal(route.runtime.enqueueRunCalls.length, 1, "deduplicated retry must not enqueue again");
  assert.equal(getSessionTranscriptItems(fixture.db, workspace.id, sessionId).length, 1);
  assert.equal(getRunRecord(fixture.db, failedEnqueueRun?.runId ?? "")?.status, "failed");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).activeRunId, null);
});

test("P3: internal trigger shares Lifecycle enqueue-failure settlement and dedup behavior", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  await configureAgentDefaults(fixture.app);

  const workspace = await createTestWorkspace(fixture, { title: "P3 internal enqueue failure workspace" });
  const sessionId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P3 internal enqueue failure session",
    kind: "primary",
    createdAt: Date.now()
  });

  const route = createRouteApp({ fixture, enqueueError: new Error("P3 internal enqueue failure") });
  routeApps.push(route.app);
  await route.register;
  await route.app.ready();

  const payload = {
    workspaceId: workspace.id,
    sessionId,
    agentId: "default",
    text: "P3 internal enqueue failure characterization",
    clientRequestId: "p3-internal-enqueue-failure-dedup"
  };
  const headers = { "x-awb-agent-internal-token": fixture.internalToken };
  const first = await route.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers,
    payload
  });
  assert.notEqual(first.statusCode, 201, first.body);
  assert.equal(route.runtime.enqueueRunCalls.length, 1);

  const [userItem] = getSessionTranscriptItems(fixture.db, workspace.id, sessionId);
  assert.ok(userItem);
  const failedRunId = route.runtime.enqueueRunCalls[0]?.runId ?? "";
  assert.equal(getRunRecord(fixture.db, failedRunId)?.status, "failed");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).status, "idle");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).activeRunId, null);

  const retry = await route.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers,
    payload
  });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.deepEqual(retry.json(), {
    sessionId,
    messageItemId: userItem.id,
    runId: failedRunId,
    deduplicated: true
  });
  assert.equal(route.runtime.enqueueRunCalls.length, 1, "deduplicated internal retry must not enqueue again");
});
