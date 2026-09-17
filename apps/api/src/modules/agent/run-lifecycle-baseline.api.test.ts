import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newSortableId } from "../../utils/ids.js";
import { AgentRunCompletedEventHub } from "./run-completed-events.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentService } from "./agent.service.js";
import { createAgentService } from "./agent.composition.js";
import { createMessageSession, getMessageRunState, getRunRecord } from "./agent-message.store.js";
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

test("P3: public enqueue outcome unknown 保持 durable running 并以同一 Run reconciliation", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  await configureAgentDefaults(fixture.app);

  const workspace = await createTestWorkspace(fixture, { title: "P0 enqueue failure workspace" });
  const sessionId = newSortableId("sess");
  createMessageSession(fixture.db, {
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

  const userMessage = fixture.db.prepare(`
    select message.id, message.type, message.status, part.type as partType
    from agent_message message join agent_message_part part on part.message_id = message.id
    where message.workspace_id = ? and message.origin_session_id = ?
    order by message.created_at asc, part.position asc limit 1
  `).get(workspace.id, sessionId) as { id: string; type: string; status: string; partType: string } | undefined;
  assert.ok(userMessage);
  assert.equal(userMessage.type, "user");
  assert.equal(userMessage.status, "completed");
  assert.equal(userMessage.partType, "text");
  const stateAfterFailure = getMessageRunState(fixture.db, workspace.id, sessionId)!;
  assert.equal(stateAfterFailure.status, "running");
  const activeRun = getRunRecord(fixture.db, route.runtime.enqueueRunCalls[0]?.runId ?? "");
  assert.equal(activeRun?.status, "running");
  assert.equal(stateAfterFailure.activeRunId, activeRun?.runId);
  assert.equal(activeRun?.triggerMessageId, `message-${activeRun?.runId}`);

  const retry = await route.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${sessionId}/messages`,
    payload
  });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.deepEqual(retry.json(), {
    sessionId,
    messageId: userMessage!.id,
    runId: activeRun?.runId,
    deduplicated: true
  });
  assert.equal(route.runtime.enqueueRunCalls.length, 1, "deduplicated retry must not enqueue again");
  assert.equal(fixture.db.prepare(`
    select message.id, message.type, message.status, part.type as partType
    from agent_message message join agent_message_part part on part.message_id = message.id
    where message.workspace_id = ? and message.origin_session_id = ?
    order by message.created_at asc, part.position asc
  `).all(workspace.id, sessionId).length, 1);
  assert.equal(getRunRecord(fixture.db, activeRun?.runId ?? "")?.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)!.activeRunId, activeRun?.runId);
});

test("P3: internal trigger shares Lifecycle unknown-enqueue reconciliation and dedup behavior", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  await configureAgentDefaults(fixture.app);

  const workspace = await createTestWorkspace(fixture, { title: "P3 internal enqueue failure workspace" });
  const sessionId = newSortableId("sess");
  createMessageSession(fixture.db, {
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

  const userMessage = fixture.db.prepare(`
    select message.id, message.type, message.status, part.type as partType
    from agent_message message join agent_message_part part on part.message_id = message.id
    where message.workspace_id = ? and message.origin_session_id = ?
    order by message.created_at asc, part.position asc limit 1
  `).get(workspace.id, sessionId) as { id: string; type: string; status: string; partType: string } | undefined;
  assert.ok(userMessage);
  const activeRunId = route.runtime.enqueueRunCalls[0]?.runId ?? "";
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)!.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)!.activeRunId, activeRunId);

  const retry = await route.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers,
    payload
  });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.deepEqual(retry.json(), {
    sessionId,
    messageId: userMessage.id,
    runId: activeRunId,
    deduplicated: true
  });
  assert.equal(route.runtime.enqueueRunCalls.length, 1, "deduplicated internal retry must not enqueue again");
});
