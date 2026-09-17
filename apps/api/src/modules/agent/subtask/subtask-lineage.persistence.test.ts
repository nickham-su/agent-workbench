import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { newSortableId } from "../../../utils/ids.js";
import { createMessageRunRecord } from "../agent-message.store.js";
import { appendMessage, appendStreamingAssistant, completeAssistantWithExecutions, createMessageSession, flushStreamingParts, getMessageRunState, getMessageSession, startMessageRun } from "../agent-message.store.js";
import { SqliteSubtaskLineagePersistence } from "./sqlite-subtask-lineage-persistence.js";
import { SqliteSubtaskMaintenancePersistence } from "./sqlite-subtask-maintenance-persistence.js";
import { SqliteSubtaskRunQuery } from "./sqlite-subtask-run-query.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  type AgentTestFixture,
} from "../testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function createFixture() {
  const fixture = await createAgentTestFixture({ agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, { title: "P1 subtask persistence" });
  return { fixture, workspace };
}

function createSession(input: {
  fixture: AgentTestFixture;
  workspaceId: string;
  id?: string;
  kind: "primary" | "subtask";
  createdAt?: number;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
}) {
  const id = input.id ?? newSortableId("sess");
  createMessageSession(input.fixture.db, {
    id,
    workspaceId: input.workspaceId,
    title: `P1 ${input.kind} ${id}`,
    kind: input.kind,
    createdAt: input.createdAt ?? Date.now(),
    forkedFromSessionId: input.forkedFromSessionId ?? null,
    forkedFromMessageId: input.forkedFromMessageId ?? null,
  });
  return id;
}

function appendText(input: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  id?: string;
  type: "user" | "system" | "assistant";
  text: string;
  originRunId?: string | null;
  createdAt?: number;
}) {
  const id = input.id ?? newSortableId("msg");
  const session = getMessageSession(input.fixture.db, input.workspaceId, input.sessionId);
  if (!session) throw new Error("test session missing");
  return appendMessage(input.fixture.db, {
    id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    expectedHeadMessageId: session.headMessageId,
    expectedRevision: session.revision,
    type: input.type,
    status: "completed",
    originRunId: input.originRunId ?? null,
    parts: [{ id: `${id}-part`, position: 0, type: "text", text: input.text }],
    createdAt: input.createdAt ?? Date.now(),
  });
}

function createRun(input: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  runId?: string;
  parentRunId?: string | null;
  parentToolExecutionId?: string | null;
  status?: "running" | "completed" | "failed" | "cancelled";
}) {
  const runId = input.runId ?? newSortableId("run");
  const trigger = appendText({
    fixture: input.fixture,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    type: "user",
    text: `trigger ${runId}`,
  });
  createMessageRunRecord(input.fixture.db, {
    runId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    triggerMessageId: trigger.id,
    agentId: "default",
    providerId: "p1-provider",
    modelId: "p1-model",
    subtaskDepth: input.parentRunId ? 1 : 0,
    parentRunId: input.parentRunId ?? null,
    parentToolExecutionId: input.parentToolExecutionId ?? null,
    status: input.status ?? "running",
    createdAt: Date.now(),
  });
  return { runId, triggerMessageId: trigger.id };
}

function createParentSubtaskExecution(input: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const session = getMessageSession(input.fixture.db, input.workspaceId, input.sessionId);
  if (!session) throw new Error("parent session missing");
  startMessageRun(input.fixture.db, { workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId, updatedAt: Date.now() });
  const assistant = appendStreamingAssistant(input.fixture.db, {
    id: newSortableId("assistant"), workspaceId: input.workspaceId, sessionId: input.sessionId,
    runId: input.runId, expectedHeadMessageId: session.headMessageId, expectedRevision: session.revision, createdAt: Date.now(),
  });
  const callPartId = newSortableId("part");
  const executionId = newSortableId("execution");
  flushStreamingParts(input.fixture.db, {
    workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId, messageId: assistant.id,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "subtask", input: {} }], updatedAt: Date.now(),
  });
  completeAssistantWithExecutions(input.fixture.db, {
    workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId, messageId: assistant.id,
    executions: [{ id: executionId, callPartId, originSessionId: input.sessionId, originRunId: input.runId, status: "queued" }], updatedAt: Date.now(),
  });
  return executionId;
}

test("P1 real SQLite: durable child lookup and active-child query use Message-model parent execution lineage", async () => {
  const { fixture, workspace } = await createFixture();
  const parentSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "primary" });
  const { runId: parentRunId } = createRun({ fixture, workspaceId: workspace.id, sessionId: parentSessionId });
  const executionId = createParentSubtaskExecution({ fixture, workspaceId: workspace.id, sessionId: parentSessionId, runId: parentRunId });
  const childSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  const { runId: childRunId } = createRun({
    fixture, workspaceId: workspace.id, sessionId: childSessionId, parentRunId,
    parentToolExecutionId: executionId, status: "running",
  });
  const otherChildSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  createRun({
    fixture, workspaceId: workspace.id, sessionId: otherChildSessionId, parentRunId,
    parentToolExecutionId: null, status: "completed",
  });

  const lineage = new SqliteSubtaskLineagePersistence(fixture.db);
  assert.equal(
    lineage.findChildByParentToolExecution({
      workspaceId: workspace.id, parentRunId, parentToolExecutionId: executionId,
    })?.runId,
    childRunId,
  );
  assert.deepEqual(
    lineage.listByParentRun({ workspaceId: workspace.id, sessionId: parentSessionId, runId: parentRunId }),
    [childSessionId],
  );
});

test("P1 real SQLite: partial unique index is the parent execution arbiter and exact lookup finds the winner", async () => {
  const { fixture, workspace } = await createFixture();
  const parentSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "primary" });
  const { runId: parentRunId } = createRun({ fixture, workspaceId: workspace.id, sessionId: parentSessionId });
  const executionId = createParentSubtaskExecution({ fixture, workspaceId: workspace.id, sessionId: parentSessionId, runId: parentRunId });
  const winnerSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  const loserSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  createRun({
    fixture, workspaceId: workspace.id, sessionId: winnerSessionId, parentRunId,
    parentToolExecutionId: executionId,
  });
  assert.throws(() => createRun({
    fixture, workspaceId: workspace.id, sessionId: loserSessionId, parentRunId,
    parentToolExecutionId: executionId,
  }));
  assert.equal(
    new SqliteSubtaskLineagePersistence(fixture.db).findChildByParentToolExecution({
      workspaceId: workspace.id, parentRunId, parentToolExecutionId: executionId,
    })?.sessionId,
    winnerSessionId,
  );
});

test("P5 real SQLite: maintenance adapter keeps Message-populated and orphan fences conservative", async () => {
  const { fixture, workspace } = await createFixture();
  const now = Date.now();
  const olderThan = now - 24 * 60 * 60 * 1000;
  const maintenance = new SqliteSubtaskMaintenancePersistence(fixture.db);
  const compensationParentSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "primary",
  });
  const emptySessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  assert.equal(maintenance.deleteCreatedSessionIfStillSafe({
    workspaceId: workspace.id,
    createdSessionId: emptySessionId,
    expectedParentSessionId: compensationParentSessionId,
    expectedForkedFromSessionId: null,
    expectedForkedFromMessageId: null,
  }), true);

  const populatedSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  appendText({ fixture, workspaceId: workspace.id, sessionId: populatedSessionId, type: "system", text: "must retain" });
  assert.equal(maintenance.deleteCreatedSessionIfStillSafe({
    workspaceId: workspace.id,
    createdSessionId: populatedSessionId,
    expectedParentSessionId: compensationParentSessionId,
    expectedForkedFromSessionId: null,
    expectedForkedFromMessageId: null,
  }), false);

  const parentSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "primary" });
  const parentMessage = appendText({ fixture, workspaceId: workspace.id, sessionId: parentSessionId, type: "user", text: "parent" });
  const oldForkSessionId = createSession({
    fixture, workspaceId: workspace.id, kind: "subtask", createdAt: olderThan - 1,
    forkedFromSessionId: parentSessionId, forkedFromMessageId: parentMessage.id,
  });
  const oldNoForkSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask", createdAt: olderThan - 1 });
  const youngForkSessionId = createSession({
    fixture, workspaceId: workspace.id, kind: "subtask", createdAt: olderThan + 1,
    forkedFromSessionId: parentSessionId, forkedFromMessageId: parentMessage.id,
  });

  assert.deepEqual(
    maintenance.listSuspects({ olderThan }).map((candidate) => candidate.sessionId),
    [oldForkSessionId, oldNoForkSessionId],
  );
  assert.equal(maintenance.deleteSuspectIfStillEligible({ workspaceId: workspace.id, sessionId: oldNoForkSessionId, olderThan }), false);
  assert.equal(maintenance.deleteSuspectIfStillEligible({ workspaceId: workspace.id, sessionId: youngForkSessionId, olderThan }), false);
  assert.equal(maintenance.deleteSuspectIfStillEligible({ workspaceId: workspace.id, sessionId: oldForkSessionId, olderThan }), true);
});

test("M9 real SQLite: compensation deletes a request-owned fork with a shared head but preserves the shared graph", async () => {
  const { fixture, workspace } = await createFixture();
  const maintenance = new SqliteSubtaskMaintenancePersistence(fixture.db);
  const parentSessionId = createSession({ fixture, workspaceId: workspace.id, kind: "primary" });
  const sharedMessage = appendText({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
    type: "user",
    text: "shared parent history",
  });
  const { runId: parentRunId } = createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
  });
  createParentSubtaskExecution({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
    runId: parentRunId,
  });
  const childSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
    forkedFromSessionId: parentSessionId,
    forkedFromMessageId: sharedMessage.id,
  });
  fixture.db.prepare(`
    update agent_session
    set head_message_id = ?, context_root_message_id = ?
    where id = ? and workspace_id = ?
  `).run(sharedMessage.id, sharedMessage.id, childSessionId, workspace.id);
  const before = fixture.db.prepare(`
    select
      (select count(*) from agent_message where workspace_id = ? and origin_session_id = ?) as messages,
      (select count(*) from agent_message_part part join agent_message message on message.id = part.message_id where message.workspace_id = ? and message.origin_session_id = ?) as parts,
      (select count(*) from agent_tool_execution where origin_session_id = ?) as executions
  `).get(workspace.id, parentSessionId, workspace.id, parentSessionId, parentSessionId) as {
    messages: number;
    parts: number;
    executions: number;
  };

  assert.equal(maintenance.deleteCreatedSessionIfStillSafe({
    workspaceId: workspace.id,
    createdSessionId: childSessionId,
    expectedParentSessionId: "wrong-parent",
    expectedForkedFromSessionId: parentSessionId,
    expectedForkedFromMessageId: sharedMessage.id,
  }), false);
  assert.ok(getMessageSession(fixture.db, workspace.id, childSessionId));
  assert.equal(maintenance.deleteCreatedSessionIfStillSafe({
    workspaceId: workspace.id,
    createdSessionId: childSessionId,
    expectedParentSessionId: parentSessionId,
    expectedForkedFromSessionId: parentSessionId,
    expectedForkedFromMessageId: sharedMessage.id,
  }), true);
  assert.equal(getMessageSession(fixture.db, workspace.id, childSessionId), null);
  assert.equal(getMessageRunState(fixture.db, workspace.id, childSessionId), null);
  assert.deepEqual(
    fixture.db.prepare(`
      select
        (select count(*) from agent_message where workspace_id = ? and origin_session_id = ?) as messages,
        (select count(*) from agent_message_part part join agent_message message on message.id = part.message_id where message.workspace_id = ? and message.origin_session_id = ?) as parts,
        (select count(*) from agent_tool_execution where origin_session_id = ?) as executions
    `).get(workspace.id, parentSessionId, workspace.id, parentSessionId, parentSessionId),
    before,
  );
  assert.ok(fixture.db.prepare("select 1 from agent_message where id = ?").get(sharedMessage.id));
});

test("P1 real SQLite: result/status are ownership-fenced and result only projects the requested Message Run", async () => {
  const { fixture, workspace } = await createFixture();
  const sessionId = createSession({ fixture, workspaceId: workspace.id, kind: "subtask" });
  const target = createRun({ fixture, workspaceId: workspace.id, sessionId, status: "failed" });
  appendText({
    fixture, workspaceId: workspace.id, sessionId, type: "assistant", text: "target partial",
    originRunId: target.runId,
  });
  const other = createRun({ fixture, workspaceId: workspace.id, sessionId, status: "completed" });
  appendText({
    fixture, workspaceId: workspace.id, sessionId, type: "assistant", text: "other run must not leak",
    originRunId: other.runId,
  });

  const query = new SqliteSubtaskRunQuery(fixture.db);
  assert.equal(
    query.findRunInSession({ workspaceId: workspace.id, sessionId, runId: target.runId })?.status,
    "failed",
  );
  assert.deepEqual(
    query.listMessageTextsByRun({ workspaceId: workspace.id, sessionId, runId: target.runId }),
    [{ type: "assistant", text: "target partial" }],
  );
  assert.equal(query.findRunInSession({ workspaceId: workspace.id, sessionId: "wrong-session", runId: target.runId }), null);
  assert.throws(() => {
    if (!query.findRunInSession({ workspaceId: workspace.id, sessionId: "wrong-session", runId: target.runId })) {
      throw new HttpError(404, "run not found");
    }
  }, (error: unknown) => error instanceof HttpError && error.statusCode === 404);
});
