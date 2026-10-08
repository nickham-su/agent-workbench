import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AgentService } from "../agent/agent.service.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import { HttpError } from "../../app/errors.js";
import { createAgentIntegrationFixture } from "../agent/testkit/agent-integration-testkit.js";
import { declareManualExecution, readScheduledExecution, transitionScheduledExecution } from "./scheduled-task.store.js";
import { ScheduledTaskService } from "./scheduled-task.service.js";

async function setup(t: TestContext, error: HttpError) {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const calls: string[] = [];
  const agent = {
    createPrimarySessionWithExpectedId(input: {sessionId: string}) { calls.push(`session:${input.sessionId}`); },
    async sendMessage() { calls.push("start"); throw error; }
  } as unknown as AgentService;
  const service = new ScheduledTaskService(fixture.ctx, agent, {} as AgentRuntimePort);
  const task = service.create(fixture.workspaceId, {
    name: "task", prompt: "Run once", agentId: "default", enabled: true,
    triggerMode: "new_session", sourceSessionId: null, sourceMessageId: null,
    schedule: { kind: "hourly", minutesUtc: [30] }
  });
  return { fixture, calls, task, service };
}

test("unknown enqueue keeps manual execution active and returns 202 semantics; restart does not resend", async (t) => {
  const f = await setup(t, new HttpError(503, "unknown", "AGENT_WORKER_ENQUEUE_UNKNOWN"));
  const execution = await f.service.run(f.fixture.workspaceId, f.task.id);
  assert.equal(execution.status, "starting");
  assert.equal(execution.runId, null);
  assert.deepEqual(f.calls, [`session:${execution.sessionId}`, "start"]);
  assert.equal(f.service.active().length, 1);
  f.service.reconcileActive(true);
  const recovered = readScheduledExecution(f.fixture.db, f.fixture.workspaceId, execution.id)!;
  assert.equal(recovered.status, "failed_to_start");
  assert.equal(recovered.reasonCode, "startup_interrupted_before_run");
  assert.deepEqual(f.calls, [`session:${execution.sessionId}`, "start"]);
});

test("deterministic pre-start failure leaves a durable execution but returns an error with execution ID", async (t) => {
  const f = await setup(t, new HttpError(422, "agent not available", "AGENT_NOT_READY"));
  await assert.rejects(() => f.service.run(f.fixture.workspaceId, f.task.id),
    (error: unknown) => error instanceof HttpError && error.statusCode === 422 && error.code === "AGENT_NOT_READY" &&
      "executionId" in error && typeof error.executionId === "string");
  const history = f.service.history({ workspaceId: f.fixture.workspaceId, taskId: f.task.id });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0]?.status, "failed_to_start");
});

test("periodic scan and recovery retain missing Run references, diagnose once per process and never restart work", async (t) => {
  const f = await setup(t, new HttpError(503, "unknown", "AGENT_WORKER_ENQUEUE_UNKNOWN"));
  const workspaceId = f.fixture.workspaceId;
  const periodicDiagnostics: string[] = [];
  const periodic = new ScheduledTaskService(f.fixture.ctx, {} as AgentService, {} as AgentRuntimePort,
    Date.now, ({executionId}) => { periodicDiagnostics.push(executionId); });
  const first = declareManualExecution(f.fixture.db, { workspaceId, taskId: f.task.id, nowMs: Date.now() });
  transitionScheduledExecution(f.fixture.db, { workspaceId, executionId: first.id,
    status: "starting", runId: "run-missing-before-work", nowMs: Date.now() });
  const otherTask = f.service.create(workspaceId, {
    name: "other", prompt: "Run once", agentId: "default", enabled: true,
    triggerMode: "new_session", sourceSessionId: null, sourceMessageId: null,
    schedule: { kind: "hourly", minutesUtc: [30] }
  });
  const second = declareManualExecution(f.fixture.db, { workspaceId, taskId: otherTask.id, nowMs: Date.now() });
  transitionScheduledExecution(f.fixture.db, { workspaceId, executionId: second.id,
    status: "running", runId: "run-missing-after-work", startedAt: second.createdAt, nowMs: Date.now() });
  periodic.reconcileActive();
  periodic.reconcileActive();
  assert.deepEqual(periodicDiagnostics.sort(), [first.id, second.id].sort());
  const recoveryDiagnostics: string[] = [];
  const restarted = new ScheduledTaskService(f.fixture.ctx, {} as AgentService, {} as AgentRuntimePort,
    Date.now, ({executionId}) => { recoveryDiagnostics.push(executionId); });
  restarted.reconcileActive(true);
  restarted.reconcileActive(true);
  assert.deepEqual(recoveryDiagnostics.sort(), [first.id, second.id].sort());
  const stillStarting = readScheduledExecution(f.fixture.db, workspaceId, first.id)!;
  const stillRunning = readScheduledExecution(f.fixture.db, workspaceId, second.id)!;
  assert.equal(stillStarting.status, "starting");
  assert.equal(stillRunning.status, "running");
  assert.equal(stillStarting.finishedAt, null);
  assert.equal(stillRunning.finishedAt, null);
  assert.equal(restarted.active().length, 2);
  await assert.rejects(() => restarted.run(workspaceId, f.task.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TASK_EXECUTION_ALREADY_ACTIVE");
  assert.deepEqual(f.calls, []); // No Session/Run/Prompt re-creation on restart.
});

test("a Run lookup error cannot turn a periodic or recovery scan into proof of an interrupted start", async (t) => {
  const f = await setup(t, new HttpError(503, "unknown", "AGENT_WORKER_ENQUEUE_UNKNOWN"));
  const execution = declareManualExecution(f.fixture.db, {
    workspaceId: f.fixture.workspaceId, taskId: f.task.id, nowMs: Date.now()
  });
  let queriesFail = true;
  const rejectingDb = new Proxy(f.fixture.db, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (queriesFail && sql.includes("from agent_client_request")) throw new Error("private DB diagnostic");
      return target.prepare(sql);
    };
    return Reflect.get(target, property);
  } });
  const diagnostics: Array<{executionId: string; reason: string}> = [];
  const service = new ScheduledTaskService({ ...f.fixture.ctx, db: rejectingDb },
    {} as AgentService, {} as AgentRuntimePort, Date.now, (diagnostic) => diagnostics.push(diagnostic));
  service.reconcileActive();
  service.reconcileActive(true);
  assert.deepEqual(diagnostics, [{ executionId: execution.id, reason: "run_reference_query_failed" }]);
  assert.equal(readScheduledExecution(f.fixture.db, f.fixture.workspaceId, execution.id)?.status, "starting");
  queriesFail = false;
  service.reconcileActive(true);
  assert.equal(readScheduledExecution(f.fixture.db, f.fixture.workspaceId, execution.id)?.reasonCode,
    "startup_interrupted_before_run");
  assert.deepEqual(f.calls, []);
});

test("first scan silently advances overdue slots; later scan claims only one and skips while active", async (t) => {
  const f = await setup(t, new HttpError(503, "unknown", "AGENT_WORKER_ENQUEUE_UNKNOWN"));
  const original = f.task.nextRunAt!;
  const startupNow = original + 7_200_000;
  f.service.silentCatchUp(startupNow);
  const afterCatchup = f.service.read(f.fixture.workspaceId, f.task.id);
  assert.ok(afterCatchup.nextRunAt! > startupNow);
  assert.equal(f.service.history({workspaceId: f.fixture.workspaceId, taskId: f.task.id}).items.length, 0);
  assert.equal(f.service.claim(f.fixture.workspaceId, f.task.id, original, startupNow), null);
  const slot = afterCatchup.nextRunAt!;
  const first = f.service.claim(f.fixture.workspaceId, f.task.id, slot, slot + 500)!;
  assert.equal(first.status, "starting");
  assert.equal(first.snapshot.taskName, "task");
  const next = f.service.read(f.fixture.workspaceId, f.task.id).nextRunAt!;
  assert.ok(next > slot + 500);
  const skipped = f.service.claim(f.fixture.workspaceId, f.task.id, next, next + 500)!;
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.sessionId, null);
  assert.equal(f.service.read(f.fixture.workspaceId, f.task.id).latestScheduledExecution?.status, "skipped");
});
