import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AgentMessageQueueSnapshotSchema } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { createMessageRunRecord, startMessageRun, getMessageSessionHead } from "../agent-message.store.js";
import { AgentMessageQueueDispatcher } from "./message-queue.dispatcher.js";
import { createAgentMessageQueueAssembly } from "./message-queue.assembly.js";
import { queueFixture, scope, identity, errorIs } from "./message-queue.testkit.js";

for (const runtimeKind of ["worker", "local_fallback"] as const) {
  test(`${runtimeKind}: dual scanners activate one trigger, Run, admission and legacy dedup; receipt stays unconfirmed`, async t => {
    const f = await queueFixture(t, runtimeKind);
    const accepted = await f.accept("first"); await f.accept("second");
    const second = new AgentMessageQueueDispatcher(f.store, { lifecycle: f.lifecycle, runtime: f.runtime, resolveProfile: f.resolveProfile });
    await Promise.all([f.dispatcher.dispatchSession(scope), second.dispatchSession(scope)]);
    assert.equal(f.enqueued.length, 1);
    const runId = f.enqueued[0]!.runId;
    const receipt = f.store.get(scope, accepted.receipt.id);
    assert.equal(receipt.status, "injected"); assert.equal(receipt.injected_run_id, runId);
    assert.equal(receipt.confirmation_state, "unconfirmed");
    const count = (table: string) => (f.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    assert.equal(count("agent_run"), 1); assert.equal(count("agent_message"), 1);
    assert.equal(count("agent_client_request"), 1); assert.equal(count("agent_interactive_run_input"), 1);
    assert.equal((f.db.prepare("select interactive_queue_enabled as enabled from agent_run").get() as { enabled: number }).enabled, 1);
    assert.equal((f.db.prepare("select runtime_instance_id as id from agent_run_runtime_admission").get() as { id: string }).id, f.runtimeInstanceId);
    const snapshot = f.store.snapshot(scope);
    assert.equal(snapshot.pendingCount, 1); assert.equal(snapshot.unconfirmedInputCount, 1);
    assert.equal(snapshot.queueVersion, 3); assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, snapshot), true);
    assert.throws(() => f.service.cancel(scope, accepted.receipt.id), errorIs(409, "AGENT_RECEIPT_ALREADY_INJECTED"));
    assert.equal((await f.accept("first")).receipt.status, "injected");
    await second.close();
  });
}

test("activation transaction rolls back message, Run, input link, dedup, admission and queueVersion together", async t => {
  const f = await queueFixture(t); const a = await f.accept("a");
  f.db.exec("create trigger break_input before insert on agent_interactive_run_input begin select raise(abort,'test input rollback'); end");
  assert.throws(() => f.persistence.activateQueuedUserRun({ ...scope, receiptId: a.receipt.id, runId: "rollback", createdAt: 2 }), /test input rollback/);
  assert.equal(f.store.get(scope, a.receipt.id).status, "queued");
  for (const table of ["agent_run", "agent_message", "agent_client_request", "agent_run_runtime_admission", "agent_interactive_run_input"])
    assert.equal((f.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n, 0);
  assert.deepEqual(getMessageSessionHead(f.db, scope), { headMessageId: null, revision: 0 });
  assert.equal(f.store.snapshot(scope).queueVersion, 1);
});

test("cancel-first cannot activate; cancelling after injection conflicts; FIFO cannot be bypassed", async t => {
  const f = await queueFixture(t); const a = await f.accept("a"); const b = await f.accept("b");
  assert.throws(() => f.persistence.activateQueuedUserRun({ ...scope, receiptId: b.receipt.id, runId: "overtake", createdAt: 2 }), errorIs(409, "AGENT_QUEUE_NOT_DISPATCHABLE"));
  f.service.cancel(scope, a.receipt.id);
  assert.throws(() => f.persistence.activateQueuedUserRun({ ...scope, receiptId: a.receipt.id, runId: "cancelled", createdAt: 2 }), errorIs(409));
  const active = await f.dispatcher.dispatchSession(scope); assert.ok(active);
  assert.throws(() => f.service.cancel(scope, b.receipt.id), errorIs(409));
  assert.equal(f.store.get(scope, b.receipt.id).injected_run_id, active.runId);
});

test("authority transaction rejects draining historical executions even with idle current pointer", async t => {
  const f = await queueFixture(t);
  const a = await f.accept("a");
  createMessageRunRecord(f.db, { ...scope, runId: "draining", triggerMessageId: null, interactiveQueue: true, ...identity, status: "running", createdAt: 1 });
  await assert.rejects(f.accept("late"), errorIs(409, "AGENT_QUEUE_EXECUTION_NOT_DRAINED"));
  const activation = f.persistence.activateQueuedUserRun({ ...scope, receiptId: a.receipt.id, runId: "illegal", createdAt: 2 });
  assert.equal(activation.kind, "session-running");
  assert.equal(f.store.get(scope, a.receipt.id).status, "queued");
});

test("enqueue unknown keeps the original Run and pauses; lifecycle reconciliation retries only that Run", async t => {
  const f = await queueFixture(t); const a = await f.accept("a"); await f.accept("b");
  f.setEnqueueError(new HttpError(503, "Transport unknown", "AGENT_WORKER_ENQUEUE_UNKNOWN"));
  await f.dispatcher.dispatchSession(scope);
  assert.equal(f.store.snapshot(scope).pauseCode, "recovery_required");
  const runId = f.store.get(scope, a.receipt.id).injected_run_id;
  assert.ok(runId); assert.equal(f.enqueued.length, 1);
  const secondTry = await f.lifecycle.startQueuedUserRun({ ...scope, receiptId: a.receipt.id, inputText: "hello", runtime: f.runtime });
  assert.equal(secondTry!.runId, runId); assert.equal(secondTry!.deduplicated, true);
  assert.equal(f.enqueued.length, 1, "receipt replay never enqueues again");
  f.setEnqueueError(null);
  // Exercise the existing same-Run handoff directly, without depending on its backoff timer.
  await f.lifecycle.enqueueActivatedRunOrReconcile({ runtime: f.runtime, run: f.enqueued[0]! });
  await f.dispatcher.scanOnce();
  assert.deepEqual(new Set(f.enqueued.map(run => run.runId)), new Set([runId]));
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 1);
});

test("completed legacy Run permits queued activation; completed interactive Run with unconfirmed input does not replay", async t => {
  const f = await queueFixture(t);
  createMessageRunRecord(f.db, { ...scope, runId: "old", triggerMessageId: null, ...identity, status: "running", createdAt: 1 });
  startMessageRun(f.db, { ...scope, runId: "old", updatedAt: 1 });
  const a = await f.accept("a"); await f.accept("b");
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
  f.finish("old");
  const activated = await f.dispatcher.dispatchSession(scope); assert.ok(activated);
  f.finish(activated.runId);
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
  assert.equal(f.store.get(scope, a.receipt.id).confirmation_state, "unconfirmed");
  assert.equal(f.enqueued.length, 1);
});

test("failed Run pauses only its active queue and preserves queued receipts and existing pause reasons", async t => {
  const f = await queueFixture(t); await f.accept("a"); await f.accept("b");
  const active = await f.dispatcher.dispatchSession(scope); assert.ok(active);
  f.finish(active.runId, "failed");
  assert.equal(f.store.snapshot(scope).pauseCode, "run_failed");
  assert.equal(f.store.snapshot(scope).pendingCount, 1);
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
  f.store.pause(scope, "profile_unavailable");
  assert.equal(f.store.snapshot(scope).pauseCode, "run_failed");
});

test("Stop returns stable acceptance and current pending evidence; old operation replay cannot cancel successor work", async t => {
  const f = await queueFixture(t); await f.accept("a");
  await f.dispatcher.dispatchSession(scope);
  const first = f.service.stop(scope, "stop-a");
  assert.equal(first.queue.mode, "paused"); assert.equal(first.queue.stop.state, "pending");
  await f.runtime.reconcileStops();
  const calls = f.stopCalls.length;
  await assert.rejects(f.accept("queued-after-stop"), errorIs(409, "AGENT_SESSION_STOP_PENDING"));
  const replay = f.service.stop(scope, "stop-a");
  assert.deepEqual(replay.stopOperation, first.stopOperation);
  assert.ok(replay.queue.queueVersion >= first.queue.queueVersion);
  assert.equal(replay.queue.pendingCount, 0); assert.equal(f.stopCalls.length, calls);
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
});

test("queue barriers cannot be bypassed by direct authoritative activation", async t => {
  const f = await queueFixture(t);
  createMessageRunRecord(f.db, { ...scope, runId: "old", triggerMessageId: null, ...identity, status: "running", createdAt: 1 });
  startMessageRun(f.db, { ...scope, runId: "old", updatedAt: 1 });
  await f.runtime.enqueueRun({ ...scope, runId: "old", workspacePath: f.workspacePath, workspaceRepoDirNames: [] });
  const queued = await f.accept("first");
  f.service.stop(scope, "stop");
  // Even accidental reopening does not clear the fixed-target runtime fence.
  f.db.prepare("update agent_session_queue_control set mode='active',pause_code=null where session_id='s1'").run();
  assert.throws(() => f.persistence.activateQueuedUserRun({ ...scope, receiptId: queued.receipt.id, runId: "illegal", createdAt: 4 }), errorIs(409, "AGENT_SESSION_STOP_PENDING"));
});

test("dormant assembly admits nothing before explicit recovery and cannot reopen after close", async t => {
  const f = await queueFixture(t);
  const assembly = createAgentMessageQueueAssembly({ db: f.db, dataDir: f.dataDir, lifecycle: f.lifecycle, runtimeControl: f.runtime, resolveProfile: f.resolveProfile });
  await assert.rejects(assembly.service.accept("s1", { workspaceId: "w1", clientRequestId: "before", text: "hi" }), errorIs(503));
  assert.equal(await assembly.close(), true);
  assembly.openAfterRuntimeRecovery();
  await assert.rejects(assembly.service.accept("s1", { workspaceId: "w1", clientRequestId: "after", text: "hi" }), errorIs(503));
  assert.equal(f.enqueued.length, 0);
});

test("dispatcher close is bounded even during a blocked handoff and rejects subsequent scans", async t => {
  const f = await queueFixture(t); await f.accept("a");
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const dispatcher = new AgentMessageQueueDispatcher(f.store, { lifecycle: { startQueuedUserRun: async () => { await blocked; return null; } }, runtime: f.runtime, resolveProfile: f.resolveProfile });
  const pending = dispatcher.scanOnce();
  assert.equal(await dispatcher.close(1), false);
  release(); await pending;
  assert.equal(await dispatcher.close(), true);
  assert.equal(await dispatcher.dispatchSession(scope), null);
});

test("timer scan errors are handled, retried and closed without unhandled rejection", async t => {
  const f = await queueFixture(t); let errors = 0;
  let observed!: () => void; const scanned = new Promise<void>(resolve => { observed = resolve; });
  const broken = Object.create(f.store) as typeof f.store;
  Object.defineProperty(broken, "db", { value: { prepare: () => { throw new Error("test scan failure"); } } });
  const dispatcher = new AgentMessageQueueDispatcher(broken, { lifecycle: f.lifecycle, runtime: f.runtime, resolveProfile: f.resolveProfile, intervalMs: 1, onScanError: () => { errors++; observed(); } });
  dispatcher.start();
  await scanned; await dispatcher.close();
  assert.ok(errors > 0);
});

test("DB-terminal Run with an unretired binding still fences queue activation until trusted retirement", async t => {
  const f = await queueFixture(t);
  createMessageRunRecord(f.db, { ...scope, runId: "old", triggerMessageId: null, ...identity, status: "running", createdAt: 1 });
  startMessageRun(f.db, { ...scope, runId: "old", updatedAt: 1 });
  await f.runtime.enqueueRun({ ...scope, runId: "old", workspacePath: f.workspacePath, workspaceRepoDirNames: [] });
  const a = await f.accept("a");
  f.finish("old");
  assert.equal(f.persistence.activateQueuedUserRun({ ...scope, receiptId: a.receipt.id, runId: "premature", createdAt: 3 }).kind, "session-running");
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
  assert.deepEqual(f.runtimeStore.retireAdmission({ ...scope, runId: "old", runtimeInstanceId: f.runtimeInstanceId }), { retired: true });
  const active = await f.dispatcher.dispatchSession(scope); assert.ok(active);
  assert.notEqual(active.runId, "old");
});

test("definitive enqueue rejection converges the same Run and leaves remaining receipts paused", async t => {
  const f = await queueFixture(t); const a = await f.accept("a"); await f.accept("b");
  f.setEnqueueError(new HttpError(503, "Rejected", "AGENT_WORKER_ENQUEUE_REJECTED"));
  await f.dispatcher.dispatchSession(scope);
  const runId = f.store.get(scope, a.receipt.id).injected_run_id!;
  assert.equal((f.db.prepare("select status from agent_run where run_id=?").get(runId) as { status: string }).status, "failed");
  assert.equal(f.store.snapshot(scope).pauseCode, "run_failed");
  assert.equal(f.store.snapshot(scope).pendingCount, 1);
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
});

test("bounded Session cursor rotates past persistently busy pages and preserves per-instance single flight", async t => {
  const f = await queueFixture(t); await f.accept("a");
  const { createMessageSession } = await import("../agent-message.store.js");
  createMessageSession(f.db, { id: "s2", workspaceId: "w1", title: "next", kind: "primary", createdAt: 1 });
  await f.service.accept("s2", { workspaceId: "w1", clientRequestId: "b", text: "next" });
  const calls: string[] = [];
  const dispatcher = new AgentMessageQueueDispatcher(f.store, { batchSize: 1, lifecycle: { startQueuedUserRun: async input => { calls.push(input.sessionId); return null; } }, runtime: f.runtime, resolveProfile: f.resolveProfile });
  const one = dispatcher.scanOnce(); assert.equal(dispatcher.scanOnce(), one); await one;
  await dispatcher.scanOnce(); await dispatcher.scanOnce(); await dispatcher.scanOnce();
  assert.deepEqual(calls, ["s1", "s2", "s1"]);
  await dispatcher.close();
});

test("closing receipt admission waits boundedly for publication callbacks and prevents post-close receipt commits", async t => {
  const f = await queueFixture(t);
  const publish = f.publications.publishAndCommit.bind(f.publications);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; });
  f.publications.publishAndCommit = async (request, commit) => { arrived(); await gate; return publish(request, commit); };
  const accepting = f.accept("closing");
  await entered;
  assert.equal(await f.service.close(1), false);
  release();
  await assert.rejects(accepting, errorIs(503, "AGENT_QUEUE_STOPPING"));
  assert.equal(await f.service.close(), true);
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
});

test("replaying a quiescent old Stop never targets a subsequently activated Run", async t => {
  const f = await queueFixture(t);
  const first = f.service.stop(scope, "old-stop");
  assert.equal(first.stopOperation.targetCount, 0);
  // Simulate S5's trusted resume transition; public resume intentionally does not exist in S4.
  f.db.prepare("update agent_session_queue_control set mode='active',pause_code=null,queue_version=queue_version+1 where session_id='s1'").run();
  await f.accept("successor");
  const successor = await f.dispatcher.dispatchSession(scope); assert.ok(successor);
  const replay = f.service.stop(scope, "old-stop");
  assert.deepEqual(replay.stopOperation, first.stopOperation);
  assert.equal(replay.queue.mode, "active");
  assert.equal(replay.queue.unconfirmedInputCount, 1);
  assert.equal((f.db.prepare("select status from agent_run where run_id=?").get(successor.runId) as { status: string }).status, "running");
  assert.equal(f.stopCalls.length, 0);
});

for (const window of ["starting", "exit"] as const) test(`Worker ${window}: temporary scan gate retains receipts without activating and ready reopens once`, async t => {
  const f = await queueFixture(t);
  const head = getMessageSessionHead(f.db, scope);
  f.dispatcher.suspendRuntimeDispatch(); f.runtime.blockAdmission();
  const accepted = await f.accept(`during-${window}`);
  await f.dispatcher.scanOnce(); await f.dispatcher.dispatchSession(scope);
  const snapshot = f.store.snapshot(scope);
  assert.equal(snapshot.mode, "active"); assert.equal(snapshot.pendingCount, 1); assert.equal(snapshot.unconfirmedInputCount, 0);
  assert.equal(f.store.get(scope, accepted.receipt.id).status, "queued");
  assert.deepEqual(getMessageSessionHead(f.db, scope), head);
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 0);
  assert.equal(f.enqueued.length, 0);
  f.runtime.openAdmission(); f.dispatcher.resumeRuntimeDispatch();
  await f.dispatcher.scanOnce(); await f.dispatcher.dispatchSession(scope);
  assert.equal(f.enqueued.length, 1); assert.equal(f.store.get(scope, accepted.receipt.id).status, "injected");
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 1);
  assert.equal(await f.dispatcher.close(), true);
  f.dispatcher.resumeRuntimeDispatch();
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
});

test("in-flight dispatch crossing suspend/ready cannot activate with a stale admission epoch", async t => {
  const f = await queueFixture(t); const accepted = await f.accept("in-flight");
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dispatcher = new AgentMessageQueueDispatcher(f.store, {
    runtime: f.runtime, resolveProfile: f.resolveProfile,
    lifecycle: { startQueuedUserRun: async command => { entered(); await blocked; return f.lifecycle.startQueuedUserRun(command); } },
  });
  t.after(() => dispatcher.close());
  const dispatching = dispatcher.dispatchSession(scope); await started;
  dispatcher.suspendRuntimeDispatch(); f.runtime.blockAdmission();
  f.runtime.openAdmission(); dispatcher.resumeRuntimeDispatch(); release();
  assert.equal(await dispatching, null);
  assert.equal(f.store.get(scope, accepted.receipt.id).status, "queued");
  assert.equal(f.store.snapshot(scope).mode, "active"); assert.equal(f.enqueued.length, 0);
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 0);
  assert.ok(await dispatcher.dispatchSession(scope)); assert.equal(f.enqueued.length, 1);
});

test("activation transaction checks the same dispatch gate after lifecycle async preparation", async t => {
  const f = await queueFixture(t); const accepted = await f.accept("transaction-race");
  const activate = f.persistence.activateQueuedUserRun.bind(f.persistence);
  f.persistence.activateQueuedUserRun = command => {
    f.dispatcher.suspendRuntimeDispatch(); f.runtime.blockAdmission();
    return activate(command);
  };
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
  assert.equal(f.store.get(scope, accepted.receipt.id).status, "queued");
  assert.equal(f.store.snapshot(scope).mode, "active"); assert.equal(f.enqueued.length, 0);
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 0);
});
