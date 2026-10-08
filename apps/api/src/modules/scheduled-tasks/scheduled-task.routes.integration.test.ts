import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { ScheduledTaskSchema, ScheduledExecutionSchema } from "@agent-workbench/shared";
import { createAgentIntegrationFixture } from "../agent/testkit/agent-integration-testkit.js";
import { appendMessage, createMessageRunRecord, createMessageSession, getMessageSession, getRunRecord } from "../agent/agent-message.store.js";
import type { AgentService } from "../agent/agent.service.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import { ScheduledTaskService } from "./scheduled-task.service.js";
import { ScheduledTaskScheduler } from "./scheduled-task.scheduler.js";
import { declareManualExecution, readScheduledExecution } from "./scheduled-task.store.js";
import { buildScheduledExecutionSessionTitle } from "../agent/session/session-title.js";
import { HttpError } from "../../app/errors.js";
import { setSettingJson } from "../settings/settings.store.js";
import { getAgentProvidersSettingsInternal } from "../settings/settings.service.js";

async function setup(t: TestContext) {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const base = `/api/workspaces/${fixture.workspaceId}/scheduled-tasks`;
  const payload = { name: "  My\nTask  ", prompt: "Do a short task", agentId: "default", enabled: true,
    triggerMode: "new_session", sourceSessionId: null, sourceMessageId: null,
    schedule: { kind: "hourly", minutesUtc: [30, 0, 30] } };
  return { ...fixture, base, payload };
}

test("trigger/source mismatch is classified separately from malformed schedule and invalid source anchor", async (t) => {
  const f = await setup(t);
  for (const payload of [
    { ...f.payload, triggerMode: "fork_message", sourceSessionId: null, sourceMessageId: null },
    { ...f.payload, triggerMode: "new_session", sourceSessionId: "source" },
    { ...f.payload, triggerMode: "unsupported" }
  ]) {
    const response = await f.app.inject({ method: "POST", url: f.base, payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "TASK_TRIGGER_MODE_INVALID");
  }
  const badSchedule = await f.app.inject({ method: "POST", url: f.base,
    payload: { ...f.payload, schedule: { kind: "daily", minutesOfDayUtc: [] } } });
  assert.equal(badSchedule.json().code, "SCHEDULE_INVALID");
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const { enabled: _enabled, ...config } = f.payload;
  const replaced = await f.app.inject({ method: "PUT", url: `${f.base}/${created.json().task.id}`,
    payload: { ...config, triggerMode: "fork_message", sourceSessionId: null } });
  assert.equal(replaced.statusCode, 400);
  assert.equal(replaced.json().code, "TASK_TRIGGER_MODE_INVALID");
});

test("ready Agent options use the execution resolver, including missing Provider credentials", async (t) => {
  const f = await setup(t);
  const available = await f.app.inject({ method: "GET", url: `${f.base}/ready-agents` });
  assert.equal(available.statusCode, 200, available.body);
  assert.deepEqual(available.json().agentIds, ["default"]);
  const settings = getAgentProvidersSettingsInternal(f.ctx);
  setSettingJson(f.db, "agent_providers_v1", { ...settings,
    providers: settings.providers.map((provider) => ({ ...provider, options: { ...provider.options, apiKey: "" } }))
  }, Date.now());
  const unavailable = await f.app.inject({ method: "GET", url: `${f.base}/ready-agents` });
  assert.equal(unavailable.statusCode, 200, unavailable.body);
  assert.deepEqual(unavailable.json().agentIds, []);
  const rejected = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(rejected.statusCode, 422);
  assert.equal(rejected.json().code, "AGENT_NOT_READY");
});

test("an unrelated Session occupying the reserved ID is never navigable from task or history", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id as string;
  const execution = declareManualExecution(f.db, { workspaceId: f.workspaceId, taskId,
    nowMs: Date.now(), executionId: "reserved-conflict", sessionId: "sched_reserved-conflict" });
  createMessageSession(f.db, { workspaceId: f.workspaceId, id: execution.sessionId!, kind: "primary",
    title: "Another user's unrelated Session", createdAt: Date.now() });
  const agent = {
    createPrimarySessionWithExpectedId() {
      throw new HttpError(409, "The reserved Session ID is occupied", "SESSION_ID_CONFLICT");
    }
  } as unknown as AgentService;
  const service = new ScheduledTaskService(f.ctx, agent, {} as AgentRuntimePort);
  const failed = await service.execute(execution);
  assert.equal(failed.status, "failed_to_start");
  assert.equal(failed.reasonCode, "session_id_conflict");
  assert.equal(failed.runId, null);
  assert.ok(getMessageSession(f.db, f.workspaceId, execution.sessionId!));
  for (const response of [
    await f.app.inject({ method: "GET", url: `${f.base}/${taskId}` }),
    await f.app.inject({ method: "GET", url: f.base })
  ]) {
    assert.equal(response.statusCode, 200, response.body);
    const task = response.json().task ?? response.json().items[0];
    assert.equal(task.latestExecution.id, execution.id);
    assert.equal(task.latestExecution.sessionId, execution.sessionId);
    assert.equal(task.latestExecution.sessionAvailable, false);
  }
  const history = await f.app.inject({ method: "GET", url: `${f.base}/${taskId}/executions` });
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].sessionAvailable, false);
});

test("historical task validates a scoped source, forks while parent runs and launches its own Run", async (t) => {
  const f = await setup(t);
  createMessageSession(f.ctx.db, { workspaceId: f.workspaceId, id: "source-sched", kind: "primary",
    title: "Source", createdAt: 1 });
  appendMessage(f.ctx.db, { id: "source-message-sched", workspaceId: f.workspaceId, sessionId: "source-sched",
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", createdAt: 10,
    parts: [{ id: "source-text-sched", position: 0, type: "text", text: "A valid historical source" }] });
  createMessageRunRecord(f.ctx.db, { runId: "source-run-sched", workspaceId: f.workspaceId,
    sessionId: "source-sched", triggerMessageId: null, agentId: "default", providerId: "test-provider",
    modelId: "test-model", status: "running", createdAt: 12 });
  f.ctx.db.prepare("update session_run_state set status='running',active_run_id=? where session_id=?")
    .run("source-run-sched", "source-sched");
  const checked = await f.app.inject({ method: "POST", url: `${f.base}/validate-source`,
    payload: { sessionId: "source-sched", messageId: "source-message-sched" } });
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().source.messageSummary, "A valid historical source");
  const created = await f.app.inject({ method: "POST", url: f.base, payload: { ...f.payload,
    triggerMode: "fork_message", sourceSessionId: "source-sched", sourceMessageId: "source-message-sched" } });
  assert.equal(created.statusCode, 201, created.body);
  const execution = await f.app.inject({ method: "POST", url: `${f.base}/${created.json().task.id}/run`, payload: {} });
  assert.equal(execution.statusCode, 202, execution.body);
  const result = execution.json().execution;
  assert.ok(result.runId);
  assert.equal(result.sessionAvailable, true);
  assert.equal(getMessageSession(f.ctx.db, f.workspaceId, result.sessionId)?.forkedFromMessageId, "source-message-sched");
  assert.equal(getRunRecord(f.ctx.db, result.runId)?.sessionId, result.sessionId);
  assert.equal(getMessageSession(f.ctx.db, f.workspaceId, "source-sched")?.headMessageId, "source-message-sched");
});

test("recovery links an already-persisted Agent Run without repeating the Prompt after the crash window", async (t) => {
  const f = await setup(t);
  const task = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(task.statusCode, 201, task.body);
  const taskId = task.json().task.id as string;
  // Controlled crash boundary: execution + expected Session are durable, and
  // Agent accepted the same clientRequestId, but execution.run_id was not written.
  const declared = declareManualExecution(f.db, {
    workspaceId: f.workspaceId, taskId, nowMs: Date.now(), executionId: "crash-window",
    sessionId: "sched_crash-window"
  });
  createMessageSession(f.db, { workspaceId: f.workspaceId, id: declared.sessionId!, kind: "primary",
    title: buildScheduledExecutionSessionTitle(declared.snapshot.taskName), createdAt: Date.now() });
  const send = await f.app.inject({ method: "POST", url: `/api/agent/sessions/${declared.sessionId}/messages`,
    payload: { workspaceId: f.workspaceId, clientRequestId: declared.clientRequestId,
      agentId: declared.snapshot.agentId, text: declared.snapshot.prompt } });
  assert.equal(send.statusCode, 201, send.body);
  const runId = send.json().runId as string;
  assert.ok(getRunRecord(f.db, runId));
  assert.equal(readScheduledExecution(f.db, f.workspaceId, declared.id)?.runId, null);
  let resent = 0;
  const restartingAgent = { sendMessage() { resent++; throw new Error("must not resend a Prompt"); } } as unknown as AgentService;
  const recovered = new ScheduledTaskService(f.ctx, restartingAgent, {} as AgentRuntimePort);
  recovered.reconcileActive(true);
  assert.equal(readScheduledExecution(f.db, f.workspaceId, declared.id)?.runId, runId);
  assert.equal(readScheduledExecution(f.db, f.workspaceId, declared.id)?.status, "starting");
  await recovered.execute(readScheduledExecution(f.db, f.workspaceId, declared.id)!);
  assert.equal(resent, 0);
  assert.equal((f.db.prepare("select count(*) as n from agent_run where session_id=?")
    .get(declared.sessionId) as {n: number}).n, 1);
  assert.equal((f.db.prepare("select count(*) as n from agent_message where origin_session_id=? and type='user'")
    .get(declared.sessionId) as {n: number}).n, 1);

  // Simulate the authoritative Agent lifecycle's persisted completion; the
  // Task service only reads the Run, never writes an Agent state in production.
  f.db.prepare("update agent_run set status='completed', execution_phase='terminal', terminal_result_code='run_completed' where run_id=?").run(runId);
  recovered.reconcileActive();
  assert.equal(readScheduledExecution(f.db, f.workspaceId, declared.id)?.status, "completed");
});

test("a Run failure after entering work reconciles as failed rather than failed_to_start", async (t) => {
  const f = await setup(t);
  const task = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(task.statusCode, 201, task.body);
  const taskId = task.json().task.id as string;
  const run = await f.app.inject({ method: "POST", url: `${f.base}/${taskId}/run`, payload: {} });
  assert.equal(run.statusCode, 202, run.body);
  const execution = run.json().execution as {id: string; runId: string};
  f.db.prepare("update agent_run set execution_phase='work_in_progress' where run_id=?").run(execution.runId);
  const service = new ScheduledTaskService(f.ctx, {} as AgentService, {} as AgentRuntimePort);
  service.reconcileActive();
  assert.equal(readScheduledExecution(f.db, f.workspaceId, execution.id)?.status, "running");
  f.db.prepare("update agent_run set status='failed', execution_phase='terminal', terminal_result_code='run_failed' where run_id=?")
    .run(execution.runId);
  service.reconcileActive();
  const settled = readScheduledExecution(f.db, f.workspaceId, execution.id);
  assert.equal(settled?.status, "failed");
  assert.equal(settled?.reasonCode, "run_failed");
  assert.ok(settled?.startedAt);
  const history = await f.app.inject({ method: "GET", url: `${f.base}/${taskId}/executions?result=failed` });
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].id, execution.id);
});

test("invalidated source anchor fails execution without starting a Session or Run", async (t) => {
  const f = await setup(t);
  createMessageSession(f.ctx.db, { workspaceId: f.workspaceId, id: "source-invalid", kind: "primary",
    title: "Source", createdAt: 1 });
  appendMessage(f.ctx.db, { id: "message-invalid", workspaceId: f.workspaceId, sessionId: "source-invalid",
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", createdAt: 10, parts: [] });
  const created = await f.app.inject({ method: "POST", url: f.base, payload: { ...f.payload,
    triggerMode: "fork_message", sourceSessionId: "source-invalid", sourceMessageId: "message-invalid" } });
  assert.equal(created.statusCode, 201, created.body);
  f.ctx.db.prepare("update agent_message set status='streaming' where id='message-invalid'").run();
  const failed = await f.app.inject({ method: "POST", url: `${f.base}/${created.json().task.id}/run`, payload: {} });
  assert.equal(failed.statusCode, 400, failed.body);
  assert.equal(failed.json().code, "SOURCE_MESSAGE_INVALID");
  const executionId = failed.json().details.executionId;
  const stored = readScheduledExecution(f.ctx.db, f.workspaceId, executionId)!;
  assert.equal(stored.status, "failed_to_start");
  assert.equal(stored.reasonCode, "source_anchor_invalid");
  assert.equal(getMessageSession(f.ctx.db, f.workspaceId, stored.sessionId!), null);
  const history = await f.app.inject({ method: "GET", url: `${f.base}/${created.json().task.id}/executions` });
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].sessionId, stored.sessionId);
  assert.equal(history.json().items[0].sessionAvailable, false);
  assert.equal((await f.app.inject({ method: "GET", url: `${f.base}/${created.json().task.id}` }))
    .json().task.latestExecution.sessionAvailable, false);
});

test("Task API: UTC normalization, non-schedule PUT phase, manual claim, active conflict and source fail-closed", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const { task } = created.json();
  assert.equal(Value.Check(ScheduledTaskSchema, task), true);
  assert.equal(task.name, "My Task");
  assert.deepEqual(task.schedule.minutesUtc, [0, 30]);
  const { enabled: _enabled, ...config } = f.payload;
  const modified = await f.app.inject({ method: "PUT", url: `${f.base}/${task.id}`,
    payload: { ...config, name: "  Renamed  ", schedule: { kind: "hourly", minutesUtc: [30, 0] } } });
  assert.equal(modified.statusCode, 200, modified.body);
  assert.equal(modified.json().task.nextRunAt, task.nextRunAt);
  const listed = await f.app.inject({ method: "GET", url: `${f.base}?q=Renamed` });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().items.length, 1);
  const bad = await f.app.inject({ method: "POST", url: `${f.base}/validate-source`,
    payload: { sessionId: "any", messageId: "any" } });
  assert.equal(bad.statusCode, 400);
  const fork = await f.app.inject({ method: "POST", url: f.base,
    payload: { ...f.payload, triggerMode: "fork_message", sourceSessionId: "any", sourceMessageId: "any" } });
  assert.equal(fork.statusCode, 400);
  const run = await f.app.inject({ method: "POST", url: `${f.base}/${task.id}/run`, payload: {} });
  assert.equal(run.statusCode, 202, run.body);
  const execution = run.json().execution;
  assert.equal(Value.Check(ScheduledExecutionSchema, execution), true);
  assert.equal(execution.triggerType, "manual");
  assert.equal(execution.scheduledFor, null);
  assert.equal(execution.status, "starting");
  assert.ok(execution.sessionId);
  assert.equal(execution.sessionId, `sched_${execution.id}`);
  assert.ok(execution.runId);
  assert.equal(getRunRecord(f.db, execution.runId)?.sessionId, execution.sessionId);
  const session = f.db.prepare("select title, title_manually_set as manual from agent_session where id=?")
    .get(execution.sessionId) as { title: string; manual: number };
  assert.deepEqual(session, { title: "Renamed · 定时任务", manual: 1 });
  const second = await f.app.inject({ method: "POST", url: `${f.base}/${task.id}/run`, payload: {} });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "TASK_EXECUTION_ALREADY_ACTIVE");
  const history = await f.app.inject({ method: "GET", url: `${f.base}/${task.id}/executions?triggerType=manual` });
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items.length, 1);
  const del = await f.app.inject({ method: "DELETE", url: `${f.base}/${task.id}` });
  assert.equal(del.statusCode, 409);
});

test("periodic Run reconciliation classifies durable enqueue rejection without re-running or leaking raw details", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id as string;
  const manual = await f.app.inject({ method: "POST", url: `${f.base}/${taskId}/run`, payload: {} });
  assert.equal(manual.statusCode, 202, manual.body);
  const execution = manual.json().execution;
  // Simulate the Agent lifecycle's persisted *terminal* tuple; the scheduled
  // domain only reads this evidence and must not write the Agent run itself.
  f.db.prepare(`update agent_run set status='failed', execution_phase='terminal',
    terminal_result_code='run_enqueue_failed' where run_id=?`).run(execution.runId);
  const service = new ScheduledTaskService(f.ctx, {} as AgentService, {} as AgentRuntimePort);
  service.reconcileActive();
  const history = await f.app.inject({ method: "GET", url: `${f.base}/${taskId}/executions?result=failed` });
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].status, "failed_to_start");
  assert.equal(history.json().items[0].reasonCode, "worker_unavailable");
  const deleted = await f.app.inject({ method: "DELETE", url: `${f.base}/${taskId}` });
  assert.equal(deleted.statusCode, 204, deleted.body);
});

test("Workspace deletion fences Task admission and removes Task/history in the final transaction", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id as string;
  const response = await f.app.inject({ method: "DELETE", url: `/api/workspaces/${f.workspaceId}` });
  assert.equal(response.statusCode, 204, response.body);
  const remaining = f.db.prepare("select count(*) as n from scheduled_agent_task where id=?").get(taskId) as { n: number };
  assert.equal(remaining.n, 0);
  const retry = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(retry.statusCode, 404);
});

test("manual run on a paused task does not alter its next scheduled slot", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: { ...f.payload, enabled: false } });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id as string;
  assert.equal(created.json().task.nextRunAt, null);
  const run = await f.app.inject({ method: "POST", url: `${f.base}/${taskId}/run`, payload: {} });
  assert.equal(run.statusCode, 202, run.body);
  const detail = await f.app.inject({ method: "GET", url: `${f.base}/${taskId}` });
  assert.equal(detail.json().task.nextRunAt, null);
  assert.equal(detail.json().task.enabled, false);
});

test("Agent not ready returns 422 for create, replace and an already-declared manual execution", async (t) => {
  const f = await setup(t);
  const unavailable = { ...f.payload, agentId: "missing-agent" };
  const createRejected = await f.app.inject({ method: "POST", url: f.base, payload: unavailable });
  assert.equal(createRejected.statusCode, 422, createRejected.body);
  assert.equal(createRejected.json().code, "AGENT_NOT_READY");
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id as string;
  const { enabled: _enabled, ...config } = unavailable;
  const replaceRejected = await f.app.inject({ method: "PUT", url: `${f.base}/${taskId}`, payload: config });
  assert.equal(replaceRejected.statusCode, 422, replaceRejected.body);
  assert.equal(replaceRejected.json().code, "AGENT_NOT_READY");
  assert.equal((await f.app.inject({ method: "GET", url: `${f.base}/${taskId}` })).json().task.agentId, "default");
  // The Agent can become unavailable after a valid Task was created.
  f.db.prepare("update scheduled_agent_task set agent_id=? where id=?").run("missing-agent", taskId);
  const runRejected = await f.app.inject({ method: "POST", url: `${f.base}/${taskId}/run`, payload: {} });
  assert.equal(runRejected.statusCode, 422, runRejected.body);
  assert.equal(runRejected.json().code, "AGENT_NOT_READY");
  const executionId = runRejected.json().details?.executionId as string;
  assert.ok(executionId);
  const history = await f.app.inject({ method: "GET", url: `${f.base}/${taskId}/executions?result=failed` });
  assert.equal(history.json().items[0].id, executionId);
  assert.equal(history.json().items[0].status, "failed_to_start");
});

test("running reconciliation is idempotent and does not block later due Tasks", async (t) => {
  const f = await setup(t);
  const first = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  const second = await f.app.inject({ method: "POST", url: f.base,
    payload: { ...f.payload, name: "second task" } });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(second.statusCode, 201, second.body);
  const firstTaskId = first.json().task.id as string;
  const secondTaskId = second.json().task.id as string;
  const manual = await f.app.inject({ method: "POST", url: `${f.base}/${firstTaskId}/run`, payload: {} });
  assert.equal(manual.statusCode, 202, manual.body);
  const execution = manual.json().execution;
  f.db.prepare("update agent_run set execution_phase='work_in_progress' where run_id=?").run(execution.runId);
  const service = new ScheduledTaskService(f.ctx, {} as AgentService, {} as AgentRuntimePort);
  const running = service.reconcile(readScheduledExecution(f.db, f.workspaceId, execution.id)!);
  assert.equal(running.status, "running");
  const unchanged = service.reconcile(readScheduledExecution(f.db, f.workspaceId, execution.id)!);
  assert.equal(unchanged.status, "running");
  assert.equal(unchanged.updatedAt, running.updatedAt);
  const scanNow = Date.now();
  const errors: unknown[] = [];
  const scheduler = new ScheduledTaskScheduler(service, () => scanNow, (error) => errors.push(error));
  try {
    scheduler.start();
    const dueSlot = scanNow - 1;
    f.db.prepare("update scheduled_agent_task set next_run_at=? where id=?").run(dueSlot, secondTaskId);
    await scheduler.tick();
    assert.deepEqual(errors, []);
    const subsequent = service.history({ workspaceId: f.workspaceId, taskId: secondTaskId });
    assert.equal(subsequent.items.length, 1);
    assert.equal(subsequent.items[0]?.scheduledFor, dueSlot);
    assert.equal(service.read(f.workspaceId, firstTaskId).latestExecution?.status, "running");
  } finally { await scheduler.stop(); }
});

test("conflicting Run links retain task mutex even when one referenced Run is still active", async (t) => {
  const f = await setup(t);
  const taskIds: string[] = [];
  const executions: Array<{id: string; runId: string; sessionId: string}> = [];
  for (const name of ["source", "unrelated"]) {
    const created = await f.app.inject({ method: "POST", url: f.base, payload: { ...f.payload, name } });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    taskIds.push(taskId);
    const run = await f.app.inject({ method: "POST", url: `${f.base}/${taskId}/run`, payload: {} });
    assert.equal(run.statusCode, 202, run.body);
    executions.push(run.json().execution);
  }
  const source = executions[0]!;
  const unrelated = executions[1]!;
  // Two real Agent requests exist; the source Run remains active when its dedup link conflicts.
  f.db.prepare(`update agent_client_request set run_id=?
    where workspace_id=? and session_id=? and client_request_id=?`).run(
    unrelated.runId, f.workspaceId, source.sessionId, `scheduled-execution:${source.id}`);
  const diagnostics: string[] = [];
  const service = new ScheduledTaskService(f.ctx, {} as AgentService, {} as AgentRuntimePort,
    Date.now, ({reason}) => { diagnostics.push(reason); });
  service.reconcileActive();
  service.reconcileActive(true);
  assert.deepEqual(diagnostics, ["run_reference_conflict"]);
  assert.equal(readScheduledExecution(f.db, f.workspaceId, source.id)?.status, "starting");
  assert.equal(getRunRecord(f.db, source.runId)?.status, "running");
  const blocked = await f.app.inject({ method: "POST", url: `${f.base}/${taskIds[0]!}/run`, payload: {} });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "TASK_EXECUTION_ALREADY_ACTIVE");
  const dueSlot = service.read(f.workspaceId, taskIds[0]!).nextRunAt!;
  const skipped = service.claim(f.workspaceId, taskIds[0]!, dueSlot, dueSlot) as {status: string; sessionId: string | null};
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.sessionId, null);
});

test("Task API: pause, resume, Workspace boundary, input validation and time", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const task = created.json().task;
  const paused = await f.app.inject({ method: "POST", url: `${f.base}/${task.id}/pause`, payload: {} });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().task.nextRunAt, null);
  const { enabled: _enabled, ...config } = f.payload;
  const changed = await f.app.inject({ method: "PUT", url: `${f.base}/${task.id}`,
    payload: { ...config, schedule: { kind: "daily", minutesOfDayUtc: [500] } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().task.nextRunAt, null);
  const enabled = await f.app.inject({ method: "POST", url: `${f.base}/${task.id}/enable`, payload: {} });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.ok(enabled.json().task.nextRunAt > Date.now());
  const other = await f.app.inject({ method: "GET", url: `/api/workspaces/unrelated/scheduled-tasks/${task.id}` });
  assert.equal(other.statusCode, 404);
  const invalid = await f.app.inject({ method: "POST", url: f.base,
    payload: { ...f.payload, name: "x\0y" } });
  assert.equal(invalid.statusCode, 400);
  const forbidden = await f.app.inject({ method: "POST", url: f.base,
    payload: { ...f.payload, irrelevant: "not allowed" } });
  assert.equal(forbidden.statusCode, 400);
  const time = await f.app.inject({ method: "GET", url: `${f.base}/server-time` });
  assert.equal(time.statusCode, 200, time.body);
  assert.equal(time.json().protocolVersion, 1);
  assert.ok(Math.abs(Date.now() - time.json().now) < 10000);
});

test("full PUT preserves an equal normalized schedule and immutable claimed execution inputs", async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({ method: "POST", url: f.base, payload: f.payload });
  assert.equal(created.statusCode, 201, created.body);
  const task = created.json().task;
  const firstSlot = task.nextRunAt as number;
  assert.deepEqual(task.schedule.minutesUtc, [0, 30]);

  const run = await f.app.inject({ method: "POST", url: `${f.base}/${task.id}/run`, payload: {} });
  assert.equal(run.statusCode, 202, run.body);
  const executionId = run.json().execution.id as string;
  const original = readScheduledExecution(f.db, f.workspaceId, executionId)!;
  const { enabled: _enabled, ...config } = f.payload;
  const replaced = await f.app.inject({ method: "PUT", url: `${f.base}/${task.id}`,
    payload: { ...config, name: "New task", prompt: "New prompt", schedule: { kind: "hourly", minutesUtc: [30, 0] } } });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().task.nextRunAt, firstSlot);
  assert.deepEqual(readScheduledExecution(f.db, f.workspaceId, executionId)?.snapshot, original.snapshot);

  const missingRequired = await f.app.inject({ method: "PUT", url: `${f.base}/${task.id}`,
    payload: { ...config, prompt: undefined } });
  assert.equal(missingRequired.statusCode, 400);
  const changed = await f.app.inject({ method: "PUT", url: `${f.base}/${task.id}`,
    payload: { ...config, name: "New task", schedule: { kind: "hourly", minutesUtc: [5] } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.ok(changed.json().task.nextRunAt > Date.now());
  assert.notEqual(changed.json().task.nextRunAt, firstSlot);
  assert.deepEqual(readScheduledExecution(f.db, f.workspaceId, executionId)?.snapshot, original.snapshot);
});

test("task and execution HTTP cursors enforce scope, filters and OpenAPI exposes the shared contracts", async (t) => {
  const f = await setup(t);
  const taskIds: string[] = [];
  for (const name of ["Alpha one", "Alpha two", "Alpha three"]) {
    const response = await f.app.inject({ method: "POST", url: f.base, payload: { ...f.payload, name } });
    assert.equal(response.statusCode, 201, response.body);
    taskIds.push(response.json().task.id as string);
  }
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const url: string = `${f.base}?q=alpha&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response: Awaited<ReturnType<typeof f.app.inject>> = await f.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, response.body);
    for (const item of response.json().items as Array<{id: string}>) {
      assert.ok(!seen.has(item.id), "cursor returned a duplicate Task");
      seen.add(item.id);
    }
    cursor = response.json().nextCursor as string | null;
  } while (cursor);
  assert.deepEqual(seen, new Set(taskIds));

  const first = await f.app.inject({ method: "GET", url: `${f.base}?q=alpha&limit=1` });
  const firstCursor = first.json().nextCursor as string;
  assert.ok(firstCursor);
  const mismatched = await f.app.inject({ method: "GET",
    url: `${f.base}?q=other&limit=1&cursor=${encodeURIComponent(firstCursor)}` });
  assert.equal(mismatched.statusCode, 400, mismatched.body);
  assert.equal(mismatched.json().code, "CURSOR_INVALID");

  const run = await f.app.inject({ method: "POST", url: `${f.base}/${taskIds[0]!}/run`, payload: {} });
  assert.equal(run.statusCode, 202, run.body);
  const history = await f.app.inject({ method: "GET",
    url: `${f.base}/${taskIds[0]!}/executions?triggerType=manual` });
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].id, run.json().execution.id);
  const otherHistory = await f.app.inject({ method: "GET",
    url: `${f.base}/${taskIds[1]!}/executions?triggerType=manual` });
  assert.deepEqual(otherHistory.json().items, []);

  const specification = await f.app.inject({ method: "GET", url: "/api/openapi.json" });
  assert.equal(specification.statusCode, 200, specification.body);
  const paths = specification.json().paths as Record<string, Record<string, {responses: Record<string, unknown>}>>;
  const root = "/api/workspaces/{workspaceId}/scheduled-tasks";
  assert.ok(paths[root]?.get?.responses["200"]);
  assert.ok(paths[root]?.post?.responses["201"]);
  assert.ok(paths[`${root}/{taskId}/run`]?.post?.responses["202"]);
  assert.ok(paths[`${root}/validate-source`]?.post?.responses["200"]);
  assert.ok(paths[`${root}/ready-agents`]?.get?.responses["200"]);
  assert.ok(paths[`${root}/{taskId}/executions`]?.get?.responses["200"]);
  assert.ok(paths[`${root}/server-time`]?.get?.responses["200"]);
});
