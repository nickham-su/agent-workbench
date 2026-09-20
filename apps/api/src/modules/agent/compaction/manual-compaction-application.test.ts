import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualCompactionApplication } from "./manual-compaction-application.js";
import type { ManualCompactionApplicationDependencies } from "./manual-compaction-ports.js";
import { SessionRuntimeHandoffCoordinator } from "../lifecycle/session-runtime-handoff-coordinator.js";
import { RunLifecycleApplication } from "../lifecycle/run-lifecycle-application.js";
import type { RunLifecycleApplicationDependencies } from "../lifecycle/run-lifecycle-ports.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { HttpError } from "../../../app/errors.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

const session = {
  id: "session", workspaceId: "workspace", title: "session", kind: "primary" as const,
  forkedFromSessionId: null, forkedFromMessageId: null, headMessageId: "message-7",
  contextRootMessageId: "message-7", revision: 1, createdAt: 1, updatedAt: 1,
};

const controlRunState = {
  workspaceId: "workspace", sessionId: "session", status: "idle" as const, activeRunId: null,
  runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null,
  nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 0,
};


function create(overrides: Partial<ManualCompactionApplicationDependencies> = {}) {
  const resolveProfileCalls: Array<{ workspaceId: string; sessionId: string; requestedAgentId?: string }> = [];
  const calls: string[] = [];
  const deps: ManualCompactionApplicationDependencies = {
    sessions: { get: () => session },
    isWorkerEnabled: () => true,
    findDedup: () => null,
    getRunState: () => ({ status: "idle" }),
    getControlRunState: () => controlRunState,
    resolveProfile: (params) => {
      resolveProfileCalls.push(params);
      return { agentId: "agent", providerId: "provider", modelId: "model" };
    },
    getWorkspaceRunContext: () => ({ workspacePath: "/workspace", workspaceRepoDirNames: ["repo"] }),
    activate: () => calls.push("activate"),
    enqueueActivatedRunOrReconcile: async ({ runtime, run }) => {
      calls.push("handoff");
      await runtime.enqueueRun(run);
    },
    clock: { nowMs: () => 100 }, ids: { newRunId: () => "run" }, ...overrides
  };
  return { app: new ManualCompactionApplication(deps), calls, resolveProfileCalls };
}
const command = (runtime: any) => ({ sessionId: "session", body: { workspaceId: "workspace", clientRequestId: "request" }, runtime });

test("ManualCompactionApplication keeps activation and run-kind enqueue order", async () => {
  const { app, calls } = create();
  const result = await app.schedule(command({ enqueueRun: async (input: any) => { calls.push(`enqueue:${input.runKind}`); } }));
  assert.equal(result.scheduled, true);
  assert.deepEqual(calls, ["activate", "handoff", "enqueue:manual_compaction"]);
});


test("ManualCompactionApplication 在激活前验证 workspace context", async () => {
  const { app, calls } = create({ getWorkspaceRunContext: () => null });
  await assert.rejects(app.schedule(command({ enqueueRun: () => calls.push("enqueue") })), /workspace not found/);
  assert.deepEqual(calls, []);
});

test("ManualCompactionApplication resolves a new Run profile with the target session", async () => {
  const { app, resolveProfileCalls } = create();
  await app.schedule(command({ enqueueRun: () => undefined }));
  assert.deepEqual(resolveProfileCalls, [{ workspaceId: "workspace", sessionId: "session", requestedAgentId: undefined }]);
});

test("ManualCompactionApplication preserves dedup without activation or enqueue", async () => {
  const { app, calls } = create({ findDedup: () => ({ runId: "existing" }) });
  const result = await app.schedule(command({ enqueueRun: () => calls.push("enqueue") }));
  assert.equal(result.scheduled, false); assert.equal(result.runId, "existing"); assert.deepEqual(calls, []);
});

test("ManualCompactionApplication 将 enqueue 结果语义委托给 Lifecycle", async () => {
  const { app, calls } = create();
  await assert.rejects(app.schedule(command({ enqueueRun: () => { calls.push("enqueue"); throw new Error("enqueue failed"); } })), /enqueue failed/);
  assert.deepEqual(calls, ["activate", "handoff", "enqueue"]);
});

test("ManualCompactionApplication 激活后 control state 读取失败不会擅自收敛 Run", async () => {
  const { app, calls } = create({
    getControlRunState: () => { throw new Error("state read failed"); }
  });
  await assert.rejects(app.schedule(command({ enqueueRun: () => calls.push("enqueue") })), /state read failed/);
  assert.deepEqual(calls, ["activate", "handoff", "enqueue"]);
});

test("M8 manual compaction enqueue acknowledgment blocks shared cancel until it settles", async () => {
  const coordinator = new SessionRuntimeHandoffCoordinator();
  const enteredEnqueue = deferred();
  const releaseEnqueue = deferred();
  const cancelEntered = deferred();
  const lifecycleDependencies: RunLifecycleApplicationDependencies = {
    workspaceRunContextReader: { get: () => ({ workspacePath: "/workspace", workspaceRepoDirNames: [] }) },
    runStateReader: { get: () => controlRunState },
    activeSubtaskChildQuery: { listByParentRun: () => [] },
    promptStaticCacheInvalidator: { clear: () => undefined },
    runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    persistence: {
      listActiveSessionIdsForCancel: () => ["session"],
      activateUserRun: () => ({ kind: "session-running" }),
      canEnqueueUserRunIfCurrent: () => true,
      failRunAfterEnqueueFailureIfCurrent: () => "already-terminal",
      getCancelSessionSnapshot: () => ({ sessionId: "session", workspaceId: "workspace", session, runState: { status: "running", activeRunId: "run" } }),
      cancelSessions: () => {
        cancelEntered.resolve();
        return { rootSessionId: "session", runtimeCancelSessionIds: ["session"], cancelledRunIds: ["run"] };
      },
      markRunWorkInProgress: () => "updated", persistRunTerminalIntent: () => "updated", convergeRunTerminal: () => ({ kind: "already_converged", finalStatus: "cancelled" }), listWorkspaceRunningRunCandidates: () => [],
      listRecoverableRunCandidates: () => [],
      isRecoverableRunCandidate: () => false,
    },
    triggerInputReader: { getUserText: () => null },
    isContextAppendConflict: () => false,
    runtimeHandoffCoordinator: coordinator,
    clock: { nowMs: () => 100 },
    ids: { newId: (prefix) => `${prefix}-id` },
    logger: { warn: () => undefined, error: () => undefined },
  };
  const lifecycle = new RunLifecycleApplication(lifecycleDependencies);
  const { app } = create({
    enqueueActivatedRunOrReconcile: (params) => lifecycle.enqueueActivatedRunOrReconcile(params),
  });
  const compact = app.schedule(command({ enqueueRun: async () => {
    enteredEnqueue.resolve();
    await releaseEnqueue.promise;
  } }));
  await enteredEnqueue.promise;
  const cancel = lifecycle.cancelSession({
    workspaceId: "workspace", sessionId: "session",
    runtime: { enqueueRun: () => undefined, cancelSession: () => undefined },
  });
  await Promise.resolve();
  let cancelObserved = false;
  void cancelEntered.promise.then(() => { cancelObserved = true; });
  await Promise.resolve();
  assert.equal(cancelObserved, false);
  releaseEnqueue.resolve();
  await compact;
  await cancelEntered.promise;
  await cancel;
});

test("M8 cancel holding shared coordinator makes manual compaction final fence fail without enqueue", async () => {
  const coordinator = new SessionRuntimeHandoffCoordinator();
  const enteredCancelRuntime = deferred();
  const releaseCancelRuntime = deferred();
  let active = true;
  let enqueueCalls = 0;
  const lifecycleDependencies: RunLifecycleApplicationDependencies = {
    workspaceRunContextReader: { get: () => ({ workspacePath: "/workspace", workspaceRepoDirNames: [] }) }, runStateReader: { get: () => controlRunState }, activeSubtaskChildQuery: { listByParentRun: () => [] }, promptStaticCacheInvalidator: { clear: () => undefined }, runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    persistence: { listActiveSessionIdsForCancel: () => ["session"], activateUserRun: () => ({ kind: "session-running" }), canEnqueueUserRunIfCurrent: () => active, failRunAfterEnqueueFailureIfCurrent: () => "already-terminal", getCancelSessionSnapshot: () => ({ sessionId: "session", workspaceId: "workspace", session, runState: { status: "running", activeRunId: "run" } }), cancelSessions: () => { active = false; return { rootSessionId: "session", runtimeCancelSessionIds: ["session"], cancelledRunIds: ["run"] }; }, markRunWorkInProgress: () => "updated", persistRunTerminalIntent: () => "updated", convergeRunTerminal: () => ({ kind: "already_converged", finalStatus: "cancelled" }), listWorkspaceRunningRunCandidates: () => [], listRecoverableRunCandidates: () => [], isRecoverableRunCandidate: () => false },
    triggerInputReader: { getUserText: () => null }, isContextAppendConflict: () => false, runtimeHandoffCoordinator: coordinator, clock: { nowMs: () => 100 }, ids: { newId: (prefix) => `${prefix}-id` }, logger: { warn: () => undefined, error: () => undefined },
  };
  const lifecycle = new RunLifecycleApplication(lifecycleDependencies);
  const { app } = create({
    enqueueActivatedRunOrReconcile: (params) => lifecycle.enqueueActivatedRunOrReconcile(params),
  });
  const cancel = lifecycle.cancelSession({ workspaceId: "workspace", sessionId: "session", runtime: { enqueueRun: () => undefined, cancelSession: async () => { enteredCancelRuntime.resolve(); await releaseCancelRuntime.promise; } } });
  await enteredCancelRuntime.promise;
  const compact = app.schedule(command({ enqueueRun: () => { enqueueCalls += 1; } }));
  releaseCancelRuntime.resolve();
  await cancel;
  await assert.rejects(compact, (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_NOT_ACTIVE");
  assert.equal(enqueueCalls, 0);
});

test("manual compaction 激活后 deletion fence 在最终 handoff 获胜时确定性停止且不重排", async () => {
  let enqueueCalls = 0;
  let locks = 0;
  const lifecycleDependencies: RunLifecycleApplicationDependencies = {
    workspaceRunContextReader: { get: () => ({ workspacePath: "/workspace", workspaceRepoDirNames: [] }) },
    runStateReader: { get: () => controlRunState },
    activeSubtaskChildQuery: { listByParentRun: () => [] },
    promptStaticCacheInvalidator: { clear: () => undefined },
    runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    persistence: {
      listActiveSessionIdsForCancel: () => [],
      activateUserRun: () => ({ kind: "session-running" }),
      canEnqueueUserRunIfCurrent: () => true,
      failRunAfterEnqueueFailureIfCurrent: () => "already-terminal",
      getCancelSessionSnapshot: () => null,
      cancelSessions: () => ({ rootSessionId: "session", runtimeCancelSessionIds: [], cancelledRunIds: [] }),
      markRunWorkInProgress: () => "updated", persistRunTerminalIntent: () => "updated", convergeRunTerminal: () => ({ kind: "already_converged", finalStatus: "cancelled" }), listWorkspaceRunningRunCandidates: () => [],
      listRecoverableRunCandidates: () => [],
      isRecoverableRunCandidate: () => false,
    },
    triggerInputReader: { getUserText: () => null },
    isContextAppendConflict: () => false,
    runtimeHandoffCoordinator: {
      async runExclusive(_sessionId, operation) {
        locks += 1;
        if (locks === 1) workspaceDeletingFence.begin("workspace");
        return await operation();
      },
      async runExclusiveMany(_sessionIds, operation) { return await operation(); },
    },
    clock: { nowMs: () => 100 },
    ids: { newId: (prefix) => `${prefix}-id` },
    logger: { warn: () => undefined, error: () => undefined },
  };
  const lifecycle = new RunLifecycleApplication(lifecycleDependencies);
  const { app, calls } = create({
    enqueueActivatedRunOrReconcile: (params) => lifecycle.enqueueActivatedRunOrReconcile(params),
  });
  try {
    await assert.rejects(
      app.schedule(command({ enqueueRun: () => { enqueueCalls += 1; } })),
      (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    workspaceDeletingFence.end("workspace");
  }
  assert.deepEqual(calls, ["activate"]);
  assert.equal(enqueueCalls, 0);
});
