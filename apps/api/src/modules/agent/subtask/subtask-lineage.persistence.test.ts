import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { newSortableId } from "../../../utils/ids.js";
import { AgentService } from "../agent.service.js";
import { SqliteSubtaskLineagePersistence } from "./sqlite-subtask-lineage-persistence.js";
import { SqliteSubtaskMaintenancePersistence } from "./sqlite-subtask-maintenance-persistence.js";
import {
  appendContextItem,
  createAgentSession,
  createRunRecord,
  findSubtaskRunByParentTool,
  getAgentSession,
  listSubtaskChildSessionIdsByRunId,
} from "../agent.store.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  type AgentTestFixture,
} from "../testkit/agent-testkit.js";

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
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Subtask persistence fixture cleanup failed",
    );
});

async function createFixture() {
  const fixture = await createAgentTestFixture({ agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, {
    title: "P1 subtask persistence",
  });
  return { fixture, workspace };
}

function createSession(params: {
  fixture: AgentTestFixture;
  workspaceId: string;
  id?: string;
  kind: "primary" | "subtask";
  createdAt?: number;
  forkedFromSessionId?: string | null;
  forkedFromItemId?: number | null;
}) {
  const id = params.id ?? newSortableId("sess");
  createAgentSession(params.fixture.db, {
    id,
    workspaceId: params.workspaceId,
    title: `P1 ${params.kind} ${id}`,
    kind: params.kind,
    createdAt: params.createdAt ?? Date.now(),
    forkedFromSessionId: params.forkedFromSessionId ?? null,
    forkedFromItemId: params.forkedFromItemId ?? null,
  });
  return id;
}

function createRun(params: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  runId?: string;
  parentRunId?: string | null;
  parentToolItemId?: number | null;
  status?: "running" | "completed" | "failed" | "cancelled";
}) {
  const runId = params.runId ?? newSortableId("run");
  createRunRecord(params.fixture.db, {
    runId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    triggerItemId: 0,
    agentId: "default",
    providerId: "p1-provider",
    modelId: "p1-model",
    subtaskDepth: params.parentRunId ? 1 : 0,
    parentRunId: params.parentRunId ?? null,
    parentToolItemId: params.parentToolItemId ?? null,
    status: params.status ?? "running",
    createdAt: Date.now(),
  });
  return runId;
}

function appendItem(params: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  prevId: number | null;
  kind: "user" | "assistant" | "tool" | "system";
  output: Parameters<typeof appendContextItem>[1]["output"];
}) {
  return appendContextItem(params.fixture.db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    turnId: null,
    step: null,
    prevId: params.prevId,
    kind: params.kind,
    status: "completed",
    output: params.output,
    createdAt: Date.now(),
  });
}

test("P1 real SQLite: durable child lookup and cancel query use the actual subtask parent tool", async () => {
  const { fixture, workspace } = await createFixture();
  const parentSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "primary",
  });
  const parentRunId = createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
  });
  const user = appendItem({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
    runId: parentRunId,
    prevId: null,
    kind: "user",
    output: { type: "user_text", text: "parent" },
  });
  const validTool = appendItem({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
    runId: parentRunId,
    prevId: user.id,
    kind: "tool",
    output: {
      type: "tool",
      toolName: "subtask",
      args: { description: "child" },
    },
  });
  const nonSubtaskTool = appendItem({
    fixture,
    workspaceId: workspace.id,
    sessionId: parentSessionId,
    runId: parentRunId,
    prevId: validTool.id,
    kind: "tool",
    output: { type: "tool", toolName: "bash", args: { command: "pwd" } },
  });

  const validChildSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  const invalidChildSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  const validChildRunId = createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId: validChildSessionId,
    parentRunId,
    parentToolItemId: validTool.id,
  });
  createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId: invalidChildSessionId,
    parentRunId,
    parentToolItemId: nonSubtaskTool.id,
  });

  assert.equal(
    findSubtaskRunByParentTool(fixture.db, {
      workspaceId: workspace.id,
      parentRunId,
      parentToolItemId: validTool.id,
    })?.runId,
    validChildRunId,
  );
  assert.deepEqual(
    listSubtaskChildSessionIdsByRunId(fixture.db, {
      workspaceId: workspace.id,
      sessionId: parentSessionId,
      runId: parentRunId,
    }),
    [validChildSessionId],
  );
});

test("P1 real SQLite: partial unique index is the parent-tool arbiter and classifier stays narrow", async () => {
  const { fixture, workspace } = await createFixture();
  const parentRunId = newSortableId("run-parent");
  const childOneSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  const childTwoSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId: childOneSessionId,
    parentRunId,
    parentToolItemId: 41,
  });

  let conflict: unknown;
  try {
    createRun({
      fixture,
      workspaceId: workspace.id,
      sessionId: childTwoSessionId,
      parentRunId,
      parentToolItemId: 41,
    });
  } catch (error) {
    conflict = error;
  }
  assert.ok(
    conflict,
    "the real SQLite partial unique index must reject a second parent-tool child",
  );
  assert.equal(
    new SqliteSubtaskLineagePersistence(fixture.db).isParentToolUniqueConflict(
      conflict,
    ),
    true,
  );
  assert.equal(
    new SqliteSubtaskLineagePersistence(fixture.db).isParentToolUniqueConflict({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: other_table.value",
    }),
    false,
  );

  createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId: childTwoSessionId,
    parentRunId,
    parentToolItemId: null,
  });
  assert.equal(
    findSubtaskRunByParentTool(fixture.db, {
      workspaceId: workspace.id,
      parentRunId,
      parentToolItemId: 42,
    }),
    null,
  );
});

test("P5 real SQLite: maintenance adapter keeps orphan candidates and final delete fences conservative", async () => {
  const { fixture, workspace } = await createFixture();
  const now = Date.now();
  const olderThan = now - 24 * 60 * 60 * 1000;
  const maintenance = new SqliteSubtaskMaintenancePersistence(fixture.db);

  const emptyLocalSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  assert.equal(
    maintenance.deleteNewSessionIfStillEmpty({ workspaceId: workspace.id, sessionId: emptyLocalSessionId }),
    true,
  );
  assert.equal(getAgentSession(fixture.db, emptyLocalSessionId), null);

  const populatedLocalSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  appendItem({
    fixture,
    workspaceId: workspace.id,
    sessionId: populatedLocalSessionId,
    runId: null,
    prevId: null,
    kind: "system",
    output: { type: "system_text", text: "must retain" },
  });
  assert.equal(
    maintenance.deleteNewSessionIfStillEmpty({ workspaceId: workspace.id, sessionId: populatedLocalSessionId }),
    false,
  );
  assert.ok(getAgentSession(fixture.db, populatedLocalSessionId));

  const oldForkSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
    createdAt: olderThan - 1,
    forkedFromSessionId: "parent-session",
    forkedFromItemId: 7,
  });
  const oldNoForkSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
    createdAt: olderThan - 1,
  });
  const youngForkSessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
    createdAt: olderThan + 1,
    forkedFromSessionId: "parent-session",
    forkedFromItemId: 8,
  });
  const oldPrimarySessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "primary",
    createdAt: olderThan - 1,
    forkedFromSessionId: "parent-session",
    forkedFromItemId: 9,
  });

  assert.deepEqual(
    maintenance.listSuspects({ olderThan }).map(
      (candidate) => candidate.sessionId,
    ),
    [oldForkSessionId, oldNoForkSessionId],
  );
  assert.ok(getAgentSession(fixture.db, oldPrimarySessionId));
  assert.equal(
    maintenance.deleteSuspectIfStillEligible({
      workspaceId: workspace.id,
      sessionId: oldNoForkSessionId,
      olderThan,
    }),
    false,
  );
  assert.equal(
    maintenance.deleteSuspectIfStillEligible({
      workspaceId: workspace.id,
      sessionId: youngForkSessionId,
      olderThan,
    }),
    false,
  );
  assert.equal(
    maintenance.deleteSuspectIfStillEligible({
      workspaceId: workspace.id,
      sessionId: oldForkSessionId,
      olderThan,
    }),
    true,
  );
  assert.equal(
    maintenance.deleteSuspectIfStillEligible({
      workspaceId: workspace.id,
      sessionId: oldForkSessionId,
      olderThan,
    }),
    false,
  );
});

test("P1 real SQLite: result and status are fenced by workspace/session ownership and result only projects the requested run", async () => {
  const { fixture, workspace } = await createFixture();
  const sessionId = createSession({
    fixture,
    workspaceId: workspace.id,
    kind: "subtask",
  });
  const targetRunId = createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId,
    status: "failed",
  });
  const otherRunId = createRun({
    fixture,
    workspaceId: workspace.id,
    sessionId,
    status: "completed",
  });
  const targetAssistant = appendItem({
    fixture,
    workspaceId: workspace.id,
    sessionId,
    runId: targetRunId,
    prevId: null,
    kind: "assistant",
    output: { type: "assistant_text", text: "target partial" },
  });
  appendItem({
    fixture,
    workspaceId: workspace.id,
    sessionId,
    runId: otherRunId,
    prevId: targetAssistant.id,
    kind: "assistant",
    output: { type: "assistant_text", text: "other run must not leak" },
  });

  const service = new AgentService(fixture.ctx, {
    warn() {},
    error() {},
  } as never);
  assert.deepEqual(
    service.getSubtaskRunStatusFromWorker({
      workspaceId: workspace.id,
      sessionId,
      runId: targetRunId,
    }),
    { status: "failed" },
  );
  assert.deepEqual(
    service.getSubtaskRunResultFromWorker({
      workspaceId: workspace.id,
      sessionId,
      runId: targetRunId,
    }),
    { resultText: "target partial" },
  );
  assert.throws(
    () =>
      service.getSubtaskRunStatusFromWorker({
        workspaceId: workspace.id,
        sessionId: "wrong-session",
        runId: targetRunId,
      }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404,
  );
});
