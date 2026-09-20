import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunKind, AgentRunStatusResponse } from "@agent-workbench/shared";
import {
  AGENT_PENDING_RUN_MAX_CONCURRENT,
  AGENT_PENDING_RUN_STALE_MS,
  AGENT_PENDING_RUN_STORAGE_PREFIX,
  clearPendingAgentRunsForWorkspace,
  createAgentPendingRunRegistry,
  createPendingRunPollCoordinator,
  pendingAgentRunStorageKey,
  pollPendingAgentRuns,
  type SessionStorageLike,
} from "./agentPendingRunRegistry.js";

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const result: SessionStorageLike & { entries: () => Record<string, string> } = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    entries: () => Object.fromEntries(values),
  };
  return result;
}

function run(runId: string, input: {
  runKind?: AgentRunKind;
  status?: "running" | "completed" | "failed" | "cancelled";
  workspaceId?: string;
  sessionId?: string;
} = {}): AgentRunStatusResponse {
  const common = {
    workspaceId: input.workspaceId ?? "ws",
    sessionId: input.sessionId ?? "session",
    runId,
    runKind: input.runKind ?? "user",
    updatedAt: 1,
    detail: null,
  };
  if (input.status && input.status !== "running") {
    return { ...common, status: input.status, code: input.status === "completed" ? "run_completed" : "run_failed" } as AgentRunStatusResponse;
  }
  return { ...common, status: "running", code: null };
}

function register(registry: ReturnType<typeof createAgentPendingRunRegistry>, runId: string, runKind: "user" | "manual_compaction" = "user") {
  registry.register({ workspaceId: "ws", sessionId: "session", runKind, runId });
}

test("独立 key 防止多个 registry 覆盖，并让较早创建的 Pane 发现后续登记", () => {
  const sharedStorage = storage();
  const first = createAgentPendingRunRegistry(sharedStorage, () => 1);
  const second = createAgentPendingRunRegistry(sharedStorage, () => 2);
  register(first, "first", "manual_compaction");
  register(second, "second");

  assert.deepEqual(first.list("ws", "session").map((item) => [item.runId, item.runKind]), [
    ["first", "manual_compaction"], ["second", "user"],
  ]);
  assert.equal(Object.keys(sharedStorage.entries()).length, 2);
  assert.ok(Object.keys(sharedStorage.entries()).every((key) => key.startsWith(AGENT_PENDING_RUN_STORAGE_PREFIX)));
});

test("key 编码可往返，扫描会物理清理损坏、旧版、不一致和过期记录", () => {
  const now = AGENT_PENDING_RUN_STALE_MS + 10;
  const valid = { workspaceId: "ws/a %", sessionId: "session /%", runKind: "manual_compaction" as const, runId: "run /%", createdAt: now };
  const validKey = pendingAgentRunStorageKey(valid);
  const invalidKey = `${AGENT_PENDING_RUN_STORAGE_PREFIX}ws/session/user/%E0%A4%A`;
  const stale = { workspaceId: "ws", sessionId: "session", runKind: "user" as const, runId: "old", createdAt: 0 };
  const staleKey = pendingAgentRunStorageKey(stale);
  const mismatchKey = pendingAgentRunStorageKey({ ...stale, runId: "mismatch" });
  const other = { workspaceId: "other", sessionId: "session", runKind: "user" as const, runId: "kept", createdAt: now };
  const otherKey = pendingAgentRunStorageKey(other);
  const sharedStorage = storage({
    [validKey]: JSON.stringify({ schemaVersion: 1, ...valid }),
    [invalidKey]: "{}",
    [staleKey]: JSON.stringify({ schemaVersion: 1, ...stale }),
    [mismatchKey]: JSON.stringify({ schemaVersion: 1, ...stale }),
    [otherKey]: JSON.stringify({ schemaVersion: 1, ...other }),
  });
  const registry = createAgentPendingRunRegistry(sharedStorage, () => now);

  assert.deepEqual(registry.list(valid.workspaceId, valid.sessionId).map((item) => item.runId), [valid.runId]);
  assert.equal(sharedStorage.getItem(invalidKey), null);
  assert.equal(sharedStorage.getItem(staleKey), null);
  assert.equal(sharedStorage.getItem(mismatchKey), null);
  assert.notEqual(sharedStorage.getItem(otherKey), null);
});

test("Storage API 异常只降级恢复能力，不阻塞登记和读取", () => {
  const blocked: SessionStorageLike = {
    get length() { throw new Error("blocked"); return 0; },
    key() { throw new Error("blocked"); },
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const registry = createAgentPendingRunRegistry(blocked, () => 1);
  assert.doesNotThrow(() => registry.register({ workspaceId: "ws", sessionId: "session", runKind: "user", runId: "run" }));
  assert.deepEqual(registry.list("ws", "session"), []);
});

test("clearScope 和 clearWorkspace 只物理删除匹配的 pending keys", () => {
  const sharedStorage = storage();
  const registry = createAgentPendingRunRegistry(sharedStorage, () => 1);
  registry.register({ workspaceId: "ws", sessionId: "first", runKind: "user", runId: "one" });
  registry.register({ workspaceId: "ws", sessionId: "second", runKind: "manual_compaction", runId: "two" });
  registry.register({ workspaceId: "other", sessionId: "first", runKind: "user", runId: "three" });
  registry.clearScope("ws", "first");
  assert.deepEqual(registry.list("ws", "first"), []);
  assert.deepEqual(registry.list("ws", "second").map((item) => item.runId), ["two"]);
  clearPendingAgentRunsForWorkspace(sharedStorage, "ws");
  assert.deepEqual(registry.list("ws", "second"), []);
  assert.deepEqual(registry.list("other", "first").map((item) => item.runId), ["three"]);
});

test("非 canonical key 与 Web 不支持的 subtask 记录会被物理清理", () => {
  const nonCanonical = `${AGENT_PENDING_RUN_STORAGE_PREFIX}ws/session/user/run%2fid`;
  const subtask = pendingAgentRunStorageKey({ workspaceId: "ws", sessionId: "session", runKind: "user", runId: "subtask" });
  const sharedStorage = storage({
    [nonCanonical]: JSON.stringify({ schemaVersion: 1, workspaceId: "ws", sessionId: "session", runKind: "user", runId: "run/id", createdAt: 1 }),
    [subtask]: JSON.stringify({ schemaVersion: 1, workspaceId: "ws", sessionId: "session", runKind: "subtask", runId: "subtask", createdAt: 1 }),
  });
  assert.deepEqual(createAgentPendingRunRegistry(sharedStorage, () => 1).list("ws", "session"), []);
  assert.equal(sharedStorage.getItem(nonCanonical), null);
  assert.equal(sharedStorage.getItem(subtask), null);
});

test("一轮轮询以 FIFO 分批处理全部记录，最大在途数为三且第四条不会饥饿", async () => {
  let now = 1;
  const registry = createAgentPendingRunRegistry(storage(), () => now);
  for (const runId of ["a", "b", "c", "d"]) register(registry, runId);
  const fetched: string[] = [];
  let concurrent = 0;
  let maximum = 0;
  await pollPendingAgentRuns({
    registry, workspaceId: "ws", sessionId: "session", onTerminal: () => {}, onStale: () => {}, now: () => now,
    fetchRun: async (runId) => {
      fetched.push(runId);
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent -= 1;
      return run(runId);
    },
  });
  assert.deepEqual(fetched, ["a", "b", "c", "d"]);
  assert.ok(maximum <= AGENT_PENDING_RUN_MAX_CONCURRENT);
  now += 1;
});

test("transient 失败保留到 TTL、遵从退避，恢复后终态只消费一次", async () => {
  let now = 1;
  const registry = createAgentPendingRunRegistry(storage(), () => now);
  register(registry, "retry");
  let attempts = 0;
  for (let index = 0; index < 6; index += 1) {
    await pollPendingAgentRuns({
      registry, workspaceId: "ws", sessionId: "session", onTerminal: () => {}, onStale: () => {}, now: () => now,
      fetchRun: async () => { attempts += 1; throw new Error("network"); },
    });
    const item = registry.list("ws", "session")[0]!;
    assert.equal(item.retryCount, index + 1);
    assert.ok((item.nextAttemptAt ?? 0) > now);
    await pollPendingAgentRuns({
      registry, workspaceId: "ws", sessionId: "session", onTerminal: () => {}, onStale: () => {}, now: () => now,
      fetchRun: async () => { throw new Error("must not fetch before backoff"); },
    });
    now = item.nextAttemptAt!;
  }
  assert.equal(attempts, 6);
  const terminals: string[] = [];
  await pollPendingAgentRuns({
    registry, workspaceId: "ws", sessionId: "session", now: () => now,
    fetchRun: async () => run("retry", { status: "completed" }),
    onTerminal: (result) => { terminals.push(result.runId); }, onStale: () => {},
  });
  assert.deepEqual(terminals, ["retry"]);
  assert.deepEqual(registry.list("ws", "session"), []);
});

test("404、其他永久 4xx 和 identity mismatch 都清理并在同标签页只提示一次", async () => {
  const registry = createAgentPendingRunRegistry(storage(), () => 1);
  register(registry, "not-found");
  register(registry, "forbidden");
  register(registry, "mismatch", "manual_compaction");
  const coordinator = createPendingRunPollCoordinator();
  let stale = 0;
  await pollPendingAgentRuns({
    registry, workspaceId: "ws", sessionId: "session", coordinator, onTerminal: () => {}, onStale: () => { stale += 1; },
    fetchRun: async (runId) => {
      if (runId === "not-found") throw { status: 404 };
      if (runId === "forbidden") throw { status: 403 };
      return run(runId, { runKind: "user" });
    },
  });
  assert.equal(stale, 3);
  assert.deepEqual(registry.list("ws", "session"), []);
});

test("同标签页多个 Pane 并发扫描同一记录时不会重复请求或消费", async () => {
  const registry = createAgentPendingRunRegistry(storage(), () => 1);
  register(registry, "once");
  const coordinator = createPendingRunPollCoordinator();
  let calls = 0;
  let terminals = 0;
  const params = {
    registry, workspaceId: "ws", sessionId: "session", coordinator,
    fetchRun: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 2)); return run("once", { status: "completed" }); },
    onTerminal: () => { terminals += 1; }, onStale: () => {},
  };
  await Promise.all([pollPendingAgentRuns(params), pollPendingAgentRuns(params)]);
  assert.equal(calls, 1);
  assert.equal(terminals, 1);
});
