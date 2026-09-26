import assert from "node:assert/strict";
import { test } from "node:test";
import { ScheduledTaskScheduler } from "./scheduled-task.scheduler.js";
import type { ScheduledTaskService } from "./scheduled-task.service.js";

test("scheduler silently catches up once, claims only one durable slot, and never starts skipped executions", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let claimed = false;
  const service = {
    reconcileActive(recover: boolean) { calls.push(recover ? "recover" : "reconcile"); },
    silentCatchUp(now: number) { calls.push(`catchup:${now}`); },
    due(now: number) { calls.push(`due:${now}`); return [{ workspaceId: "w", taskId: "t", scheduledFor: 120 }]; },
    claim(_workspaceId: string, _taskId: string, scheduledFor: number, now: number) {
      calls.push(`claim:${scheduledFor}:${now}`);
      if (claimed) return { status: "skipped" };
      claimed = true;
      return { status: "starting" };
    },
    async execute() { calls.push("execute"); await blocked; }
  } as unknown as ScheduledTaskService;
  const scheduler = new ScheduledTaskScheduler(service, () => 150);
  scheduler.start();
  assert.deepEqual(calls, ["recover", "catchup:150"]);
  const pending = scheduler.tick();
  await Promise.resolve();
  await scheduler.tick();
  assert.deepEqual(calls, ["recover", "catchup:150", "reconcile", "due:150", "claim:120:150", "execute",
    "reconcile", "due:150", "claim:120:150"]);
  release();
  await pending;
  await scheduler.stop();
  await scheduler.tick();
  assert.equal(calls.filter((call) => call === "execute").length, 1);
});

test("slow Agent startup does not block another task's durable claim or later scans", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const claimed: string[] = [], executed: string[] = [];
  const service = {
    reconcileActive() {}, silentCatchUp() {},
    due() { return ["slow", "fast"].filter((id) => !claimed.includes(id))
      .map((taskId) => ({ workspaceId: "w", taskId, scheduledFor: 123 })); },
    claim(_workspace: string, taskId: string) { claimed.push(taskId); return { taskId, status: "starting" }; },
    async execute(execution: {taskId: string}) {
      executed.push(execution.taskId);
      if (execution.taskId === "slow") await blocked;
    }
  } as unknown as ScheduledTaskService;
  const scheduler = new ScheduledTaskScheduler(service);
  scheduler.start();
  await scheduler.tick();
  await Promise.resolve();
  assert.deepEqual(claimed, ["slow", "fast"]);
  assert.deepEqual(executed, ["slow", "fast"]);
  await scheduler.tick(); // The first Agent is still pending, but scans continue.
  release();
  await scheduler.stop();
});

test("stop waits for already-dispatched Agent startup but refuses new scans", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const service = {
    reconcileActive() {}, silentCatchUp() {},
    due() { return [{ workspaceId: "w", taskId: "task", scheduledFor: 123 }]; },
    claim() { return { status: "starting" }; },
    async execute() { starts++; await blocked; }
  } as unknown as ScheduledTaskService;
  const scheduler = new ScheduledTaskScheduler(service);
  scheduler.start();
  await scheduler.tick();
  await Promise.resolve();
  assert.equal(starts, 1);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  await scheduler.tick();
  assert.equal(starts, 1);
  release();
  await stopping;
  assert.equal(stopped, true);
});

test("scheduler does not dispatch skipped claims or start before recovery/catchup", async () => {
  const calls: string[] = [];
  const service = {
    reconcileActive() { calls.push("reconcile"); }, silentCatchUp() { calls.push("catchup"); },
    due() { return [{ workspaceId: "w", taskId: "t", scheduledFor: 42 }]; },
    claim() { return { status: "skipped" }; }, async execute() { calls.push("execute"); }
  } as unknown as ScheduledTaskService;
  const scheduler = new ScheduledTaskScheduler(service);
  await scheduler.tick();
  assert.deepEqual(calls, []);
  scheduler.start();
  await scheduler.tick();
  scheduler.stop();
  assert.deepEqual(calls, ["reconcile", "catchup", "reconcile"]);
});
