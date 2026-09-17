import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { newSortableId } from "../../../utils/ids.js";
import { createMessageRunRecord, getRunRecord } from "../agent-message.store.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  createMessageSession,
  flushStreamingParts,
  getMessageRunState,
  getMessageSession,
  startMessageRun,
  updateToolExecution,
} from "../agent-message.store.js";
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
  createMessageSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "child",
    kind: "subtask",
    createdAt: 100,
    forkedFromSessionId: null,
    forkedFromMessageId: null,
  });
  createMessageSession(fixture.db, {
    id: "parent-session",
    workspaceId: workspace.id,
    title: "parent",
    kind: "primary",
    createdAt: 90,
  });
  appendMessage(fixture.db, { id: "parent-user", workspaceId: workspace.id, sessionId: "parent-session", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "parent-user-text", position: 0, type: "text", text: "parent" }], createdAt: 91 });
  createMessageRunRecord(fixture.db, { runId: "parent-run", workspaceId: workspace.id, sessionId: "parent-session", triggerMessageId: "parent-user", agentId: "agent", providerId: "provider", modelId: "model", subtaskDepth: 0, status: "running", createdAt: 92 });
  startMessageRun(fixture.db, { workspaceId: workspace.id, sessionId: "parent-session", runId: "parent-run", updatedAt: 92 });
  appendStreamingAssistant(fixture.db, { id: "parent-assistant", workspaceId: workspace.id, sessionId: "parent-session", runId: "parent-run", expectedHeadMessageId: "parent-user", expectedRevision: 1, createdAt: 93 });
  flushStreamingParts(fixture.db, { workspaceId: workspace.id, sessionId: "parent-session", runId: "parent-run", messageId: "parent-assistant", parts: [{ id: "parent-call", position: 0, type: "tool_call", toolName: "subtask", input: {} }], updatedAt: 94 });
  completeAssistantWithExecutions(fixture.db, { workspaceId: workspace.id, sessionId: "parent-session", runId: "parent-run", messageId: "parent-assistant", executions: [{ id: "parent-execution", callPartId: "parent-call", originSessionId: "parent-session", originRunId: "parent-run", status: "queued" }], updatedAt: 95 });
  assert.equal(updateToolExecution(fixture.db, { workspaceId: workspace.id, sessionId: "parent-session", runId: "parent-run", executionId: "parent-execution", status: "running", updatedAt: 96 }), "updated");
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
    parentToolExecutionId: "parent-execution",
    subtaskDepth: 2,
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    uiLocale: "zh-CN" as const,
    createdAt: 200,
    systemTexts: ["summary", "guard"],
    prompt: "prompt",
  };
}

test("P3 real SQLite: Lifecycle child activator atomically persists ordered Message seeds, lineage and active run state", async () => {
  const { fixture, workspace, sessionId } = await createIdleSubtaskSession();
  const activation = new SqliteRunLifecyclePersistence(fixture.db);
  const child = input(workspace.id, sessionId);

  const result = activation.activate(child);
  assert.equal(result.kind, "activated");
  if (result.kind !== "activated") return;

  const messages = fixture.db.prepare(`
    select message.id, message.type, message.origin_run_id as originRunId, part.text
    from agent_message message
    join agent_message_part part on part.message_id = message.id
    where message.workspace_id = ?
      and message.origin_session_id = ?
    order by message.depth asc, part.position asc
  `).all(workspace.id, sessionId) as Array<{
    id: string;
    type: string;
    originRunId: string | null;
    text: string;
  }>;
  assert.deepEqual(
    messages.map((message) => [message.type, message.originRunId, message.text]),
    [
      ["system", null, "summary"],
      ["system", null, "guard"],
      ["user", null, "prompt"],
    ],
  );
  assert.equal(result.promptMessageId, messages[2]?.id);
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.triggerMessageId,
    result.promptMessageId,
  );
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.parentRunId,
    child.parentRunId,
  );
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.parentToolExecutionId,
    child.parentToolExecutionId,
  );
  assert.equal(
    getRunRecord(fixture.db, child.runId)?.subtaskDepth,
    child.subtaskDepth,
  );
  const state = getMessageRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state?.status, "running");
  assert.equal(state?.activeRunId, child.runId);
  assert.equal(state?.activeAssistantMessageId, null);
  assert.deepEqual(state?.nonTerminalMessageIds, []);
  assert.deepEqual(state?.nonTerminalToolExecutionIds, []);
});

test("H4 real SQLite: parent cancellation before child activation returns typed conflict without child graph or recovery candidate", async () => {
  const { fixture, workspace, sessionId } = await createIdleSubtaskSession();
  const activation = new SqliteRunLifecyclePersistence(fixture.db);
  const cancelled = activation.cancelSessions({
    workspaceId: workspace.id,
    rootSessionId: "parent-session",
    updatedAt: 150,
    listActiveChildSessionIds: () => [],
  });
  assert.deepEqual(cancelled.runtimeCancelSessionIds, ["parent-session"]);

  const result = activation.activate(input(workspace.id, sessionId, "run-h4-cancelled-parent"));
  assert.deepEqual(result, { kind: "parent-not-active" });
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where origin_session_id = ?").get(sessionId) as { count: number }).count, 0);
  assert.equal(getRunRecord(fixture.db, "run-h4-cancelled-parent"), null);
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "idle");
  assert.deepEqual(activation.listRecoverableRunCandidates().filter((candidate) => candidate.sessionId === sessionId), []);
});

test("H4 real SQLite: child committed before parent cancel is discovered through lineage and converged", async () => {
  const { fixture, workspace, sessionId } = await createIdleSubtaskSession();
  const activation = new SqliteRunLifecyclePersistence(fixture.db);
  const child = input(workspace.id, sessionId, "run-h4-child-first");
  assert.equal(activation.activate(child).kind, "activated");

  const cancelled = activation.cancelSessions({
    workspaceId: workspace.id,
    rootSessionId: "parent-session",
    updatedAt: 210,
    listActiveChildSessionIds: ({ workspaceId: currentWorkspaceId, runId }) => {
      if (currentWorkspaceId !== workspace.id || runId !== "parent-run") return [];
      return [sessionId];
    },
  });
  assert.deepEqual(new Set(cancelled.runtimeCancelSessionIds), new Set(["parent-session", sessionId]));
  assert.equal(getRunRecord(fixture.db, child.runId)?.status, "cancelled");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "idle");
  assert.deepEqual(activation.listRecoverableRunCandidates().filter((candidate) => candidate.sessionId === sessionId), []);
});

test("P3 real SQLite: child activator repeats the final idle fence and rolls back all Message writes on failure", async () => {
  const { fixture, workspace, sessionId } = await createIdleSubtaskSession();
  const activation = new SqliteRunLifecyclePersistence(fixture.db);
  fixture.db.prepare(`
    update session_run_state
    set status = 'running', active_run_id = null, updated_at = 150
    where workspace_id = ? and session_id = ?
  `).run(workspace.id, sessionId);
  const fenced = activation.activate(input(workspace.id, sessionId));
  assert.deepEqual(fenced, { kind: "session-running" });
  assert.equal(
    (fixture.db.prepare("select count(*) as count from agent_message where workspace_id = ? and origin_session_id = ?").get(workspace.id, sessionId) as { count: number }).count,
    0,
  );

  fixture.db.prepare(`
    update session_run_state
    set status = 'idle', active_run_id = null, updated_at = 160
    where workspace_id = ? and session_id = ?
  `).run(workspace.id, sessionId);
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
    (fixture.db.prepare("select count(*) as count from agent_message where workspace_id = ? and origin_session_id = ?").get(workspace.id, sessionId) as { count: number }).count,
    0,
  );
  assert.equal(getRunRecord(fixture.db, failed.runId), null);
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "idle");
  assert.equal(getMessageSession(fixture.db, workspace.id, sessionId)?.headMessageId, null);
});
