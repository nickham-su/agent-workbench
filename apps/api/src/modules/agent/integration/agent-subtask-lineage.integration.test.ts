import { createAgentService } from "../agent.composition.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  appendContextItem,
  createAgentSession,
  createRunRecord,
  findSubtaskRunByParentTool,
  getAgentSession,
  getLatestRunRecordBySession,
  getLatestTerminalRunRecord,
  getRunRecord,
  getRunState as getRunStateRow,
  updateRunState
} from "../agent.store.js";
import { isSubtaskParentToolUniqueConstraintError } from "../agent.service.js";
import { SqliteSubtaskMaintenancePersistence } from "../subtask/sqlite-subtask-maintenance-persistence.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  closeP2Fixture,
  createP2Fixture,
  createSession,
  createSubtaskAnchor,
  sendMessage,
  startSubtaskForAnchor
} from "./subtask.helpers.js";

test("agent run mapper 对 SQLite 弱类型 lineage 值 fail-closed", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
  try {
    const sessionId = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: sessionId,
      workspaceId: fixture.workspaceId,
      title: "run-mapper",
      kind: "primary",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const parentRunId = newSortableId("run");
    const childRunId = newSortableId("run");
    createRunRecord(fixture.db, {
      runId: childRunId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: 1,
      parentRunId,
      parentToolItemId: 7,
      status: "completed",
      createdAt: Date.now()
    });
    fixture.db.prepare(`update agent_run set subtask_depth = ?, parent_tool_item_id = ?, parent_run_id = ? where run_id = ?`)
      .run("not-a-number", -1, "", childRunId);

    const record = getRunRecord(fixture.db, childRunId);
    assert.equal(record?.subtaskDepth, null);
    assert.equal(record?.parentToolItemId, null);
    assert.equal(record?.parentRunId, null);
    assert.equal(getLatestTerminalRunRecord(fixture.db, { workspaceId: fixture.workspaceId, sessionId })?.subtaskDepth, null);
    assert.equal(getLatestRunRecordBySession(fixture.db, { workspaceId: fixture.workspaceId, sessionId })?.parentToolItemId, null);

    fixture.db.prepare(`update agent_run set parent_run_id = ?, parent_tool_item_id = ?, subtask_depth = ? where run_id = ?`)
      .run(parentRunId, 7, -2, childRunId);
    assert.equal(findSubtaskRunByParentTool(fixture.db, { workspaceId: fixture.workspaceId, parentRunId, parentToolItemId: 7 })?.subtaskDepth, null);
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("primary 普通继续会重置 depth 和 parent 字段，即使最近 run 尚未 terminal", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: "run_terminal_depth_0",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null,
    status: "completed",
    createdAt
  });
  createRunRecord(fixture.db, {
    runId: "run_running_depth_2",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 2,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 2,
    parentRunId: null,
    parentToolItemId: null,
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
  assert.equal(nextRun?.parentToolItemId, null);
});

test("primary latest Run depth 为 null 时，下一条消息自愈为独立执行根", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: "run_latest_depth_unknown",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: "legacy_parent_run",
    parentToolItemId: null,
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
  assert.equal(nextRun?.parentToolItemId, null);
  assert.equal(getRunRecord(fixture.db, "run_latest_depth_unknown")?.subtaskDepth, null);
  assert.equal(getRunRecord(fixture.db, "run_latest_depth_unknown")?.parentRunId, "legacy_parent_run");
});

test("agent run 会保存 subtask depth lineage，并按 parent tool 查询 child run", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
  try {
    const sessionId = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: sessionId,
      workspaceId: fixture.workspaceId,
      title: "run-lineage",
      kind: "subtask",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const parentRunId = newSortableId("run");
    const childRunId = newSortableId("run");
    const createdAt = Date.now();

    createRunRecord(fixture.db, {
      runId: childRunId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: 2,
      parentRunId,
      parentToolItemId: 42,
      status: "running",
      createdAt
    });

    const record = getRunRecord(fixture.db, childRunId);
    assert.ok(record);
    assert.equal(record.subtaskDepth, 2);
    assert.equal(record.parentRunId, parentRunId);
    assert.equal(record.parentToolItemId, 42);

    const byParentTool = findSubtaskRunByParentTool(fixture.db, {
      workspaceId: fixture.workspaceId,
      parentRunId,
      parentToolItemId: 42
    });
    assert.equal(byParentTool?.runId, childRunId);
    assert.equal(findSubtaskRunByParentTool(fixture.db, { workspaceId: fixture.workspaceId, parentRunId, parentToolItemId: 43 }), null);
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
      parentToolItemId: parent.toolItem.item.id,
      session: { mode: "new" }
    });
    assert.equal(started.statusCode, 200, started.body);
    const child = started.json() as { sessionId: string; runId: string };

    fixture.db.prepare("update agent_context_item set tool_result_json = null, output_text = '' where id = ?").run(parent.toolItem.item.id);
    updateRunState(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: parent.parentSession.id,
      status: "running",
      activeRunId: parent.parentRunId,
      activeAssistantItemId: null,
      runNoticeText: "",
      updatedAt: Date.now(),
      appliedItemId: parent.toolItem.item.id
    });
    const cancelled = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${parent.parentSession.id}/cancel`,
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(getRunRecord(fixture.db, child.runId)?.status, "cancelled");
    assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, child.sessionId).status, "idle");
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("subtask orphan scanner 仅删除满足全部条件的空壳", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  try {
    const service = createAgentService(fixture.ctx, fixture.app.log);
    const now = Date.now();
    const cases = [
      { name: "young", age: 30 * 60 * 1000, forked: true, resource: "none", expected: true },
      { name: "missing-fork", age: 25 * 60 * 60 * 1000, forked: false, resource: "none", expected: true },
      { name: "has-run", age: 25 * 60 * 60 * 1000, forked: true, resource: "run", expected: true },
      { name: "has-item-and-head", age: 25 * 60 * 60 * 1000, forked: true, resource: "item", expected: true },
      { name: "eligible", age: 25 * 60 * 60 * 1000, forked: true, resource: "none", expected: false }
    ];
    for (const item of cases) {
      const sessionId = `sess_orphan_${item.name}`;
      createAgentSession(fixture.db, {
        id: sessionId,
        workspaceId: fixture.workspaceId,
        title: item.name,
        kind: "subtask",
        createdAt: now - item.age,
        forkedFromSessionId: item.forked ? "parent" : null,
        forkedFromItemId: item.forked ? 1 : null
      });
      if (item.resource === "run") {
        createRunRecord(fixture.db, {
          runId: `run_orphan_${item.name}`,
          workspaceId: fixture.workspaceId,
          sessionId,
          triggerItemId: 0,
          agentId: "default",
          providerId: "ppchat",
          modelId: "gpt-5.2",
          status: "completed",
          createdAt: now - item.age
        });
      }
      if (item.resource === "item") {
        appendContextItem(fixture.db, {
          workspaceId: fixture.workspaceId,
          sessionId,
          runId: null,
          turnId: null,
          step: null,
          prevId: null,
          kind: "system",
          status: "completed",
          output: { type: "system_text", text: "not empty" },
          createdAt: now - item.age
        });
      }
      service.cleanupSubtaskOrphansOnStartup({ now });
      assert.equal(getAgentSession(fixture.db, sessionId) != null, item.expected, item.name);
    }

    const recheckedSessionId = "sess_orphan_rechecked";
    createAgentSession(fixture.db, {
      id: recheckedSessionId,
      workspaceId: fixture.workspaceId,
      title: "rechecked",
      kind: "subtask",
      createdAt: now - 25 * 60 * 60 * 1000,
      forkedFromSessionId: "parent",
      forkedFromItemId: 1
    });
    createRunRecord(fixture.db, {
      runId: "run_orphan_rechecked",
      workspaceId: fixture.workspaceId,
      sessionId: recheckedSessionId,
      triggerItemId: 0,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status: "completed",
      createdAt: now
    });
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
    for (const sessionId of [blockedSessionId, deletableSessionId]) {
      createAgentSession(fixture.db, {
        id: sessionId,
        workspaceId: fixture.workspaceId,
        title: sessionId,
        kind: "subtask",
        createdAt: now - 25 * 60 * 60 * 1000,
        forkedFromSessionId: "parent",
        forkedFromItemId: 1
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

    assert.ok(getAgentSession(fixture.db, blockedSessionId));
    assert.equal(getAgentSession(fixture.db, deletableSessionId), null);
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
      before insert on agent_context_item
      when new.kind = 'user' and new.session_id != '${parent.parentSession.id}'
      begin
        select raise(abort, 'injected subtask start failure');
      end;
    `);
    const created = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolItemId: parent.toolItem.item.id,
      session: { mode: "new" }
    });
    assert.equal(created.statusCode, 500, created.body);
    const emptySubtasks = fixture.db.prepare("select count(*) as count from agent_session where kind = 'subtask'").get() as { count: number };
    assert.equal(emptySubtasks.count, 0);

    fixture.db.exec("drop trigger fail_subtask_user_insert");
    const existing = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: existing,
      workspaceId: fixture.workspaceId,
      title: "existing reuse",
      kind: "subtask",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    fixture.db.exec(`
      create trigger fail_existing_subtask_user_insert
      before insert on agent_context_item
      when new.kind = 'user' and new.session_id = '${existing}'
      begin
        select raise(abort, 'injected existing subtask failure');
      end;
    `);
    const reused = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolItemId: parent.toolItem.item.id,
      session: { mode: "existing", sessionId: existing }
    });
    assert.equal(reused.statusCode, 500, reused.body);
    assert.ok(getAgentSession(fixture.db, existing));
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("agent run 的 parent tool partial unique index 仅约束 subtask lineage", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
  try {
    const sessionId = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: sessionId,
      workspaceId: fixture.workspaceId,
      title: "run-lineage-index",
      kind: "primary",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const parentRunId = newSortableId("run");
    const base = {
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status: "running" as const,
      createdAt: Date.now()
    };

    createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 1, parentRunId, parentToolItemId: 7 });
    assert.throws(
      () => createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 1, parentRunId, parentToolItemId: 7 }),
      /UNIQUE constraint failed/
    );
    createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 0, parentRunId, parentToolItemId: null });
    createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: null, parentRunId, parentToolItemId: null });
  } finally {
    await closeP2Fixture(fixture);
  }
});

test("subtask parent tool unique 冲突判定仅匹配目标 SQLite 约束", () => {
  assert.equal(
    isSubtaskParentToolUniqueConstraintError({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: agent_run.parent_run_id, agent_run.parent_tool_item_id"
    }),
    true
  );
  assert.equal(
    isSubtaskParentToolUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: other_table.value" }),
    false
  );
  assert.equal(
    isSubtaskParentToolUniqueConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "FOREIGN KEY constraint failed" }),
    false
  );
  assert.equal(isSubtaskParentToolUniqueConstraintError(new Error("transaction failed")), false);
});
