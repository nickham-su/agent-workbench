import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAgentSessionTabVisibilityMutation } from "@agent-workbench/shared";
import {
  createAgentSessionTabVisibilityController,
  defaultAgentSessionTabVisibility,
  type AgentSessionTabVisibilityContext,
  type AgentSessionTabVisibilitySession
} from "./agentSessionTabVisibilityState";

const context: AgentSessionTabVisibilityContext = { workspaceId: "ws-a", workspaceGeneration: 1 };
const primary: AgentSessionTabVisibilitySession = { id: "primary-1", kind: "primary" };
const subtask: AgentSessionTabVisibilitySession = { id: "subtask-1", kind: "subtask" };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function response(sessionId: string, visible: boolean): WorkspaceAgentSessionTabVisibilityMutation {
  return { workspaceId: "ws-a", sessionId, visible };
}

function createHarness() {
  const calls: Array<{ workspaceId: string; sessionId: string; visible: boolean; deferred: Deferred<WorkspaceAgentSessionTabVisibilityMutation> }> = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];
  let current = true;
  const controller = createAgentSessionTabVisibilityController({
    request: (workspaceId, sessionId, body) => {
      const pending = deferred<WorkspaceAgentSessionTabVisibilityMutation>();
      calls.push({ workspaceId, sessionId, visible: body.visible, deferred: pending });
      return pending.promise;
    },
    isContextCurrent: () => current,
    onMutationError: (sessionId, error) => errors.push({ sessionId, error })
  });
  return { controller, calls, errors, setCurrent: (value: boolean) => { current = value; } };
}

test("默认可见性与初始化覆盖：primary 默认打开，subtask 默认关闭", () => {
  const { controller } = createHarness();
  assert.equal(defaultAgentSessionTabVisibility("primary"), true);
  assert.equal(defaultAgentSessionTabVisibility("subtask"), false);
  assert.equal(controller.getEffectiveVisibility(primary), true);
  assert.equal(controller.getEffectiveVisibility(subtask), false);

  controller.applyInitializationSnapshot([primary, subtask], {
    workspaceId: "ws-a",
    closedSessionIds: [primary.id],
    openedSubtaskSessionIds: [subtask.id]
  });
  assert.equal(controller.getEffectiveVisibility(primary), false);
  assert.equal(controller.getEffectiveVisibility(subtask), true);
  assert.equal(controller.getState(primary.id)?.confirmed, false);
  assert.equal(controller.getState(subtask.id)?.confirmed, true);
});

test("同一 Session 单飞、在途最新 intent 合并后补偿", async () => {
  const { controller, calls } = createHarness();
  controller.requestVisibility(primary, false, context);
  controller.requestVisibility(primary, true, context);
  await flush();
  assert.deepEqual(calls.map((call) => call.visible), [false]);
  assert.equal(controller.getEffectiveVisibility(primary), true);

  calls[0].deferred.resolve(response(primary.id, false));
  await flush();
  assert.deepEqual(calls.map((call) => call.visible), [false, true]);
  calls[1].deferred.resolve(response(primary.id, true));
  await flush();
  assert.equal(controller.getState(primary.id)?.desired, undefined);
  assert.equal(controller.getEffectiveVisibility(primary), true);
});

test("不同 Session 的写入可并行", async () => {
  const { controller, calls } = createHarness();
  controller.requestVisibility(primary, false, context);
  controller.requestVisibility(subtask, true, context);
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.sessionId).sort(), [primary.id, subtask.id].sort());
  calls[0].deferred.resolve(response(calls[0].sessionId, calls[0].visible));
  calls[1].deferred.resolve(response(calls[1].sessionId, calls[1].visible));
  await flush();
});

test("旧失败后仍按新 intent 补偿，同值不同 intent 也不能跳过", async () => {
  const { controller, calls, errors } = createHarness();
  controller.applyInitializationSnapshot([primary], {
    workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: []
  });
  controller.requestVisibility(primary, false, context);
  controller.requestVisibility(primary, true, context);
  await flush();
  calls[0].deferred.reject(new Error("response lost after server commit"));
  await flush();
  assert.deepEqual(calls.map((call) => call.visible), [false, true]);
  assert.equal(errors.length, 0);
  calls[1].deferred.resolve(response(primary.id, true));
  await flush();
  assert.equal(controller.getEffectiveVisibility(primary), true);
});

test("最终失败回滚到明确 confirmed/default，并且仅提示一次", async () => {
  const { controller, calls, errors } = createHarness();
  controller.applyInitializationSnapshot([primary], {
    workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: []
  });
  controller.requestVisibility(primary, false, context);
  await flush();
  calls[0].deferred.reject(new Error("network failed"));
  await flush();
  assert.equal(controller.getEffectiveVisibility(primary), true);
  assert.equal(controller.getState(primary.id)?.desired, undefined);
  assert.equal(errors.length, 1);
  await flush();
  assert.equal(errors.length, 1);
});

test("一个 Session 的 404 只回滚自身，不会阻塞或重置另一条队列", async () => {
  const { controller, calls, errors } = createHarness();
  controller.requestVisibility(primary, false, context);
  controller.requestVisibility(subtask, true, context);
  await flush();
  assert.equal(calls.length, 2);

  const primaryCall = calls.find((call) => call.sessionId === primary.id)!;
  const subtaskCall = calls.find((call) => call.sessionId === subtask.id)!;
  primaryCall.deferred.reject({ code: "AGENT_SESSION_NOT_FOUND_IN_WORKSPACE" });
  await flush();

  assert.equal(controller.getEffectiveVisibility(primary), true);
  assert.equal(controller.getState(primary.id)?.desired, undefined);
  assert.equal(controller.getState(subtask.id)?.inFlight?.visible, true);
  assert.deepEqual(errors.map((entry) => entry.sessionId), [primary.id]);
  assert.equal(calls.length, 2);

  subtaskCall.deferred.resolve(response(subtask.id, true));
  await flush();
  assert.equal(controller.getEffectiveVisibility(subtask), true);
});

test("2xx 回显的 Workspace、Session 或可见值不一致时按失败处理", async () => {
  const { controller, calls, errors } = createHarness();
  controller.requestVisibility(subtask, true, context);
  await flush();
  calls[0].deferred.resolve({ workspaceId: "ws-other", sessionId: subtask.id, visible: true });
  await flush();
  assert.equal(controller.getEffectiveVisibility(subtask), false);
  assert.equal(errors.length, 1);
});

test("旧 Workspace 或卸载后的回调没有状态、副作用或错误提示", async () => {
  const { controller, calls, errors, setCurrent } = createHarness();
  controller.requestVisibility(primary, false, context);
  await flush();
  const before = controller.getState(primary.id);
  setCurrent(false);
  calls[0].deferred.reject(new Error("stale request"));
  await flush();
  assert.equal(controller.getState(primary.id), before);
  assert.equal(controller.getState(primary.id)?.inFlight?.visible, false);
  assert.equal(errors.length, 0);
});

test("初始化快照不会覆盖 pending 状态", async () => {
  const { controller, calls } = createHarness();
  controller.requestVisibility(primary, false, context);
  await flush();
  controller.applyInitializationSnapshot([primary], {
    workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: []
  });
  assert.equal(controller.getEffectiveVisibility(primary), false);
  assert.equal(controller.getState(primary.id)?.inFlight?.visible, false);
  calls[0].deferred.resolve(response(primary.id, false));
  await flush();
});

test("草稿仅在获得真实 Session 后转交非默认可见性 intent", async () => {
  const { controller, calls } = createHarness();
  assert.equal(controller.transferDraftVisibility(primary, true, context), false);
  await flush();
  assert.equal(calls.length, 0);

  assert.equal(controller.transferDraftVisibility(primary, false, context), true);
  await flush();
  assert.deepEqual(calls.map((call) => call.visible), [false]);
  calls[0].deferred.resolve(response(primary.id, false));
  await flush();
});

test("receipt registration is atomic, same-direction intents supersede and no-op resolves immediately", async () => {
  const { controller, calls } = createHarness();
  controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: [] });
  const noOp = controller.requestVisibilityWithResult(primary, true, context);
  assert.equal((await noOp.result).status, "confirmed");
  assert.equal(calls.length, 0);
  const first = controller.requestVisibilityWithResult(subtask, true, context);
  const second = controller.requestVisibilityWithResult(subtask, true, context);
  assert.equal((await first.result).status, "superseded");
  assert.equal(calls.length, 1);
  calls[0]!.deferred.resolve(response(subtask.id, true));
  await flush();
  assert.equal(calls.length, 2, "newer intent retains its own confirmation, not an early inherited receipt");
  calls[1]!.deferred.resolve(response(subtask.id, true));
  assert.equal((await second.result).status, "confirmed");
});

test("snapshot protects PUT issued before snapshot and completed before its response (open and close)", async () => {
  for (const visible of [true, false]) {
    const { controller, calls } = createHarness();
    const receipt = controller.requestVisibilityWithResult(subtask, visible, context);
    if (!calls.length) { // For close use a known-open subtask so a PUT is necessary.
      controller.applyInitializationSnapshot([subtask], { workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: [subtask.id] });
      controller.requestVisibility(subtask, visible, context);
    }
    const snapshot = controller.captureSnapshot();
    calls[0]!.deferred.resolve(response(subtask.id, visible));
    await flush();
    controller.applyInitializationSnapshot([subtask], { workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: visible ? [] : [subtask.id] }, snapshot);
    assert.equal(controller.getEffectiveVisibility(subtask), visible);
    assert.ok(controller.getState(subtask.id)!.confirmationEpoch > 0);
    receipt.cancel();
  }
});

test("UI watchdog and cancellation release receipts without clearing real PUT queue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { controller, calls } = createHarness();
  const receipt = controller.requestVisibilityWithResult(subtask, true, context);
  t.mock.timers.tick(30000);
  assert.equal((await receipt.result).status, "uiTimeout");
  assert.equal(controller.getState(subtask.id)?.inFlight?.intentSeq, receipt.intentSeq);
  const cancelled = controller.requestVisibilityWithResult(subtask, false, context);
  cancelled.cancel();
  assert.equal((await cancelled.result).status, "cancelled");
  calls[0]!.deferred.resolve(response(subtask.id, true));
  await flush();
  calls[1]!.deferred.resolve(response(subtask.id, false));
  await flush();
  assert.equal(controller.getEffectiveVisibility(subtask), false);
  assert.equal((await receipt.result).status, "uiTimeout", "late confirmation cannot settle a finished UI twice");
});

test("invalid context receipt does not allocate a queue, supersede a newer subscription or send requests", async () => {
  const { controller, calls, setCurrent } = createHarness();
  const active = controller.requestVisibilityWithResult(subtask, true, context);
  setCurrent(false);
  const invalid = controller.requestVisibilityWithResult(subtask, false, context);
  assert.equal((await invalid.result).status, "contextInvalidated");
  assert.equal(controller.getState(subtask.id)?.nextIntentSeq, active.intentSeq);
  assert.equal(calls.length, 1);
  controller.invalidateContext();
  assert.equal((await active.result).status, "contextInvalidated");
});

test("timeout keeps uncertain commit and failed open cannot be revived by its stale snapshot", async () => {
  const { controller, calls } = createHarness();
  const receipt = controller.requestVisibilityWithResult(subtask, true, context);
  const snapshot = controller.captureSnapshot();
  calls[0]!.deferred.reject({ code: "AGENT_TAB_VISIBILITY_TIMEOUT" });
  assert.equal((await receipt.result).status, "failed");
  await flush();
  controller.applyInitializationSnapshot([subtask], { workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: [subtask.id] }, snapshot);
  assert.equal(controller.getEffectiveVisibility(subtask), false);
  assert.equal(controller.getState(subtask.id)?.uncertainCommit, true);
});

test("unknown primary defaults are not a persistence receipt: target GET cannot prove absence of a closed override", async () => {
  const { controller, calls } = createHarness();
  const receipt = controller.requestVisibilityWithResult(primary, true, context);
  assert.equal(calls.length, 1);
  calls[0]!.deferred.resolve(response(primary.id, true));
  assert.equal((await receipt.result).status, "confirmed");
});

test("partial snapshots install minimal overrides without deleting settled hidden state", () => {
  const { controller } = createHarness();
  controller.applyInitializationSnapshot([], { workspaceId: "ws-a", closedSessionIds: [primary.id], openedSubtaskSessionIds: [] });
  assert.equal(controller.getState(primary.id)?.confirmed, false);
  const snapshot = controller.captureSnapshot();
  controller.applyInitializationSnapshot([], { workspaceId: "ws-a", closedSessionIds: [], openedSubtaskSessionIds: [] }, snapshot);
  assert.equal(controller.getState(primary.id)?.confirmed, false, "unknown absent record is not a deletion or default reset");
});

test("snapshot before queued open/close completion protects settled confirmation even without pending", async () => {
  for (const visible of [true, false]) {
    const { controller, calls } = createHarness();
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", closedSessionIds: visible ? [primary.id] : [], openedSubtaskSessionIds: [] });
    controller.requestVisibility(primary, visible, context);
    const snapshot = controller.captureSnapshot();
    calls[0]!.deferred.resolve(response(primary.id, visible));
    await flush();
    assert.equal(controller.isSnapshotProtected(primary.id, snapshot), true);
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", closedSessionIds: visible ? [primary.id] : [], openedSubtaskSessionIds: [] }, snapshot);
    assert.equal(controller.getState(primary.id)?.confirmed, visible);
    assert.equal(controller.getState(primary.id)?.desired, undefined);
  }
});

test("snapshot captured during a failed PUT preserves rollback and uncertain commit", async () => {
  for (const visible of [true, false]) {
    const { controller, calls } = createHarness();
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", closedSessionIds: visible ? [primary.id] : [], openedSubtaskSessionIds: [] });
    controller.requestVisibility(primary, visible, context);
    const snapshot = controller.captureSnapshot();
    calls[0]!.deferred.reject(new Error("transport failure"));
    await flush();
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", closedSessionIds: visible ? [] : [primary.id], openedSubtaskSessionIds: [] }, snapshot);
    assert.equal(controller.getState(primary.id)?.confirmed, !visible);
    assert.equal(controller.getState(primary.id)?.uncertainCommit, true);
    assert.equal(controller.isSnapshotProtected(primary.id, snapshot), true);
  }
});


test("ending a context releases identities, write states and receipts without reviving an old same-ID PUT", async () => {
  const { controller, calls, errors } = createHarness();
  const old = controller.requestVisibilityWithResult(subtask, true, context);
  controller.invalidateContext();
  assert.equal((await old.result).status, "contextInvalidated");
  assert.deepEqual(Object.keys(controller.writeStates), []);
  assert.equal((controller as any).sessions.size, 0);
  assert.equal((controller as any).subscriptions.size, 0);
  const fresh = controller.requestVisibilityWithResult(subtask, false, context);
  calls[0]!.deferred.resolve(response(subtask.id, true));
  await flush();
  assert.equal(controller.getState(subtask.id)?.confirmed, undefined);
  assert.equal(controller.getState(subtask.id)?.inFlight?.intentSeq, fresh.intentSeq);
  calls[1]!.deferred.resolve(response(subtask.id, false));
  assert.equal((await fresh.result).status, "confirmed");
  assert.equal(errors.length, 0);
});
