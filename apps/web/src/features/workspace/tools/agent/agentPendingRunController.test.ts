import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunStatusResponse } from "@agent-workbench/shared";
import { createAgentPendingRunController } from "./agentPendingRunController.js";
import { createAgentPendingRunRegistry, createPendingRunPollCoordinator, type SessionStorageLike } from "./agentPendingRunRegistry.js";
import { registerPendingAgentRun } from "./agentPendingRunRegistration.js";

function storage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function terminal(runId: string, runKind: "user" | "manual_compaction" = "user", sessionId = "session"): AgentRunStatusResponse {
  return {
    workspaceId: "ws", sessionId, runId, runKind,
    status: "completed", code: "run_completed", detail: null, updatedAt: 1,
  };
}

test("草稿 Pane 登记的 Run 可由真实 Session controller 接手", async () => {
  const sharedStorage = storage();
  const draftRegistry = createAgentPendingRunRegistry(sharedStorage, () => 1);
  draftRegistry.register({ workspaceId: "ws", sessionId: "session", runKind: "user", runId: "handoff" });
  const realRegistry = createAgentPendingRunRegistry(sharedStorage, () => 2);
  const terminals: string[] = [];
  const controller = createAgentPendingRunController({
    registry: realRegistry,
    fetchRun: async ({ runId }) => terminal(runId),
    onTerminal: (run) => terminals.push(run.runId),
    onStale: () => {},
  });
  controller.start({ workspaceId: "ws", sessionId: "session" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(terminals, ["handoff"]);
  controller.stop();
});

test("真实 controller 空扫描后，独立 registry 晚登记的三个 Web 入口都会自动唤醒", async () => {
  const sharedStorage = storage();
  const terminals: string[] = [];
  const real = createAgentPendingRunController({
    registry: createAgentPendingRunRegistry(sharedStorage, () => 1),
    fetchRun: async ({ runId }) => terminal(runId, runId === "compact" ? "manual_compaction" : "user"),
    onTerminal: (run) => terminals.push(run.runId), onStale: () => {},
  });
  const lateRegistry = createAgentPendingRunRegistry(sharedStorage, () => 2);
  real.start({ workspaceId: "ws", sessionId: "session" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const input of [
    { runId: "text", runKind: "user" as const },
    { runId: "multipart", runKind: "user" as const },
    { runId: "compact", runKind: "manual_compaction" as const },
  ]) {
    registerPendingAgentRun(lateRegistry, { workspaceId: "ws", sessionId: "session", ...input });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(terminals, ["text", "multipart", "compact"]);
  real.stop();
});

test("stop 或 scope 切换后，在途响应不产生通知也不删除新 scope 以外的记录", async () => {
  const registry = createAgentPendingRunRegistry(storage(), () => 1);
  registry.register({ workspaceId: "ws", sessionId: "session", runKind: "user", runId: "late" });
  let resolveFetch!: (value: AgentRunStatusResponse) => void;
  const pending = new Promise<AgentRunStatusResponse>((resolve) => { resolveFetch = resolve; });
  let terminals = 0;
  const controller = createAgentPendingRunController({
    registry,
    fetchRun: async () => pending,
    onTerminal: () => { terminals += 1; },
    onStale: () => {},
  });
  controller.start({ workspaceId: "ws", sessionId: "session" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.stop();
  resolveFetch(terminal("late"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(terminals, 0);
  assert.deepEqual(registry.list("ws", "session").map((item) => item.runId), ["late"]);
});

test("两个 controller 共享协调器时同一标签页不重复 fetch 或提示", async () => {
  const sharedStorage = storage();
  const firstRegistry = createAgentPendingRunRegistry(sharedStorage, () => 1);
  firstRegistry.register({ workspaceId: "ws", sessionId: "session", runKind: "user", runId: "once" });
  const coordinator = createPendingRunPollCoordinator();
  let calls = 0;
  let terminals = 0;
  const createController = () => createAgentPendingRunController({
    registry: createAgentPendingRunRegistry(sharedStorage, () => 1), coordinator,
    fetchRun: async ({ runId }) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 2)); return terminal(runId); },
    onTerminal: () => { terminals += 1; }, onStale: () => {},
  });
  const first = createController();
  const second = createController();
  first.start({ workspaceId: "ws", sessionId: "session" });
  second.start({ workspaceId: "ws", sessionId: "session" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  first.stop();
  second.stop();
  assert.equal(calls, 1);
  assert.equal(terminals, 1);
});

test("transient 后返回 running 会清除退避计数，并按正常间隔调度", async () => {
  let now = 0;
  const timers: Array<{ delay: number; callback: () => void }> = [];
  let calls = 0;
  const registry = createAgentPendingRunRegistry(storage(), () => now);
  registry.register({ workspaceId: "ws", sessionId: "session", runKind: "user", runId: "running" });
  const controller = createAgentPendingRunController({
    registry,
    fetchRun: async ({ runId }) => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return { workspaceId: "ws", sessionId: "session", runId, runKind: "user", status: "running", code: null, detail: null, updatedAt: 1 };
    },
    onTerminal: () => {}, onStale: () => {}, now: () => now,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length as never; },
    clearTimer: () => {},
  });
  controller.start({ workspaceId: "ws", sessionId: "session" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timers[0]?.delay, 1_000);
  now = 1_000;
  timers.shift()!.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const item = registry.list("ws", "session")[0]!;
  assert.equal(item.retryCount, undefined);
  assert.equal(item.nextAttemptAt, 2_000);
  assert.equal(timers[0]?.delay, 1_000);
  controller.stop();
});

test("旧 scope 在途时切换新 scope，会在旧请求结束后立即轮询新 scope", async () => {
  const registry = createAgentPendingRunRegistry(storage(), () => 1);
  registry.register({ workspaceId: "ws", sessionId: "A", runKind: "user", runId: "old" });
  registry.register({ workspaceId: "ws", sessionId: "B", runKind: "user", runId: "new" });
  let resolveOld!: (value: AgentRunStatusResponse) => void;
  const old = new Promise<AgentRunStatusResponse>((resolve) => { resolveOld = resolve; });
  const calls: string[] = [];
  const terminals: string[] = [];
  const controller = createAgentPendingRunController({
    registry,
    fetchRun: async ({ sessionId, runId }) => {
      calls.push(`${sessionId}:${runId}`);
      return sessionId === "A" ? old : terminal(runId, "user", sessionId);
    },
    onTerminal: (run) => terminals.push(run.runId), onStale: () => {},
  });
  controller.start({ workspaceId: "ws", sessionId: "A" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.start({ workspaceId: "ws", sessionId: "B" });
  resolveOld(terminal("old", "user", "A"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["A:old", "B:new"]);
  assert.deepEqual(terminals, ["new"]);
  assert.deepEqual(registry.list("ws", "A").map((item) => item.runId), ["old"]);
  controller.stop();
});
