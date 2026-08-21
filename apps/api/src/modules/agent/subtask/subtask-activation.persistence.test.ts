import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { newSortableId } from "../../../utils/ids.js";
import {
  createAgentSession,
  getRunRecord,
  getRunState,
  getSessionTranscriptItems,
  updateRunState,
} from "../agent.store.js";
import { SqliteRunLifecyclePersistence } from "../lifecycle/sqlite-run-lifecycle-persistence.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  type AgentTestFixture,
} from "../testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function createIdleSubtaskSession() {
  const fixture = await createAgentTestFixture({ agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, {
    title: "P3 child activation",
  });
  const sessionId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "child",
    kind: "subtask",
    createdAt: 100,
    forkedFromSessionId: null,
    forkedFromItemId: null,
  });
  return { fixture, workspace, sessionId };
}

function input(
  workspaceId: string,
  sessionId: string,
  runId = newSortableId("run"),
) {
  return {
    workspaceId,
    sessionId,
    runId,
    parentRunId: "parent-run",
    parentToolItemId: 7,
    subtaskDepth: 2,
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    uiLocale: "zh-CN" as const,
    createdAt: 200,
    seedItems: [
      { kind: "system" as const, text: "summary", attachToRun: false as const },
      { kind: "system" as const, text: "guard", attachToRun: false as const },
      { kind: "user" as const, text: "prompt", attachToRun: true as const },
    ],
  };
}

test("P3 real SQLite: Lifecycle child activator atomically persists ordered seeds, lineage and active run state", async () => {
  const { fixture, workspace, sessionId } = await createIdleSubtaskSession();
  const activation = new SqliteRunLifecyclePersistence(fixture.db);
  const child = input(workspace.id, sessionId);

  const result = activation.activate(child);
  assert.equal(result.kind, "activated");
  if (result.kind !== "activated") return;

  const items = getSessionTranscriptItems(fixture.db, workspace.id, sessionId);
  assert.deepEqual(
    items.map((item) => [
      item.kind,
      item.runId,
      (item.output as { text?: string }).text,
    ]),
    [
      ["system", null, "summary"],
      ["system", null, "guard"],
      ["user", child.runId, "prompt"],
    ],
  );
  assert.equal(result.promptItemId, items[2]?.id);
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.triggerItemId,
    result.promptItemId,
  );
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.parentRunId,
    child.parentRunId,
  );
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.parentToolItemId,
    child.parentToolItemId,
  );
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.subtaskDepth,
    child.subtaskDepth,
  );
  const state = getRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state.status, "running");
  assert.equal(state.activeRunId, child.runId);
  assert.equal(state.appliedItemId, result.promptItemId);
});

test("P3 real SQLite: child activator repeats the final idle fence and rolls back all seed writes on failure", async () => {
  const { fixture, workspace, sessionId } = await createIdleSubtaskSession();
  const activation = new SqliteRunLifecyclePersistence(fixture.db);
  updateRunState(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    status: "running",
    activeRunId: "other-run",
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: 150,
    appliedItemId: 0,
  });
  const fenced = activation.activate(input(workspace.id, sessionId));
  assert.deepEqual(fenced, { kind: "session-running" });
  assert.equal(
    getSessionTranscriptItems(fixture.db, workspace.id, sessionId).length,
    0,
  );

  updateRunState(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: 160,
    appliedItemId: 0,
  });
  const failed = input(workspace.id, sessionId, "run-p3-rollback");
  fixture.db.exec(`
    create trigger fail_p3_child_run
    before insert on agent_run
    when new.run_id = '${failed.runId}'
    begin
      select raise(abort, 'injected P3 child activation failure');
    end;
  `);
  assert.throws(
    () => activation.activate(failed),
    /injected P3 child activation failure/,
  );
  assert.equal(
    getSessionTranscriptItems(fixture.db, workspace.id, sessionId).length,
    0,
  );
  assert.equal(getRunRecord(fixture.db, failed.runId), null);
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).status, "idle");
});
