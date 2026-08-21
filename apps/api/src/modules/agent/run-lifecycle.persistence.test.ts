import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { newSortableId } from "../../utils/ids.js";
import { AgentService } from "./agent.service.js";
import {
  createAgentSession,
  createRunRecord,
  getRunRecord,
  getRunState,
  updateRunState
} from "./agent.store.js";
import {
  createAgentTestFixture,
  createFakeAgentRuntime,
  createTestWorkspace,
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
  if (failures.length > 1) throw new AggregateError(failures, "Run Lifecycle persistence fixture cleanup failed");
});

function createRunningRun(params: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  runId: string;
  activeRunId: string;
  createdAt: number;
}) {
  createRunRecord(params.fixture.db, {
    runId: params.runId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    triggerItemId: 0,
    agentId: "default",
    providerId: "p0-provider",
    modelId: "p0-model",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null,
    status: "running",
    createdAt: params.createdAt
  });
  updateRunState(params.fixture.db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    status: "running",
    activeRunId: params.activeRunId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: params.createdAt,
    appliedItemId: 0
  });
}

test("P1 real SQLite: enqueue failure settles its run but does not idle a switched active run", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P1 failure settlement workspace" });
  const sessionId = newSortableId("sess");
  const olderRunId = newSortableId("run");
  const activeRunId = newSortableId("run");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P1 failure settlement session",
    kind: "primary",
    createdAt
  });
  createRunningRun({
    fixture,
    workspaceId: workspace.id,
    sessionId,
    runId: olderRunId,
    activeRunId,
    createdAt
  });
  createRunRecord(fixture.db, {
    runId: activeRunId,
    workspaceId: workspace.id,
    sessionId,
    triggerItemId: 0,
    agentId: "default",
    providerId: "p0-provider",
    modelId: "p0-model",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null,
    status: "running",
    createdAt: createdAt + 1
  });

  const service = new AgentService(fixture.ctx, fixture.app.log);
  service.failRunOnEnqueueFailure({ workspaceId: workspace.id, sessionId, runId: olderRunId });

  assert.equal(getRunRecord(fixture.db, olderRunId)?.status, "failed");
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
  const state = getRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state.status, "running");
  assert.equal(state.activeRunId, activeRunId);
  assert.equal(state.activeAssistantItemId, null);
  assert.equal(state.appliedItemId, 0);
});

test("P1 real SQLite: cancel wins over a late enqueue-failure settlement", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P1 cancel wins workspace" });
  const sessionId = newSortableId("sess");
  const runId = newSortableId("run");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P1 cancel wins session",
    kind: "primary",
    createdAt
  });
  createRunningRun({ fixture, workspaceId: workspace.id, sessionId, runId, activeRunId: runId, createdAt });

  const service = new AgentService(fixture.ctx, fixture.app.log);
  const cancelled = service.cancelSessionCascade(sessionId, { workspaceId: workspace.id });
  assert.deepEqual(cancelled.runtimeCancelSessionIds, [sessionId]);
  assert.equal(cancelled.result.ok, true);
  service.failRunOnEnqueueFailure({ workspaceId: workspace.id, sessionId, runId });

  assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).status, "idle");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).activeRunId, null);
});

test("P1 real SQLite: recovery final check observes cancellation and does not enqueue", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P1 recovery fence workspace" });
  const sessionId = newSortableId("sess");
  const runId = newSortableId("run");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P1 recovery fence session",
    kind: "primary",
    createdAt
  });
  createRunningRun({ fixture, workspaceId: workspace.id, sessionId, runId, activeRunId: runId, createdAt });

  const service = new AgentService(fixture.ctx, fixture.app.log);
  const runtime = createFakeAgentRuntime();
  await service.recoverRunsOnStartup({ runtime,
    beforeFinalCheck(candidate) {
      assert.equal(candidate.runId, runId);
      service.cancelSessionCascade(sessionId, { workspaceId: workspace.id });
    }
  });

  assert.deepEqual(runtime.enqueueRunCalls, []);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).status, "idle");
});

test("P4 real SQLite: completing an old run does not idle a newer active run", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P4 complete fence workspace" });
  const sessionId = newSortableId("sess");
  const oldRunId = newSortableId("run");
  const activeRunId = newSortableId("run");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P4 complete fence session",
    kind: "primary",
    createdAt
  });
  createRunningRun({ fixture, workspaceId: workspace.id, sessionId, runId: oldRunId, activeRunId, createdAt });
  createRunRecord(fixture.db, {
    runId: activeRunId,
    workspaceId: workspace.id,
    sessionId,
    triggerItemId: 0,
    agentId: "default",
    providerId: "p4-provider",
    modelId: "p4-model",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null,
    status: "running",
    createdAt: createdAt + 1
  });

  const service = new AgentService(fixture.ctx, fixture.app.log);
  service.completeRunFromWorker({
    workspaceId: workspace.id,
    sessionId,
    runId: oldRunId,
    status: "completed",
    updatedAt: createdAt + 2
  });

  assert.equal(getRunRecord(fixture.db, oldRunId)?.status, "completed");
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).status, "running");
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).activeRunId, activeRunId);
});

test("P4 real SQLite: a late idle/null worker state does not clear a newer active run", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P4 late idle state fence workspace" });
  const sessionId = newSortableId("sess");
  const oldRunId = newSortableId("run");
  const activeRunId = newSortableId("run");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "P4 late idle state fence session",
    kind: "primary",
    createdAt
  });
  createRunningRun({ fixture, workspaceId: workspace.id, sessionId, runId: oldRunId, activeRunId, createdAt });
  createRunRecord(fixture.db, {
    runId: activeRunId,
    workspaceId: workspace.id,
    sessionId,
    triggerItemId: 0,
    agentId: "default",
    providerId: "p4-provider",
    modelId: "p4-model",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null,
    status: "running",
    createdAt: createdAt + 1
  });

  const service = new AgentService(fixture.ctx, fixture.app.log);
  service.updateRunStateFromWorker({
    workspaceId: workspace.id,
    sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: createdAt + 2
  });

  const state = getRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state.status, "running");
  assert.equal(state.activeRunId, activeRunId);
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
});
