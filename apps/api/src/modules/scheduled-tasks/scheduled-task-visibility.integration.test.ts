import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AgentSessionVisibility } from "@agent-workbench/shared";
import { createAgentIntegrationFixture } from "../agent/testkit/agent-integration-testkit.js";
import { createAgentComposition } from "../agent/agent.composition.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import type { AgentService } from "../agent/agent.service.js";
import { appendMessage, createMessageSession, getMessageSession, getRunRecord } from "../agent/agent-message.store.js";
import { buildScheduledExecutionSessionTitle } from "../agent/session/session-title.js";
import { ScheduledTaskService } from "./scheduled-task.service.js";
import { declareManualExecution, readScheduledExecution, ScheduledStoreError, toScheduledExecution } from "./scheduled-task.store.js";
import { setSettingJson } from "../settings/settings.store.js";
import { ScheduledTaskScheduler } from "./scheduled-task.scheduler.js";
import { HttpError } from "../../app/errors.js";

async function setup(t: TestContext) {
  const f = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => f.dispose());
  const composition = createAgentComposition(f.ctx, f.app.log);
  t.after(() => composition.dispose());
  const queued: string[] = [];
  const runtime: AgentRuntimePort = { enqueueRun: (run) => { queued.push(run.runId); }, cancelSession: () => {} };
  const diagnostics: Array<{ executionId: string; reason: string }> = [];
  const service = new ScheduledTaskService(f.ctx, composition.service, runtime, Date.now, (item) => diagnostics.push(item));
  const source = (visibility: AgentSessionVisibility = "listed") => {
    createMessageSession(f.db, { workspaceId: f.workspaceId, id: "source", title: "source", kind: "primary", visibility, createdAt: 1 });
    appendMessage(f.db, { workspaceId: f.workspaceId, sessionId: "source", id: "anchor", expectedHeadMessageId: null, expectedRevision: 0,
      type: "user", status: "completed", createdAt: 2, parts: [{ id: "anchor-part", position: 0, type: "text", text: "fixed history" }] });
  };
  const task = (mode: "new_session" | "fork_message", name = "task") => service.create(f.workspaceId, {
    name, prompt: "scheduled prompt", agentId: "default", enabled: true, triggerMode: mode,
    sourceSessionId: mode === "fork_message" ? "source" : null, sourceMessageId: mode === "fork_message" ? "anchor" : null,
    schedule: { kind: "hourly", minutesUtc: [0, 30] }
  });
  return { ...f, composition, runtime, queued, service, source, task, diagnostics };
}
function counts(f: Awaited<ReturnType<typeof setup>>) {
  return ["agent_session", "workspace_session_tab_state", "agent_message", "agent_run", "agent_client_request"].map((table) =>
    (f.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);
}

for (const mode of ["new_session", "fork_message"] as const) {
  for (const trigger of ["manual", "scheduled"] as const) {
    test(`${mode}/${trigger} uses hidden execution Sessions and preserves the fixed known-hidden source anchor`, async (t) => {
      const f = await setup(t);
      if (mode === "fork_message") f.source("unlisted");
      const task = f.task(mode);
      if (mode === "fork_message") appendMessage(f.db, { workspaceId: f.workspaceId, sessionId: "source", id: "later-source",
        expectedHeadMessageId: "anchor", expectedRevision: 1, type: "user", status: "completed", createdAt: 3,
        parts: [{ id: "later-source-part", position: 0, type: "text", text: "not the selected anchor" }] });
      const execution = trigger === "manual" ? await f.service.run(f.workspaceId, task.id) :
        await f.service.execute(f.service.claim(f.workspaceId, task.id, task.nextRunAt!, task.nextRunAt!)!);
      const row = readScheduledExecution(f.db, f.workspaceId, execution.id)!;
      assert.equal(row.snapshot.sessionVisibility, "unlisted");
      const session = getMessageSession(f.db, f.workspaceId, row.sessionId!)!;
      assert.equal(session.visibility, "unlisted");
      assert.equal(session.kind, "primary");
      assert.deepEqual(f.db.prepare("select visible from workspace_session_tab_state where session_id=?").get(session.id), { visible: 0 });
      assert.equal(row.sessionId !== "source", true);
      assert.equal(f.queued.length, 1);
      assert.equal(toScheduledExecution(f.db, f.workspaceId, row).sessionAvailable, true);
      if (mode === "fork_message") {
        assert.equal(session.forkedFromSessionId, "source");
        assert.equal(session.forkedFromMessageId, "anchor");
        const prompt = f.db.prepare("select previous_message_id as previous from agent_message where id=?").get(getRunRecord(f.db, row.runId!)!.triggerMessageId) as { previous: string };
        assert.equal(prompt.previous, "anchor");
        assert.equal(getMessageSession(f.db, f.workspaceId, "source")!.headMessageId, "later-source");
      }
      const before = counts(f);
      await f.service.execute(row);
      f.service.reconcileActive(true);
      assert.deepEqual(counts(f), before);
      assert.equal(f.queued.length, 1);
    });
  }

  for (const existing of [false, true]) {
    test(`old ${mode} snapshot with ${existing ? "an existing pristine" : "no"} Session uses listed identity without resetting Tab`, async (t) => {
      const f = await setup(t);
      if (mode === "fork_message") f.source();
      const task = f.task(mode);
      const declared = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: task.id, nowMs: Date.now() });
      const old = { ...declared.snapshot };
      delete old.sessionVisibility;
      f.db.prepare("update scheduled_agent_execution set task_snapshot_json=? where id=?").run(JSON.stringify(old), declared.id);
      const row = readScheduledExecution(f.db, f.workspaceId, declared.id)!;
      if (existing) {
        const title = buildScheduledExecutionSessionTitle(row.snapshot.taskName);
        if (mode === "new_session") f.composition.service.createPrimarySessionWithExpectedId({ workspaceId: f.workspaceId, sessionId: row.sessionId!, title });
        else f.composition.service.forkPrimarySessionFromHistoricalAnchorWithExpectedId({ workspaceId: f.workspaceId, sessionId: row.sessionId!, title,
          sourceSessionId: "source", targetMessageId: "anchor" });
        f.db.prepare("update workspace_session_tab_state set visible=0,updated_at=42 where session_id=?").run(row.sessionId);
      }
      const result = await f.service.execute(row);
      assert.ok(result.runId);
      assert.equal(getMessageSession(f.db, f.workspaceId, row.sessionId!)!.visibility, "listed");
      assert.deepEqual(f.db.prepare("select visible from workspace_session_tab_state where session_id=?").get(row.sessionId), { visible: existing ? 0 : 1 });
      if (existing) assert.deepEqual(f.db.prepare("select updated_at from workspace_session_tab_state where session_id=?").get(row.sessionId), { updated_at: 42 });
      assert.equal(f.queued.length, 1);
      const before = counts(f);
      await f.service.execute(result);
      f.service.reconcileActive(true);
      assert.deepEqual(counts(f), before);
      assert.equal(f.queued.length, 1);
    });
  }

  test(`${mode} refuses an occupied listed preallocated ID before Message/Run/dedup/enqueue`, async (t) => {
    const f = await setup(t);
    if (mode === "fork_message") f.source();
    const task = f.task(mode);
    const declared = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: task.id, nowMs: Date.now() });
    createMessageSession(f.db, { workspaceId: f.workspaceId, id: declared.sessionId!, title: buildScheduledExecutionSessionTitle(declared.snapshot.taskName),
      kind: "primary", visibility: "listed", createdAt: 1 });
    const before = counts(f);
    const result = await f.service.execute(declared);
    assert.equal(result.reasonCode, "session_id_conflict");
    assert.equal(toScheduledExecution(f.db, f.workspaceId, result).sessionAvailable, false);
    assert.deepEqual(counts(f), before);
    assert.equal(f.queued.length, 0);
    assert.equal(getMessageSession(f.db, f.workspaceId, declared.sessionId!)!.visibility, "listed");
  });

  test(`${mode} activation rechecks visibility after successful creation and before any execution writes`, async (t) => {
    const f = await setup(t);
    if (mode === "fork_message") f.source();
    const task = f.task(mode);
    const declared = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: task.id, nowMs: Date.now() });
    let beforeSend: number[] = [];
    const agent = new Proxy(f.composition.service, { get(target, property, receiver) {
      if (property === "sendMessage") return async (input: Parameters<AgentService["sendMessage"]>[0]) => {
        assert.equal(input.expectedSessionVisibility, "unlisted");
        // Controlled identity corruption in the exact create-to-activate gap.
        // There is intentionally no product endpoint that can make this edit.
        f.db.prepare("update agent_session set visibility='listed' where id=?").run(declared.sessionId);
        beforeSend = counts(f);
        return target.sendMessage(input);
      };
      return Reflect.get(target, property, receiver);
    } });
    const service = new ScheduledTaskService(f.ctx, agent, f.runtime);
    const result = await service.execute(declared);
    assert.equal(result.reasonCode, "session_id_conflict");
    assert.deepEqual(counts(f), beforeSend);
    assert.equal(f.queued.length, 0);
    assert.equal(toScheduledExecution(f.db, f.workspaceId, result).sessionAvailable, false);
  });
}

test("accepted replay checks only stable identity, and execution history stays bound to its Run after ordinary continuation", async (t) => {
  const f = await setup(t);
  const task = f.task("new_session");
  const result = await f.service.run(f.workspaceId, task.id);
  const row = readScheduledExecution(f.db, f.workspaceId, result.id)!;
  f.db.prepare("update agent_run set status='completed',execution_phase='terminal',terminal_result_code='run_completed' where run_id=?").run(row.runId);
  f.db.prepare("update session_run_state set status='idle',active_run_id=null where session_id=?").run(row.sessionId);
  f.composition.service.updateSessionTitle({ sessionId: row.sessionId!, body: { workspaceId: f.workspaceId, title: "continued by user" } });
  const next = await f.composition.service.sendMessage({ sessionId: row.sessionId!, body: {
    workspaceId: f.workspaceId, clientRequestId: "ordinary-follow-up", agentId: "default", text: "continue ordinary conversation"
  }, runtime: f.runtime });
  assert.notEqual(next.runId, row.runId);
  const before = counts(f);
  // Accepted replay is independent of current readiness as well as pristine identity.
  setSettingJson(f.ctx.db, "agent_providers_v1", { default: { providerId: null, modelId: null }, providers: [] }, Date.now());
  assert.deepEqual(f.service.readyAgents(f.workspaceId), { agentIds: [] });
  const replay = await f.composition.service.sendMessage({ sessionId: row.sessionId!, body: {
    workspaceId: f.workspaceId, clientRequestId: row.clientRequestId, agentId: row.snapshot.agentId, text: row.snapshot.prompt
  }, runtime: f.runtime, expectedSessionTitle: "no longer pristine", expectedSessionVisibility: "unlisted" });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.runId, row.runId);
  const settled = await f.service.execute(row);
  assert.equal(settled.status, "completed");
  assert.equal(settled.runId, row.runId);
  assert.equal(getRunRecord(f.db, next.runId)!.status, "running");
  assert.deepEqual(counts(f), before);
  assert.equal(f.queued.length, 2);
  assert.equal(f.service.history({ workspaceId: f.workspaceId, taskId: task.id }).items[0]!.runId, row.runId);
  const retainedFacts = () => ["agent_session", "session_run_state", "workspace_session_tab_state", "agent_run", "agent_message", "agent_client_request"]
    .map((table) => ({ table, rows: f.db.prepare(`select * from ${table} order by rowid`).all() }));
  const beforeDelete = retainedFacts();
  f.service.delete(f.workspaceId, task.id);
  assert.deepEqual(retainedFacts(), beforeDelete, "deleting a completed task cannot collect its hidden Session, later Run or actual Tab state");
  assert.equal(f.db.prepare("select 1 from scheduled_agent_task where id=?").get(task.id), undefined);
  assert.equal(f.db.prepare("select 1 from scheduled_agent_execution where task_id=?").get(task.id), undefined);
});

test("accepted wrong-visibility identity is unresolved rather than released or resent, including the direct dedup shortcut", async (t) => {
  const f = await setup(t);
  const task = f.task("new_session");
  const row = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: task.id, nowMs: Date.now() });
  createMessageSession(f.db, { workspaceId: f.workspaceId, id: row.sessionId!, kind: "primary", visibility: "listed", title: "unrelated", createdAt: 1 });
  const accepted = await f.composition.service.sendMessage({ sessionId: row.sessionId!, body: {
    workspaceId: f.workspaceId, clientRequestId: row.clientRequestId, agentId: "default", text: row.snapshot.prompt
  }, runtime: f.runtime });
  const before = counts(f);
  const result = await f.service.execute(row);
  assert.equal(result.status, "starting");
  f.service.reconcileActive(true);
  assert.deepEqual(f.diagnostics, [{ executionId: row.id, reason: "run_reference_conflict" }]);
  assert.equal(readScheduledExecution(f.db, f.workspaceId, row.id)!.finishedAt, null);
  assert.equal(toScheduledExecution(f.db, f.workspaceId, row).sessionAvailable, false);
  await assert.rejects(() => f.composition.service.sendMessage({ sessionId: row.sessionId!, body: {
    workspaceId: f.workspaceId, clientRequestId: row.clientRequestId, agentId: "default", text: row.snapshot.prompt
  }, runtime: f.runtime, expectedSessionVisibility: "unlisted" }), (error: unknown) => error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.deepEqual(counts(f), before);
  assert.equal(f.queued.length, 1);
  assert.equal(getRunRecord(f.db, accepted.runId)!.status, "running");
  assert.throws(() => declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: task.id, nowMs: Date.now() }), { code: "TASK_EXECUTION_ALREADY_ACTIVE" });
});

test("invalid active snapshots are isolated per execution, retained active and diagnosed once while healthy recovery continues", async (t) => {
  const f = await setup(t);
  const bad = f.task("new_session", "bad");
  const badRow = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: bad.id, nowMs: Date.now() });
  const good = f.task("new_session", "healthy");
  const healthy = await f.service.run(f.workspaceId, good.id);
  f.db.prepare("update agent_run set status='completed',execution_phase='terminal',terminal_result_code='run_completed' where run_id=?").run(healthy.runId);
  const before = counts(f);
  for (const json of ["{invalid private fixture", JSON.stringify({ ...badRow.snapshot, sessionVisibility: null }),
    JSON.stringify({ ...badRow.snapshot, sessionVisibility: "listed" }), JSON.stringify({ ...badRow.snapshot, sessionVisibility: false })]) {
    f.db.prepare("update scheduled_agent_execution set task_snapshot_json=? where id=?").run(json, badRow.id);
    await assert.rejects(() => f.service.execute(badRow), (error: unknown) => error instanceof ScheduledStoreError && error.code === "SCHEDULED_EXECUTION_SNAPSHOT_INVALID");
    f.service.reconcileActive(true);
    f.service.reconcileActive();
    assert.deepEqual(f.db.prepare("select status,finished_at from scheduled_agent_execution where id=?").get(badRow.id), { status: "starting", finished_at: null });
    assert.equal(readScheduledExecution(f.db, f.workspaceId, healthy.id)!.status, "completed");
    assert.throws(() => declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: bad.id, nowMs: Date.now() }), { code: "TASK_EXECUTION_ALREADY_ACTIVE" });
  }
  assert.deepEqual(f.diagnostics, [{ executionId: badRow.id, reason: "snapshot_invalid" }]);
  assert.deepEqual(counts(f), before);
  assert.equal(f.queued.length, 1);
  const response = await f.app.inject({ method: "GET", url: `/api/workspaces/${f.workspaceId}/scheduled-tasks/${bad.id}/executions` });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "SCHEDULED_EXECUTION_SNAPSHOT_INVALID");
  assert.equal(response.body.includes("private fixture"), false);
});

test("scheduler starts and dispatches a healthy due task despite another task's malformed active snapshot", async (t) => {
  const f = await setup(t);
  const bad = f.task("new_session", "bad scheduler row");
  const badRow = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId: bad.id, nowMs: Date.now() });
  f.db.prepare("update scheduled_agent_execution set task_snapshot_json='{' where id=?").run(badRow.id);
  const good = f.task("new_session", "healthy scheduler row");
  let now = Date.now();
  const errors: unknown[] = [];
  const scheduler = new ScheduledTaskScheduler(f.service, () => now, (error) => errors.push(error));
  t.after(() => scheduler.stop());
  scheduler.start();
  now = good.nextRunAt!;
  await scheduler.tick();
  await scheduler.stop();
  assert.deepEqual(errors, []);
  assert.deepEqual(f.diagnostics, [{ executionId: badRow.id, reason: "snapshot_invalid" }]);
  assert.equal(f.queued.length, 1);
  const healthy = f.service.history({ workspaceId: f.workspaceId, taskId: good.id }).items[0]!;
  assert.equal(healthy.sessionAvailable, true);
  assert.equal(getMessageSession(f.db, f.workspaceId, healthy.sessionId!)!.visibility, "unlisted");
  assert.deepEqual(f.db.prepare("select status,finished_at from scheduled_agent_execution where id=?").get(badRow.id), { status: "starting", finished_at: null });
});

test("a genuinely persisted hidden Run survives unknown enqueue acceptance and startup reconciliation without a second Prompt", async (t) => {
  const f = await setup(t);
  const task = f.task("new_session", "unknown transport");
  const attempted: string[] = [];
  const runtime: AgentRuntimePort = {
    enqueueRun(run) { attempted.push(run.runId); throw new Error("fixture transport outcome unknown"); },
    cancelSession() {}
  };
  const service = new ScheduledTaskService(f.ctx, f.composition.service, runtime);
  const execution = await service.run(f.workspaceId, task.id);
  assert.equal(execution.status, "starting");
  assert.ok(execution.runId);
  assert.equal(execution.sessionAvailable, true);
  assert.equal(getMessageSession(f.db, f.workspaceId, execution.sessionId!)!.visibility, "unlisted");
  const before = counts(f);
  const row = readScheduledExecution(f.db, f.workspaceId, execution.id)!;
  await service.execute(row);
  service.reconcileActive(true);
  assert.deepEqual(counts(f), before);
  assert.deepEqual(attempted, [execution.runId]);
  assert.equal(readScheduledExecution(f.db, f.workspaceId, execution.id)!.reasonCode, null);
});
