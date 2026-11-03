import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAgentSessionTabVisibilityMutation } from "@agent-workbench/shared";
import {
  createAgentSessionTabVisibilityController,
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

test("开闭初始未知，完整 opened 集合是唯一事实，不按 kind 或旧数组推断", () => {
  const { controller } = createHarness();
  assert.equal(controller.getEffectiveVisibility(primary), undefined);
  assert.equal(controller.getEffectiveVisibility(subtask), undefined);
  controller.rememberSession(primary);
  controller.rememberSession(subtask);
  assert.equal(controller.getEffectiveVisibility(primary), undefined);

  controller.applyInitializationSnapshot([subtask], {
    workspaceId: "ws-a",
    openedSessionIds: [subtask.id],
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
    workspaceId: "ws-a", openedSessionIds: [primary.id], closedSessionIds: [], openedSubtaskSessionIds: []
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

test("最终失败回滚到已知 confirmed，保留 uncertain commit 并仅提示一次", async () => {
  const { controller, calls, errors } = createHarness();
  controller.applyInitializationSnapshot([primary], {
    workspaceId: "ws-a", openedSessionIds: [primary.id], closedSessionIds: [], openedSubtaskSessionIds: []
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

  assert.equal(controller.getEffectiveVisibility(primary), undefined);
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
  assert.equal(controller.getEffectiveVisibility(subtask), undefined);
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
    workspaceId: "ws-a", openedSessionIds: [primary.id], closedSessionIds: [], openedSubtaskSessionIds: []
  });
  assert.equal(controller.getEffectiveVisibility(primary), false);
  assert.equal(controller.getState(primary.id)?.inFlight?.visible, false);
  calls[0].deferred.resolve(response(primary.id, false));
  await flush();
});

test("草稿真实化总是显式提交当前意图，创建响应不构成开闭确认", async () => {
  for (const visible of [true, false]) {
    const { controller, calls } = createHarness();
    assert.equal(controller.transferDraftVisibility(primary, visible, context), true);
    await flush();
    assert.deepEqual(calls.map((call) => call.visible), [visible]);
    assert.equal(controller.getState(primary.id)?.confirmed, undefined);
    assert.equal(controller.getEffectiveVisibility(primary), visible);
    calls[0].deferred.resolve(response(primary.id, visible));
    await flush();
    assert.equal(controller.getState(primary.id)?.confirmed, visible);
  }
});

test("receipt registration is atomic; each explicit intent needs its own PUT even after a matching snapshot", async () => {
  const { controller, calls } = createHarness();
  controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", openedSessionIds: [primary.id], closedSessionIds: [], openedSubtaskSessionIds: [] });
  const opening = controller.requestVisibilityWithResult(primary, true, context);
  assert.equal(calls.length, 1);
  calls.shift()!.deferred.resolve(response(primary.id, true));
  assert.equal((await opening.result).status, "confirmed");
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
      controller.applyInitializationSnapshot([subtask], { workspaceId: "ws-a", openedSessionIds: [subtask.id], closedSessionIds: [], openedSubtaskSessionIds: [subtask.id] });
      controller.requestVisibility(subtask, visible, context);
    }
    const snapshot = controller.captureSnapshot();
    calls[0]!.deferred.resolve(response(subtask.id, visible));
    await flush();
    controller.applyInitializationSnapshot([subtask], { workspaceId: "ws-a", openedSessionIds: visible ? [] : [subtask.id], closedSessionIds: [], openedSubtaskSessionIds: visible ? [] : [subtask.id] }, snapshot);
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
  controller.applyInitializationSnapshot([subtask], { workspaceId: "ws-a", openedSessionIds: [subtask.id], closedSessionIds: [], openedSubtaskSessionIds: [subtask.id] }, snapshot);
  assert.equal(controller.getEffectiveVisibility(subtask), undefined);
  assert.equal(controller.getState(subtask.id)?.uncertainCommit, true);
});

test("unknown primary defaults are not a persistence receipt: target GET cannot prove absence of a closed override", async () => {
  const { controller, calls } = createHarness();
  const receipt = controller.requestVisibilityWithResult(primary, true, context);
  assert.equal(calls.length, 1);
  calls[0]!.deferred.resolve(response(primary.id, true));
  assert.equal((await receipt.result).status, "confirmed");
});

test("兼容数组不创建假会话，完整快照可协调已知缓存的关闭而不删除元信息", () => {
  const { controller } = createHarness();
  controller.applyInitializationSnapshot([], { workspaceId: "ws-a", openedSessionIds: [], closedSessionIds: [primary.id], openedSubtaskSessionIds: [] });
  assert.equal(controller.getState(primary.id), undefined);
  controller.rememberSession(primary);
  controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", openedSessionIds: [primary.id], closedSessionIds: [], openedSubtaskSessionIds: [] });
  assert.equal(controller.getState(primary.id)?.confirmed, true);
  const snapshot = controller.captureSnapshot();
  controller.applyInitializationSnapshot([], { workspaceId: "ws-a", openedSessionIds: [], closedSessionIds: [], openedSubtaskSessionIds: [] }, snapshot);
  assert.equal(controller.getState(primary.id)?.confirmed, false);
});

test("snapshot before queued open/close completion protects settled confirmation even without pending", async () => {
  for (const visible of [true, false]) {
    const { controller, calls } = createHarness();
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", openedSessionIds: visible ? [] : [primary.id], closedSessionIds: visible ? [primary.id] : [], openedSubtaskSessionIds: [] });
    controller.requestVisibility(primary, visible, context);
    const snapshot = controller.captureSnapshot();
    calls[0]!.deferred.resolve(response(primary.id, visible));
    await flush();
    assert.equal(controller.isSnapshotProtected(primary.id, snapshot), true);
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", openedSessionIds: visible ? [] : [primary.id], closedSessionIds: visible ? [primary.id] : [], openedSubtaskSessionIds: [] }, snapshot);
    assert.equal(controller.getState(primary.id)?.confirmed, visible);
    assert.equal(controller.getState(primary.id)?.desired, undefined);
  }
});

test("snapshot captured during a failed PUT preserves rollback and uncertain commit", async () => {
  for (const visible of [true, false]) {
    const { controller, calls } = createHarness();
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", openedSessionIds: visible ? [] : [primary.id], closedSessionIds: visible ? [primary.id] : [], openedSubtaskSessionIds: [] });
    controller.requestVisibility(primary, visible, context);
    const snapshot = controller.captureSnapshot();
    calls[0]!.deferred.reject(new Error("transport failure"));
    await flush();
    controller.applyInitializationSnapshot([primary], { workspaceId: "ws-a", openedSessionIds: visible ? [primary.id] : [], closedSessionIds: visible ? [] : [primary.id], openedSubtaskSessionIds: [] }, snapshot);
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

test("快照采集后新学到的缓存保持未知；后续完整读取才可确认关闭", () => {
  const { controller } = createHarness();
  const beforeCache = controller.captureSnapshot();
  controller.rememberSession(primary);
  assert.equal(controller.getEffectiveVisibility(primary), undefined);
  assert.equal(controller.isSnapshotProtected(primary.id, beforeCache), true);
  controller.applyInitializationSnapshot([], { workspaceId: "ws-a", openedSessionIds: [], closedSessionIds: [], openedSubtaskSessionIds: [] }, beforeCache);
  assert.equal(controller.getState(primary.id)?.confirmed, undefined);
  const fresh = controller.captureSnapshot();
  controller.applyInitializationSnapshot([], { workspaceId: "ws-a", openedSessionIds: [], closedSessionIds: [], openedSubtaskSessionIds: [] }, fresh);
  assert.equal(controller.getState(primary.id)?.confirmed, false);
});

test("完整快照新出现的成员安装 true；旧兼容数组即使矛盾也不是权威", () => {
  const { controller } = createHarness();
  const captured = controller.captureSnapshot();
  controller.applyInitializationSnapshot([primary, subtask], {
    workspaceId: "ws-a", openedSessionIds: [primary.id, subtask.id], closedSessionIds: [primary.id], openedSubtaskSessionIds: []
  }, captured);
  assert.equal(controller.getState(primary.id)?.confirmed, true);
  assert.equal(controller.getState(subtask.id)?.confirmed, true);
});

for (const saved of [true, false]) {
  test(`草稿关闭超时不伪造确认，后续完整读取按实际提交${saved}协调且无补偿`, async () => {
    const { controller, calls, errors } = createHarness();
    controller.transferDraftVisibility(primary, false, context);
    assert.equal(controller.getState(primary.id)?.confirmed, undefined);
    const stale = controller.captureSnapshot();
    calls[0]!.deferred.reject({ code: "AGENT_TAB_VISIBILITY_TIMEOUT" });
    await flush();
    assert.equal(controller.getState(primary.id)?.confirmed, undefined);
    assert.equal(controller.getState(primary.id)?.uncertainCommit, true);
    assert.equal(errors.length, 1);
    controller.applyInitializationSnapshot([], { workspaceId: "ws-a", openedSessionIds: [], closedSessionIds: [], openedSubtaskSessionIds: [] }, stale);
    assert.equal(controller.getState(primary.id)?.confirmed, undefined);
    const fresh = controller.captureSnapshot();
    controller.applyInitializationSnapshot(saved ? [primary] : [], {
      workspaceId: "ws-a", openedSessionIds: saved ? [primary.id] : [], closedSessionIds: [], openedSubtaskSessionIds: []
    }, fresh);
    assert.equal(controller.getState(primary.id)?.confirmed, saved);
    assert.equal(controller.getState(primary.id)?.uncertainCommit, false);
    assert.equal(calls.length, 1);
  });
}

test("草稿创建响应上下文已失效时不迁移、不安装确认、不提交任何显隐意图", () => {
  const { controller, calls, setCurrent } = createHarness();
  setCurrent(false);
  for (const visible of [true, false]) {
    assert.equal(controller.transferDraftVisibility(primary, visible, context), false);
    assert.equal(controller.getState(primary.id), undefined);
  }
  assert.equal(calls.length, 0);
});
