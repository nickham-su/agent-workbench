import { createAgentService } from "../agent.composition.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  createMessageRunRecord,
  findMessageSubtaskRunByParentToolExecution,
  getLatestMessageRunRecordBySession,
  getLatestTerminalMessageRunRecord,
  getRunRecord
} from "../agent-message.store.js";
import {
  appendMessage,
  createMessageSession,
  getMessageRunState,
  getMessageSession,
  getMessageSessionHead
} from "../agent-message.store.js";
import { SqliteRunLifecyclePersistence } from "../lifecycle/sqlite-run-lifecycle-persistence.js";
import { SqliteSubtaskMaintenancePersistence } from "../subtask/sqlite-subtask-maintenance-persistence.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  closeP2Fixture,
  createMessageRunForTest,
  createP2Fixture,
  createSession,
  createSubtaskAnchor,
  createSubtaskSessionForTest,
  sendMessage,
  startSubtaskForAnchor
} from "./subtask.helpers.js";

function createStandaloneSession(params: {
  fixture: Awaited<ReturnType<typeof createP2Fixture>>;
  sessionId: string;
  kind?: "primary" | "subtask";
  createdAt?: number;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
}) {
  createMessageSession(params.fixture.db, {
    id: params.sessionId,
    workspaceId: params.fixture.workspaceId,
    title: params.sessionId,
    kind: params.kind ?? "primary",
    createdAt: params.createdAt ?? Date.now(),
    forkedFromSessionId: params.forkedFromSessionId ?? null,
    forkedFromMessageId: params.forkedFromMessageId ?? null
  });
}

function appendTriggerMessage(params: {
  fixture: Awaited<ReturnType<typeof createP2Fixture>>;
  sessionId: string;
  messageId?: string;
  createdAt?: number;
}) {
  const createdAt = params.createdAt ?? Date.now();
  const head = getMessageSessionHead(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId
  });
  assert.ok(head, "测试会话必须存在");
  const messageId = params.messageId ?? newSortableId("msg");
  appendMessage(params.fixture.db, {
    id: messageId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "test trigger" }],
    createdAt
  });
  return messageId;
}

test("agent run mapper 对 SQLite 弱类型 lineage 值 fail-closed", async (t: TestContext) => {
  const fixture = await createP2Fixture(t);
  try {
    const childSession = createSubtaskSessionForTest(fixture, { title: "run-mapper" });
    const childRun = createMessageRunForTest({
      fixture,
      sessionId: childSession.id,
      status: "completed",
      subtaskDepth: 1
    });
    fixture.db.prepare("update agent_run set subtask_depth = ? where run_id = ?")
      .run("not-a-number", childRun.runId);

    const record = getRunRecord(fixture.db, childRun.runId);
    assert.equal(record?.subtaskDepth, null);
    assert.equal(record?.parentToolExecutionId, null);
    assert.equal(record?.parentRunId, null);
    assert.equal(getLatestTerminalMessageRunRecord(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: childSession.id
    })?.subtaskDepth, null);
    assert.equal(getLatestMessageRunRecordBySession(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: childSession.id
    })?.parentToolExecutionId, null);
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("primary 普通继续会重置 depth 和 parent 字段，即使最近 run 尚未 terminal", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();
  const terminalTriggerMessageId = appendTriggerMessage({ fixture, sessionId: session.id, createdAt });
  createMessageRunRecord(fixture.db, {
    runId: "run_terminal_depth_0",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerMessageId: terminalTriggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolExecutionId: null,
    status: "completed",
    createdAt
  });
  const runningTriggerMessageId = appendTriggerMessage({ fixture, sessionId: session.id, createdAt: createdAt + 1 });
  createMessageRunRecord(fixture.db, {
    runId: "run_running_depth_2",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerMessageId: runningTriggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 2,
    parentRunId: null,
    parentToolExecutionId: null,
    status: "running",
    createdAt: createdAt + 1
  });
  const next = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "continue from latest run",
    clientRequestId: "latest-actual-run-depth"
  });
  const nextRun = getRunRecord(fixture.db, next.runId);
  assert.equal(nextRun?.subtaskDepth, 0);
  assert.equal(nextRun?.parentRunId, null);
  assert.equal(nextRun?.parentToolExecutionId, null);
});

test("primary latest Run depth 为 null 时，下一条消息自愈为独立执行根", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();
  const triggerMessageId = appendTriggerMessage({ fixture, sessionId: session.id, createdAt });
  createMessageRunRecord(fixture.db, {
    runId: "run_latest_depth_unknown",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: null,
    parentToolExecutionId: null,
    status: "completed",
    createdAt
  });

  const next = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "recover from unknown latest depth",
    clientRequestId: "latest-null-depth-recovery"
  });
  const nextRun = getRunRecord(fixture.db, next.runId);
  assert.equal(nextRun?.subtaskDepth, 0);
  assert.equal(nextRun?.parentRunId, null);
  assert.equal(nextRun?.parentToolExecutionId, null);
  assert.equal(getRunRecord(fixture.db, "run_latest_depth_unknown")?.subtaskDepth, null);
  assert.equal(getRunRecord(fixture.db, "run_latest_depth_unknown")?.parentRunId, null);
});

test("agent run 会保存 subtask depth lineage，并按 parent tool 查询 child run", async (t: TestContext) => {
  const fixture = await createP2Fixture(t);
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
    const childSession = createSubtaskSessionForTest(fixture, { title: "run-lineage" });
    const child = createMessageRunForTest({
      fixture,
      sessionId: childSession.id,
      status: "completed",
      subtaskDepth: 2,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId
    });

    const record = getRunRecord(fixture.db, child.runId);
    assert.ok(record);
    assert.equal(record.subtaskDepth, 2);
    assert.equal(record.parentRunId, parent.parentRunId);
    assert.equal(record.parentToolExecutionId, parent.toolExecutionId);

    const byParentTool = findMessageSubtaskRunByParentToolExecution(fixture.db, {
      workspaceId: fixture.workspaceId,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId
    });
    assert.equal(byParentTool?.runId, child.runId);
    assert.equal(findMessageSubtaskRunByParentToolExecution(fixture.db, {
      workspaceId: fixture.workspaceId,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: "missing-execution"
    }), null);
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("subtask cascade 以 run lineage 为准，不依赖 parent tool 的 subtaskSessionId 回填", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
    const started = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId,
      session: { mode: "new" }
    });
    const runState = getMessageRunState(fixture.db, fixture.workspaceId, parent.parentSession.id);
    assert.ok(runState);
    fixture.db.prepare(`
      update session_run_state
      set status = 'running', active_run_id = ?, updated_at = ?
      where workspace_id = ? and session_id = ?
    `).run(parent.parentRunId, Date.now(), fixture.workspaceId, parent.parentSession.id);
    fixture.db.prepare("update agent_run set status = 'running', updated_at = ? where run_id = ?")
      .run(Date.now(), parent.parentRunId);
    assert.equal(started.statusCode, 200, started.body);
    const child = started.json() as { sessionId: string; runId: string };

    const cancelled = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${parent.parentSession.id}/cancel`,
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(getRunRecord(fixture.db, child.runId)?.status, "cancelled");
    assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, child.sessionId)?.status, "idle");
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("subtask orphan scanner 仅删除满足全部条件的空壳", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  try {
    const service = createAgentService(fixture.ctx, fixture.app.log);
    const now = Date.now();
    const forkSource = await createSession(fixture.app, fixture.workspaceId);
    const forkedFromMessageId = appendTriggerMessage({ fixture, sessionId: forkSource.id, createdAt: now - 26 * 60 * 60 * 1000 });
    const cases = [
      { name: "young", age: 30 * 60 * 1000, forked: true, resource: "none", expected: true },
      { name: "missing-fork", age: 25 * 60 * 60 * 1000, forked: false, resource: "none", expected: true },
      { name: "has-run", age: 25 * 60 * 60 * 1000, forked: true, resource: "run", expected: true },
      { name: "has-message-and-head", age: 25 * 60 * 60 * 1000, forked: true, resource: "message", expected: true },
      { name: "eligible", age: 25 * 60 * 60 * 1000, forked: true, resource: "none", expected: false }
    ];
    for (const item of cases) {
      const sessionId = `sess_orphan_${item.name}`;
      createStandaloneSession({
        fixture,
        sessionId,
        kind: "subtask",
        createdAt: now - item.age,
        forkedFromSessionId: item.forked ? forkSource.id : null,
        forkedFromMessageId: item.forked ? forkedFromMessageId : null
      });
      if (item.resource === "run") {
        createMessageRunForTest({ fixture, sessionId, status: "completed" });
      }
      if (item.resource === "message") {
        appendTriggerMessage({ fixture, sessionId, createdAt: now - item.age });
      }
      service.cleanupSubtaskOrphansOnStartup({ now });
      assert.equal(getMessageSession(fixture.db, fixture.workspaceId, sessionId) != null, item.expected, item.name);
    }

    const recheckedSessionId = "sess_orphan_rechecked";
    createStandaloneSession({
      fixture,
      sessionId: recheckedSessionId,
      kind: "subtask",
      createdAt: now - 25 * 60 * 60 * 1000,
      forkedFromSessionId: forkSource.id,
      forkedFromMessageId
    });
    createMessageRunForTest({ fixture, sessionId: recheckedSessionId, status: "completed" });
    assert.equal(new SqliteSubtaskMaintenancePersistence(fixture.db).deleteSuspectIfStillEligible({
      workspaceId: fixture.workspaceId,
      sessionId: recheckedSessionId,
      olderThan: now - 24 * 60 * 60 * 1000
    }), false, "deletion recheck must retain a newly non-empty candidate");
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("subtask orphan scanner 的单条删除异常不会阻断后续候选", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  try {
    const now = Date.now();
    const blockedSessionId = "sess_orphan_blocked";
    const deletableSessionId = "sess_orphan_deletable";
    const forkSource = await createSession(fixture.app, fixture.workspaceId);
    const forkedFromMessageId = appendTriggerMessage({ fixture, sessionId: forkSource.id, createdAt: now - 26 * 60 * 60 * 1000 });
    for (const sessionId of [blockedSessionId, deletableSessionId]) {
      createStandaloneSession({
        fixture,
        sessionId,
        kind: "subtask",
        createdAt: now - 25 * 60 * 60 * 1000,
        forkedFromSessionId: forkSource.id,
        forkedFromMessageId
      });
    }
    fixture.db.exec(`
      create trigger fail_one_orphan_delete
      before delete on agent_session
      when old.id = '${blockedSessionId}'
      begin
        select raise(abort, 'injected orphan delete failure');
      end;
    `);

    createAgentService(fixture.ctx, fixture.app.log).cleanupSubtaskOrphansOnStartup({ now });

    assert.ok(getMessageSession(fixture.db, fixture.workspaceId, blockedSessionId));
    assert.equal(getMessageSession(fixture.db, fixture.workspaceId, deletableSessionId), null);
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("M9 fork materialization 后 parent durable cancel 会补偿 Session 且保留共享 Message", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
    fixture.db.exec(`
      create trigger cancel_parent_after_subtask_fork
      after insert on agent_session
      when new.kind = 'subtask'
        and new.forked_from_session_id = '${parent.parentSession.id}'
      begin
        update agent_run
        set status = 'cancelled', updated_at = ${Date.now()}
        where workspace_id = '${fixture.workspaceId}' and run_id = '${parent.parentRunId}';
        update session_run_state
        set status = 'idle', active_run_id = null, updated_at = ${Date.now()}
        where workspace_id = '${fixture.workspaceId}' and session_id = '${parent.parentSession.id}';
      end;
    `);

    const response = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId,
      session: { mode: "fork" },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "AGENT_SUBTASK_PARENT_NOT_ACTIVE");
    assert.equal(
      (fixture.db.prepare("select count(*) as count from agent_session where workspace_id = ? and kind = 'subtask'").get(fixture.workspaceId) as { count: number }).count,
      0,
    );
    assert.ok(getMessageSession(fixture.db, fixture.workspaceId, parent.parentSession.id));
    assert.ok(fixture.db.prepare("select 1 from agent_message where id = ?").get(parent.userMessageId));
    assert.equal(
      (fixture.db.prepare("select count(*) as count from agent_run where workspace_id = ? and parent_run_id = ?").get(fixture.workspaceId, parent.parentRunId) as { count: number }).count,
      0,
    );
    assert.equal(
      (fixture.db.prepare("select count(*) as count from session_run_state state join agent_session session on session.id = state.session_id where state.workspace_id = ? and session.kind = 'subtask'").get(fixture.workspaceId) as { count: number }).count,
      0,
    );
    assert.deepEqual(
      new SqliteRunLifecyclePersistence(fixture.db).listRecoverableRunCandidates()
        .filter((candidate) => candidate.workspaceId === fixture.workspaceId && candidate.sessionId !== parent.parentSession.id),
      [],
    );
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("startSubtask failure 仅补偿本次新建空壳，不删除 existing reuse", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
    fixture.db.exec(`
      create trigger fail_subtask_user_insert
      before insert on agent_message
      when new.type = 'user' and new.origin_session_id != '${parent.parentSession.id}'
      begin
        select raise(abort, 'injected subtask start failure');
      end;
    `);
    const created = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId,
      session: { mode: "fork" }
    });
    assert.equal(created.statusCode, 500, created.body);
    const emptySubtasks = fixture.db.prepare("select count(*) as count from agent_session where kind = 'subtask'").get() as { count: number };
    assert.equal(emptySubtasks.count, 0);
    assert.ok(getMessageSession(fixture.db, fixture.workspaceId, parent.parentSession.id));
    assert.ok(fixture.db.prepare("select 1 from agent_message where id = ?").get(parent.userMessageId));
    assert.equal(
      (fixture.db.prepare("select count(*) as count from agent_run where workspace_id = ? and parent_run_id = ?").get(fixture.workspaceId, parent.parentRunId) as { count: number }).count,
      0,
    );

    fixture.db.exec("drop trigger fail_subtask_user_insert");
    const existing = newSortableId("sess");
    createStandaloneSession({
      fixture,
      sessionId: existing,
      kind: "subtask",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromMessageId: null
    });
    fixture.db.exec(`
      create trigger fail_existing_subtask_user_insert
      before insert on agent_message
      when new.type = 'user' and new.origin_session_id = '${existing}'
      begin
        select raise(abort, 'injected existing subtask failure');
      end;
    `);
    const reused = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId,
      session: { mode: "existing", sessionId: existing }
    });
    assert.equal(reused.statusCode, 500, reused.body);
    assert.ok(getMessageSession(fixture.db, fixture.workspaceId, existing));
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("agent run 的 parent tool partial unique index 仅约束 subtask lineage", async (t: TestContext) => {
  const fixture = await createP2Fixture(t);
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
    const sessionId = newSortableId("sess");
    createStandaloneSession({ fixture, sessionId });
    const triggerMessageId = appendTriggerMessage({ fixture, sessionId });
    const base = {
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerMessageId,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status: "running" as const,
      createdAt: Date.now()
    };

    createMessageRunRecord(fixture.db, {
      ...base,
      runId: newSortableId("run"),
      subtaskDepth: 1,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId
    });
    assert.throws(
      () => createMessageRunRecord(fixture.db, {
        ...base,
        runId: newSortableId("run"),
        subtaskDepth: 1,
        parentRunId: parent.parentRunId,
        parentToolExecutionId: parent.toolExecutionId
      }),
      /UNIQUE constraint failed/
    );
    createMessageRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 0, parentRunId: parent.parentRunId, parentToolExecutionId: null });
    createMessageRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: null, parentRunId: parent.parentRunId, parentToolExecutionId: null });
  } finally {
    await closeP2Fixture(fixture);
  }
});
