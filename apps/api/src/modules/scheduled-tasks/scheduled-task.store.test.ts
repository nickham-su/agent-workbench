import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../../infra/db/schema.js";
import { createMessageSession } from "../agent/agent-message.store.js";
import {
  createScheduledTask, replaceScheduledTask, setScheduledTaskEnabled, deleteScheduledTask,
  declareScheduledSlot, declareManualExecution, transitionScheduledExecution,
  readScheduledTask, readScheduledExecution, listDueScheduledTasks, listScheduledTasks,
  listScheduledExecutions, toScheduledTask
} from "./scheduled-task.store.js";
import { decodeTaskCursor, decodeExecutionCursor, CursorInvalidError, createScheduledCursorCodec } from "./scheduled-cursor.js";
import { Value } from "@sinclair/typebox/value";
import { ScheduledTaskSchema } from "@agent-workbench/shared";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(`insert into workspaces (id, dir_name, title, path, created_at, updated_at)
    values (?, ?, ?, ?, 1, 1)`).run("one", "one", "one", "one");
  db.prepare(`insert into workspaces (id, dir_name, title, path, created_at, updated_at)
    values (?, ?, ?, ?, 1, 1)`).run("two", "two", "two", "two");
  return db;
}
const cfg = () => ({ name: "task", prompt: "Do work", agentId: "agent", triggerMode: "new_session" as const,
  schedule: { kind: "hourly" as const, minutesUtc: [0, 30] }, source: null });
function task(db: ReturnType<typeof fixture>, id = "task", workspaceId = "one") {
  return createScheduledTask(db, { workspaceId, id, configuration: cfg(), enabled: true, nowMs: 60_000 });
}

test("schema initializes independently and preserves scheduled data on reinitialization", () => {
  const db = fixture();
  try {
    const prior = task(db);
    const meta = db.prepare("select version from agent_schema_meta where id=1").get();
    initSchema(db);
    assert.deepEqual(db.prepare("select version from agent_schema_meta where id=1").get(), meta);
    assert.deepEqual(readScheduledTask(db, "one", "task"), prior);
    assert.equal(readScheduledTask(db, "two", "task"), null);
    assert.throws(() => db.prepare(`insert into scheduled_agent_task (id, workspace_id, name, enabled, trigger_mode, prompt,
      agent_id, schedule_json, created_at, updated_at) values ('orphan','absent','x',0,'new_session','p','a','{}',1,1)`).run());
    assert.throws(() => db.prepare("delete from workspaces where id='one'").run());
  } finally { db.close(); }
});

test("status transitions require classified Run evidence; only starting can fail to start", () => {
  const db = fixture();
  try {
    task(db);
    const declare = (id: string, nowMs: number) => declareManualExecution(db, {
      workspaceId: "one", taskId: "task", nowMs, executionId: id, sessionId: `session-${id}`
    });
    const change = (id: string, status: "starting" | "running" | "completed" | "failed" | "cancelled" | "failed_to_start",
      nowMs: number, options: Record<string, unknown> = {}) =>
      transitionScheduledExecution(db, { workspaceId: "one", executionId: id, status, nowMs, ...options });
    const noWork = declare("pre", 100_000);
    assert.throws(() => change(noWork.id, "completed", 101_000, { startedAt: 100_500 }));
    assert.throws(() => change(noWork.id, "completed", 101_000, { runId: "run-pre" }));
    assert.throws(() => change(noWork.id, "failed", 101_000, { runId: "run-pre" }));
    assert.throws(() => change(noWork.id, "cancelled", 101_000, { runId: "run-pre" }));
    assert.throws(() => change(noWork.id, "failed_to_start", 101_000));
    assert.throws(() => change(noWork.id, "failed_to_start", 101_000, { reasonCode: "surprise_string" }));
    assert.throws(() => change(noWork.id, "failed_to_start", 101_000, { reasonCode: "run_cancelled" }));
    assert.throws(() => change(noWork.id, "failed_to_start", 101_000, { reasonCode: "source_unavailable",
      reasonDetail: "raw\nprovider output" }));
    assert.equal(readScheduledExecution(db, "one", noWork.id)?.status, "starting");
    assert.equal(change(noWork.id, "failed_to_start", 101_000, { reasonCode: "startup_interrupted_before_run" })?.status,
      "failed_to_start");
    assert.throws(() => change(noWork.id, "running", 102_000, { startedAt: 101_000, runId: "run-pre" }));

    declare("with-run", 110_000);
    assert.equal(change("with-run", "failed_to_start", 111_000, { runId: "durable-run", reasonCode: "worker_unavailable" })?.runId,
      "durable-run"); // Proved never entered work: enqueue rejected.

    declare("rapid", 120_000);
    assert.equal(change("rapid", "completed", 121_000, { runId: "run-rapid", startedAt: 120_100 })?.status,
      "completed"); // Recovered fast Run without an intermediate running status.
    assert.throws(() => change("rapid", "cancelled", 122_000, { runId: "run-rapid", reasonCode: "run_cancelled" }));

    declare("rapid-failure", 123_000);
    assert.equal(change("rapid-failure", "failed", 124_000, {
      runId: "run-rapid-failure", startedAt: 123_100, reasonCode: "run_failed", reasonDetail: "Run failed"
    })?.status,
      "failed");

    declare("running", 130_000);
    assert.throws(() => change("running", "running", 131_000, { runId: "run-running" }));
    change("running", "running", 131_000, { runId: "run-running", startedAt: 130_100 });
    assert.throws(() => change("running", "failed_to_start", 132_000, { reasonCode: "worker_unavailable" }));
    assert.throws(() => change("running", "starting", 132_000));
    assert.throws(() => change("running", "failed", 132_000, { runId: "other-run" }));
    assert.throws(() => change("running", "completed", 132_000, { startedAt: null }));
    assert.throws(() => change("running", "failed", 132_000, { reasonCode: "previous_execution_running" }));
    assert.throws(() => change("running", "failed", 132_000, { reasonCode: "startup_interrupted_before_run" }));
    assert.equal(change("running", "failed", 132_000)?.startedAt, 130_100);

    declare("cancel", 140_000);
    assert.equal(change("cancel", "cancelled", 141_000, { runId: "run-cancel", reasonCode: "run_cancelled" })?.startedAt,
      null); // Persisted Run may be cancelled before it entered work.
  } finally { db.close(); }
});

test("cursor authenticates structurally valid modifications and binds workspace, task and process lifetime", () => {
  const db = fixture();
  try {
    task(db, "a"); task(db, "b"); task(db, "foreign", "two");
    const taskToken = listScheduledTasks(db, { workspaceId: "one", limit: 1 }).nextCursor!;
    const [payload, signature] = taskToken.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    decoded.after.id = "forged-but-valid";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    assert.throws(() => listScheduledTasks(db, { workspaceId: "one", cursor: forged }), { code: "CURSOR_INVALID" });
    assert.throws(() => listScheduledTasks(db, { workspaceId: "two", cursor: taskToken }), { code: "CURSOR_INVALID" });
    const filter = { status: "all" as const, q: null };
    assert.throws(() => createScheduledCursorCodec().decodeTask(taskToken, filter, "one"), CursorInvalidError);
    const codecA = createScheduledCursorCodec();
    const codecB = createScheduledCursorCodec();
    const issued = codecA.encodeTask({ v: 1, filter, after: { id: "a", enabled: 1, updatedAt: 1 } }, "one");
    assert.equal(codecA.decodeTask(issued, filter, "one").after.id, "a");
    assert.throws(() => codecB.decodeTask(issued, filter, "one"), CursorInvalidError);

    const first = declareManualExecution(db, { workspaceId: "one", taskId: "a", nowMs: 80_000, executionId: "e1", sessionId: "s1" });
    transitionScheduledExecution(db, { workspaceId: "one", executionId: first.id, status: "failed_to_start", nowMs: 81_000,
      reasonCode: "startup_interrupted_before_run" });
    declareManualExecution(db, { workspaceId: "one", taskId: "a", nowMs: 90_000, executionId: "e2", sessionId: "s2" });
    const executionToken = listScheduledExecutions(db, { workspaceId: "one", taskId: "a", limit: 1 }).nextCursor!;
    assert.throws(() => listScheduledExecutions(db, { workspaceId: "one", taskId: "b", cursor: executionToken }),
      { code: "CURSOR_INVALID" });
    assert.throws(() => listScheduledExecutions(db, { workspaceId: "two", taskId: "a", cursor: executionToken }),
      { code: "CURSOR_INVALID" });
    const [executionPayload, executionSignature] = executionToken.split(".");
    const alteredExecution = JSON.parse(Buffer.from(executionPayload!, "base64url").toString("utf8"));
    alteredExecution.after.createdAt = 1;
    assert.throws(() => decodeExecutionCursor(`${Buffer.from(JSON.stringify(alteredExecution)).toString("base64url")}.${executionSignature}`,
      { result: "all", triggerType: "all" }, "one", "a"), CursorInvalidError);
  } finally { db.close(); }
});

test("task SQL CHECKs and execution SQL CHECKs and indexes reject malformed records", () => {
  const db = fixture();
  try {
    const original = task(db);
    for (const sql of [
      "update scheduled_agent_task set enabled=0 where id='task'",
      "update scheduled_agent_task set trigger_mode='fork_message' where id='task'",
      "update scheduled_agent_task set trigger_mode='bad' where id='task'"
    ]) assert.throws(() => db.prepare(sql).run());
    const one = declareScheduledSlot(db, { workspaceId: "one", taskId: "task", scheduledFor: original.nextRunAt!, nowMs: original.nextRunAt!, executionId: "e1", sessionId: "s1" })!;
    assert.equal(one.clientRequestId, "scheduled-execution:e1");
    assert.throws(() => db.prepare("update scheduled_agent_execution set session_id=null where id='e1'").run());
    assert.throws(() => db.prepare("update scheduled_agent_execution set status='running' where id='e1'").run());
    assert.throws(() => db.prepare("update scheduled_agent_execution set finished_at=1 where id='e1'").run());
    assert.throws(() => db.prepare(`insert into scheduled_agent_execution
      (id,task_id,trigger_type,scheduled_for,status,task_snapshot_json,client_request_id,session_id,created_at,updated_at)
      values ('e2','task','scheduled',?, 'starting','{}','new-id','s2',1,1)`).run(one.scheduledFor));
    assert.throws(() => declareManualExecution(db, { workspaceId: "one", taskId: "task", nowMs: 61_000 }),
      { code: "TASK_EXECUTION_ALREADY_ACTIVE" });
    assert.throws(() => deleteScheduledTask(db, "one", "task"), { code: "TASK_DELETE_EXECUTION_ACTIVE" });
    assert.equal(readScheduledExecution(db, "two", "e1"), null);
  } finally { db.close(); }
});

test("declaration advances slot without touching config timestamp, overlaps skip and snapshot stays immutable", () => {
  const db = fixture();
  try {
    const original = task(db);
    const forTime = original.nextRunAt!;
    assert.equal(declareScheduledSlot(db, { workspaceId: "one", taskId: "task", scheduledFor: forTime, nowMs: forTime - 1 }), null);
    const first = declareScheduledSlot(db, { workspaceId: "one", taskId: "task", scheduledFor: forTime, nowMs: forTime,
      executionId: "e1", sessionId: "s1" })!;
    assert.equal(first.status, "starting");
    assert.deepEqual(first.snapshot, { taskName: "task", triggerMode: "new_session", prompt: "Do work", agentId: "agent",
      sourceSessionId: null, sourceMessageId: null });
    assert.equal(readScheduledTask(db, "one", "task")!.updatedAt, original.updatedAt);
    assert.equal(declareScheduledSlot(db, { workspaceId: "one", taskId: "task", scheduledFor: forTime, nowMs: forTime }), null);
    const secondSlot = readScheduledTask(db, "one", "task")!.nextRunAt!;
    const skip = declareScheduledSlot(db, { workspaceId: "one", taskId: "task", scheduledFor: secondSlot, nowMs: secondSlot,
      executionId: "e2" })!;
    assert.equal(skip.status, "skipped");
    assert.equal(skip.sessionId, null);
    assert.equal(skip.reasonCode, "previous_execution_running");
    const replaced = replaceScheduledTask(db, { workspaceId: "one", taskId: "task", nowMs: secondSlot + 1,
      configuration: { ...cfg(), name: "new name", schedule: { kind: "hourly", minutesUtc: [30, 0, 30] } } });
    assert.equal(replaced.nextRunAt, readScheduledTask(db, "one", "task")!.nextRunAt);
    assert.equal(replaced.nextRunAt, secondSlot + 30 * 60_000);
    assert.equal(readScheduledExecution(db, "one", "e1")!.snapshot.taskName, "task");
    assert.equal(toScheduledTask(db, replaced).latestScheduledExecution?.status, "skipped");
    assert.equal(toScheduledTask(db, replaced).latestExecution?.status, "skipped");
    const projection = listScheduledTasks(db, { workspaceId: "one" }).items[0]!;
    assert.equal(Value.Check(ScheduledTaskSchema, projection), true);
    assert.equal(projection.latestExecution?.status, "skipped");
    assert.equal(projection.activeExecution?.id, "e1", "newer skip cannot hide running execution");
    assert.equal(projection.activeExecution?.sessionAvailable, false, "reserved ID is not a Session");
    assert.equal(projection.latestScheduledExecution?.reasonCode, "previous_execution_running");
    assert.equal("snapshot" in projection.latestExecution!, false);
    createMessageSession(db, { workspaceId: "one", id: "s1", kind: "primary", title: "Run", createdAt: 1 });
    assert.equal(toScheduledTask(db, replaced).activeExecution?.sessionAvailable, false, "an unrelated Session is not an execution Session");
    assert.equal(listScheduledExecutions(db, { workspaceId: "one", taskId: "task" }).items.find((e) => e.id === "e1")?.sessionAvailable, false);
    transitionScheduledExecution(db, { workspaceId: "one", executionId: "e1", status: "completed",
      nowMs: secondSlot + 1, runId: "run-e1", startedAt: forTime });
    declareManualExecution(db, { workspaceId: "one", taskId: "task", nowMs: secondSlot + 2,
      executionId: "e3", sessionId: "s3" });
    assert.equal(toScheduledTask(db, replaced).activeExecution?.id, "e3");
    const afterManual = listScheduledTasks(db, { workspaceId: "one" }).items[0]!;
    assert.equal(Value.Check(ScheduledTaskSchema, afterManual), true);
    assert.equal(afterManual.latestExecution?.id, "e3");
    assert.equal(afterManual.latestScheduledExecution?.id, "e2");
    assert.equal("snapshot" in afterManual.latestExecution!, false);
    assert.equal(readScheduledTask(db, "two", "task"), null);
    assert.deepEqual(listDueScheduledTasks(db, secondSlot + 1), []);
  } finally { db.close(); }
});

test("manual execution, status transition, pagination and workspace ownership", () => {
  const db = fixture();
  try {
    task(db);
    const paused = setScheduledTaskEnabled(db, { workspaceId: "one", taskId: "task", enabled: false, nowMs: 70_000 });
    assert.equal(paused.nextRunAt, null);
    const run = declareManualExecution(db, { workspaceId: "one", taskId: "task", nowMs: 80_000, executionId: "manual", sessionId: "session" });
    assert.equal(run.scheduledFor, null);
    assert.equal(readScheduledTask(db, "one", "task")!.nextRunAt, null);
    assert.throws(() => transitionScheduledExecution(db, { workspaceId: "one", executionId: "manual", status: "running", nowMs: 81_000 }));
    assert.equal(transitionScheduledExecution(db, { workspaceId: "two", executionId: "manual", status: "running", nowMs: 81_000 }), null);
    const running = transitionScheduledExecution(db, { workspaceId: "one", executionId: "manual", status: "running", nowMs: 81_000,
      startedAt: 81_000, runId: "run-1" })!;
    assert.equal(running.runId, "run-1");
    assert.throws(() => transitionScheduledExecution(db, { workspaceId: "one", executionId: "manual", status: "completed", nowMs: 82_000, runId: "run-2" }));
    transitionScheduledExecution(db, { workspaceId: "one", executionId: "manual", status: "completed", nowMs: 82_000 });
    assert.throws(() => transitionScheduledExecution(db, { workspaceId: "one", executionId: "manual", status: "starting", nowMs: 83_000 }));
    assert.equal(listScheduledExecutions(db, { workspaceId: "two", taskId: "task" }).items.length, 0);
    assert.equal(listScheduledExecutions(db, { workspaceId: "one", taskId: "task", result: "failed" }).items.length, 0);
    assert.equal(listScheduledExecutions(db, { workspaceId: "one", taskId: "task", result: "completed" }).items[0]?.status, "completed");
    deleteScheduledTask(db, "one", "task");
    assert.equal(readScheduledExecution(db, "one", "manual"), null);
  } finally { db.close(); }
});

test("task and execution cursor filters, stable sorting, strict malformed cursor rejection", () => {
  const db = fixture();
  try {
    task(db, "a"); task(db, "b"); task(db, "c");
    const first = listScheduledTasks(db, { workspaceId: "one", limit: 1, q: "TA" });
    assert.equal(first.items.length, 1);
    assert.equal(Value.Check(ScheduledTaskSchema, first.items[0]), true);
    assert.equal(first.items[0]?.latestExecution, null);
    assert.equal(first.items[0]?.latestScheduledExecution, null);
    const second = listScheduledTasks(db, { workspaceId: "one", limit: 1, q: "TA", cursor: first.nextCursor! });
    assert.notEqual(second.items[0]?.id, first.items[0]?.id);
    assert.throws(() => listScheduledTasks(db, { workspaceId: "one", q: "different", cursor: first.nextCursor! }),
      { code: "CURSOR_INVALID" });
    for (const value of ["$@", "e30", Buffer.from(JSON.stringify({ v: 2 })).toString("base64url"), first.nextCursor! + "="]) {
      assert.throws(() => decodeTaskCursor(value, { status: "all", q: "TA" }, "one"), CursorInvalidError);
    }
    const e1 = declareManualExecution(db, { workspaceId: "one", taskId: "a", nowMs: 80_000, executionId: "e1", sessionId: "s1" });
    transitionScheduledExecution(db, { workspaceId: "one", executionId: e1.id, status: "failed_to_start", nowMs: 81_000,
      reasonCode: "startup_interrupted_before_run" });
    const e2 = declareManualExecution(db, { workspaceId: "one", taskId: "a", nowMs: 90_000, executionId: "e2", sessionId: "s2" });
    transitionScheduledExecution(db, { workspaceId: "one", executionId: e2.id, status: "running", nowMs: 90_001,
      runId: "run-2", startedAt: 90_001 });
    transitionScheduledExecution(db, { workspaceId: "one", executionId: e2.id, status: "failed", nowMs: 91_000 });
    const history = listScheduledExecutions(db, { workspaceId: "one", taskId: "a", result: "failed", limit: 1 });
    assert.equal(history.items[0]?.id, "e2");
    assert.equal(listScheduledExecutions(db, { workspaceId: "one", taskId: "a", result: "failed", limit: 1,
      cursor: history.nextCursor! }).items[0]?.id, "e1");
    assert.throws(() => decodeExecutionCursor(history.nextCursor!, { result: "all", triggerType: "all" }, "one", "a"), CursorInvalidError);
  } finally { db.close(); }
});

test("deleting workspace fences declarations and task configuration writes", () => {
  const db = fixture();
  try {
    const existing = task(db);
    db.prepare(`insert into workspace_deletion (workspace_id, dir_name, requested_at, updated_at)
      values ('one', 'one', 10, 10)`).run();
    assert.throws(() => createScheduledTask(db, { workspaceId: "one", id: "new", configuration: cfg(), enabled: true, nowMs: 10 }),
      { code: "WORKSPACE_DELETING" });
    assert.throws(() => declareScheduledSlot(db, { workspaceId: "one", taskId: "task", scheduledFor: existing.nextRunAt!,
      nowMs: existing.nextRunAt! }), { code: "WORKSPACE_DELETING" });
    assert.deepEqual(listDueScheduledTasks(db, existing.nextRunAt!), []);
  } finally { db.close(); }
});

test("two independent SQLite connections cannot claim the same scheduled slot twice", (t) => {
  // Create and remove only this test's unique directory, never shared fixture data.
  const directory = mkdtempSync(join(process.cwd(), ".scheduled-slot-test-"));
  const first = new Database(join(directory, "state.sqlite"));
  let second: Database.Database | undefined;
  t.after(() => { second?.close(); first.close(); rmSync(directory, { recursive: true, force: true }); });
  first.pragma("foreign_keys = ON");
  initSchema(first);
  first.prepare(`insert into workspaces (id, dir_name, title, path, created_at, updated_at)
    values ('one', 'one', 'one', 'one', 1, 1)`).run();
  const created = task(first);
  second = new Database(join(directory, "state.sqlite"));
  second.pragma("foreign_keys = ON");
  const slot = created.nextRunAt!;
  const nowMs = slot + 1;
  const claims = [
    declareScheduledSlot(first, { workspaceId: "one", taskId: created.id, scheduledFor: slot, nowMs,
      executionId: "first-claim" }),
    declareScheduledSlot(second, { workspaceId: "one", taskId: created.id, scheduledFor: slot, nowMs,
      executionId: "second-claim" })
  ];
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(readScheduledExecution(second, "one", "first-claim")?.scheduledFor, slot);
  assert.equal(readScheduledExecution(first, "one", "second-claim"), null);
  const count = first.prepare("select count(*) as n from scheduled_agent_execution where task_id=? and scheduled_for=?")
    .get(created.id, slot) as {n: number};
  assert.equal(count.n, 1);
});
