import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { initSchema } from "../../infra/db/schema.js";
import { createScheduledTask, declareManualExecution, declareScheduledSlot, readScheduledExecution,
  listScheduledExecutions, ScheduledStoreError } from "./scheduled-task.store.js";

function fixture(t: TestContext, mode: "new_session" | "fork_message" = "new_session") {
  const db = new Database(":memory:");
  t.after(() => db.close());
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','ws','ws',1,1)").run();
  const task = createScheduledTask(db, { workspaceId: "ws", id: "task", nowMs: 60_000, enabled: true,
    configuration: { name: "task", prompt: "work", agentId: "agent", triggerMode: mode,
      schedule: { kind: "hourly", minutesUtc: [0, 30] }, source: mode === "new_session" ? null : {
        sessionId: "known-hidden", messageId: "fixed-anchor", title: "Source", messageSummary: "History", messageCreatedAt: 1
      } } });
  return { db, task };
}

for (const mode of ["new_session", "fork_message"] as const) {
  test(`new ${mode} manual, scheduled and skipped declarations share the fixed internal hidden marker`, (t) => {
    const { db, task } = fixture(t, mode);
    const scheduled = declareScheduledSlot(db, { workspaceId: "ws", taskId: task.id, scheduledFor: task.nextRunAt!, nowMs: task.nextRunAt! })!;
    assert.equal(scheduled.snapshot.sessionVisibility, "unlisted");
    const next = db.prepare("select next_run_at as next from scheduled_agent_task where id=?").get(task.id) as { next: number };
    const skipped = declareScheduledSlot(db, { workspaceId: "ws", taskId: task.id, scheduledFor: next.next, nowMs: next.next })!;
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.snapshot.sessionVisibility, "unlisted");
    assert.equal(skipped.sessionId, null);
    createScheduledTask(db, { workspaceId: "ws", id: "manual", enabled: false, nowMs: 1,
      configuration: { name: "manual", prompt: "work", agentId: "agent", triggerMode: "new_session",
        schedule: { kind: "hourly", minutesUtc: [0] }, source: null } });
    const manual = declareManualExecution(db, { workspaceId: "ws", taskId: "manual", nowMs: 2 });
    assert.equal(manual.snapshot.sessionVisibility, "unlisted");
    assert.equal((db.prepare("select count(*) as n from agent_session").get() as {n: number}).n, 0);
    assert.equal(db.prepare("pragma table_info(scheduled_agent_task)").all().some((row) => (row as { name: string }).name.toLowerCase().includes("visibility")), false);
  });
}

test("old snapshots without the marker stay distinguishable and are not rewritten on read", (t) => {
  const { db } = fixture(t);
  const execution = declareManualExecution(db, { workspaceId: "ws", taskId: "task", nowMs: 2 });
  const old = { ...execution.snapshot };
  delete old.sessionVisibility;
  const json = JSON.stringify(old);
  db.prepare("update scheduled_agent_execution set task_snapshot_json=? where id=?").run(json, execution.id);
  assert.equal(Object.hasOwn(readScheduledExecution(db, "ws", execution.id)!.snapshot, "sessionVisibility"), false);
  assert.equal(listScheduledExecutions(db, { workspaceId: "ws", taskId: "task" }).items.length, 1);
  assert.deepEqual(db.prepare("select task_snapshot_json from scheduled_agent_execution where id=?").get(execution.id), { task_snapshot_json: json });
});

test("invalid JSON, visibility markers and necessary snapshot structure fail with a fixed non-sensitive storage error", (t) => {
  const { db } = fixture(t);
  const execution = declareManualExecution(db, { workspaceId: "ws", taskId: "task", nowMs: 2 });
  const invalid = ["{fixture-private-content", "null", "[]", "{}",
    ...[null, "listed", "invalid", 0, false, {}, []].map((sessionVisibility) => JSON.stringify({ ...execution.snapshot, sessionVisibility })),
    ...[{ prompt: "" }, { agentId: null }, { triggerMode: "unexpected" }, { sourceSessionId: "inconsistent" },
      { triggerMode: "fork_message", sourceSessionId: null }].map((value) => JSON.stringify({ ...execution.snapshot, ...value }))];
  for (const json of invalid) {
    db.prepare("update scheduled_agent_execution set task_snapshot_json=? where id=?").run(json, execution.id);
    for (const read of [() => readScheduledExecution(db, "ws", execution.id),
      () => listScheduledExecutions(db, { workspaceId: "ws", taskId: "task" })]) {
      assert.throws(read, (error: unknown) => error instanceof ScheduledStoreError &&
        error.code === "SCHEDULED_EXECUTION_SNAPSHOT_INVALID" && error.message === "SCHEDULED_EXECUTION_SNAPSHOT_INVALID");
    }
    assert.deepEqual(db.prepare("select status,run_id,finished_at,task_snapshot_json from scheduled_agent_execution where id=?").get(execution.id),
      { status: "starting", run_id: null, finished_at: null, task_snapshot_json: json });
    for (const table of ["agent_session", "workspace_session_tab_state", "agent_message", "agent_run", "agent_client_request"]) {
      assert.equal((db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n, 0);
    }
  }
});
