import assert from "node:assert/strict";
import { test } from "node:test";
import { RunLifecycleApplication } from "./run-lifecycle-application.js";
import type {
  EnqueueFailureInput,
  RunLifecycleApplicationDependencies,
  UserRunActivationInput,
  UserRunActivationResult
} from "./run-lifecycle-ports.js";

function createDependencies(params?: {
  activation?: UserRunActivationResult;
  runContext?: { workspacePath: string; workspaceRepoDirNames: string[] } | null;
  settlement?: "failed-and-idled" | "run-failed-state-not-current" | "already-terminal" | "missing-or-mismatch";
}) {
  const calls: unknown[][] = [];
  const dependencies: RunLifecycleApplicationDependencies = {
    workspaceRunContextReader: {
      get(workspaceId) {
        calls.push(["context", workspaceId]);
        return params?.runContext ?? { workspacePath: "/workspace", workspaceRepoDirNames: ["repo"] };
      }
    },
    runStateReader: { get: (sessionId) => ({ sessionId, status: "idle", activeRunId: null, activeAssistantItemId: null, lastResponseTotalTokens: null, nonTerminalItemIds: [], runNoticeText: "", updatedAt: 0, appliedItemId: 0, lastTerminalStatus: null, lastRun: null }) },
    activeSubtaskChildQuery: { listByParentRun: () => [] },
    promptStaticCacheInvalidator: { clear: (runId) => calls.push(["cache", runId]) },
    runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    persistence: {
      activateUserRun(input: UserRunActivationInput) {
        calls.push(["activate", input]);
        return params?.activation ?? { kind: "activated", messageItemId: 7, runId: input.runId };
      },
      failRunAfterEnqueueFailureIfCurrent(input: EnqueueFailureInput) {
        calls.push(["settle", input]);
        return params?.settlement ?? "failed-and-idled";
      },
      getCancelSessionSnapshot: () => null,
      cancelSessions: () => ({ rootSessionId: "session", runtimeCancelSessionIds: [], cancelledRunIds: [] }),
      updateRunStateFromWorker: () => undefined,
      completeRunFromWorker: () => false,
      listRecoverableRunCandidates: () => [],
      isRecoverableRunCandidate: () => false,
      failNonTerminalContextItemsForRecovery: () => 0,
      failRunRecordForRecovery: () => 0,
      reclaimRunStateForRecovery: () => 0,
      appendRecoveryFailureNotice: () => undefined,
      listInFlightSessionsWithoutActiveRunId: () => [],
      reclaimDirtyRunStateForRecovery: () => 0
    },
    triggerInputReader: { getUserText: () => null },
    isContextAppendConflict: () => false,
    clock: { nowMs: () => 123 },
    ids: { newId: (prefix) => `${prefix}-created` },
    logger: { warn: () => undefined, error: () => undefined }
  };
  return { calls, dependencies };
}

function command(runtime: { enqueueRun: (run: unknown) => void | Promise<void> }) {
  return {
    workspaceId: "workspace",
    sessionId: "session",
    clientRequestId: "request",
    text: "trimmed text",
    inputText: " original text ",
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    uiLocale: null,
    runtime: { ...runtime, cancelSession: () => undefined }
  } as const;
}

test("RunLifecycleApplication P3 activates, reads context, and enqueues one run", async () => {
  const { calls, dependencies } = createDependencies();
  const application = new RunLifecycleApplication(dependencies);
  const enqueued: unknown[] = [];

  const result = await application.startUserRun(command({ enqueueRun: (run) => { enqueued.push(run); } }));

  assert.deepEqual(result, { sessionId: "session", messageItemId: 7, runId: "run-created", deduplicated: false });
  assert.deepEqual(calls.map(([kind]) => kind), ["activate", "context"]);
  assert.deepEqual(enqueued, [{
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run-created",
    inputText: " original text ",
    workspacePath: "/workspace",
    workspaceRepoDirNames: ["repo"]
  }]);
});

test("RunLifecycleApplication P3 does not read context or enqueue a deduplicated run", async () => {
  const { calls, dependencies } = createDependencies({
    activation: { kind: "deduplicated", messageItemId: 4, runId: "run-existing" }
  });
  const application = new RunLifecycleApplication(dependencies);

  const result = await application.startUserRun(command({ enqueueRun: () => assert.fail("deduplicated run must not enqueue") }));

  assert.deepEqual(result, { sessionId: "session", messageItemId: 4, runId: "run-existing", deduplicated: true });
  assert.deepEqual(calls.map(([kind]) => kind), ["activate"]);
});

test("RunLifecycleApplication P3 conditionally settles an enqueue failure then preserves the error", async () => {
  const { calls, dependencies } = createDependencies();
  const application = new RunLifecycleApplication(dependencies);
  const enqueueError = new Error("enqueue failed");

  await assert.rejects(
    () => application.startUserRun(command({ enqueueRun: () => { throw enqueueError; } })),
    (error: unknown) => error === enqueueError
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["activate", "context", "settle", "cache"]);
  assert.deepEqual(calls[2], ["settle", {
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run-created",
    updatedAt: 123
  }]);
});

test("RunLifecycleApplication P3 leaves cache intact when a late enqueue settlement observes terminal state", () => {
  const { calls, dependencies } = createDependencies({ settlement: "already-terminal" });
  const application = new RunLifecycleApplication(dependencies);

  assert.equal(application.failRunAfterEnqueueFailure({ workspaceId: "workspace", sessionId: "session", runId: "run" }), "already-terminal");
  assert.deepEqual(calls.map(([kind]) => kind), ["settle"]);
});

test("RunLifecycleApplication P4 delegates worker state with its clock timestamp", () => {
  const { calls, dependencies } = createDependencies();
  dependencies.persistence.updateRunStateFromWorker = (input) => calls.push(["state", input]);
  const application = new RunLifecycleApplication(dependencies);

  application.updateRunStateFromWorker({ workspaceId: "workspace", sessionId: "session", status: "running", activeRunId: "run", activeAssistantItemId: null });

  assert.deepEqual(calls, [["state", {
    workspaceId: "workspace",
    sessionId: "session",
    status: "running",
    activeRunId: "run",
    activeAssistantItemId: null,
    updatedAt: 123
  }]]);
});

test("RunLifecycleApplication P4 publishes and clears only an effective worker completion", () => {
  const { calls, dependencies } = createDependencies();
  const events: unknown[] = [];
  dependencies.persistence.completeRunFromWorker = (input) => {
    calls.push(["complete", input]);
    return true;
  };
  dependencies.runCompletedEventPublisher = { publishRunCompleted: (event) => events.push(event) };
  const application = new RunLifecycleApplication(dependencies);

  application.completeRunFromWorker({ workspaceId: "workspace", sessionId: "session", runId: "run", status: "completed" });

  assert.deepEqual(calls, [["complete", { workspaceId: "workspace", sessionId: "session", runId: "run", status: "completed", updatedAt: 123 }], ["cache", "run"]]);
  assert.deepEqual(events, [{ eventId: "evt-created", occurredAt: 123, workspaceId: "workspace", sessionId: "session", runId: "run", finalStatus: "completed" }]);
});

test("RunLifecycleApplication completeRun 响应丢失后的重放不会重复清 cache 或发布事件", () => {
  const { calls, dependencies } = createDependencies();
  const events: unknown[] = [];
  let terminal = false;
  dependencies.persistence.completeRunFromWorker = (input) => {
    calls.push(["complete", input]);
    if (terminal) return false;
    terminal = true;
    return true;
  };
  dependencies.runCompletedEventPublisher = { publishRunCompleted: (event) => events.push(event) };
  const application = new RunLifecycleApplication(dependencies);
  const request = { workspaceId: "workspace", sessionId: "session", runId: "run", status: "completed" as const };

  application.completeRunFromWorker(request); // persisted, then response is presumed lost to the worker
  application.completeRunFromWorker(request); // retry/fallback replay

  assert.deepEqual(calls, [
    ["complete", { ...request, updatedAt: 123 }],
    ["cache", "run"],
    ["complete", { ...request, updatedAt: 123 }]
  ]);
  assert.equal(events.length, 1);
});

test("RunLifecycleApplication P4 cancel cascades durable state before best-effort runtime cancellation", async () => {
  const { calls, dependencies } = createDependencies();
  const warnings: unknown[] = [];
  const rootSession = {
    id: "root",
    workspaceId: "workspace",
    title: "root",
    kind: "primary" as const,
    forkedFromSessionId: null,
    forkedFromItemId: null,
    headItemId: null,
    createdAt: 1,
    updatedAt: 1
  };
  dependencies.persistence.getCancelSessionSnapshot = (sessionId) => {
    if (sessionId === "root") return { sessionId, workspaceId: "workspace", session: rootSession, runState: { status: "running", activeRunId: "run-root" } };
    if (sessionId === "child") return { sessionId, workspaceId: "workspace", session: { ...rootSession, id: "child", kind: "subtask" as const }, runState: { status: "running", activeRunId: "run-child" } };
    return null;
  };
  dependencies.activeSubtaskChildQuery = {
    listByParentRun: ({ sessionId }) => sessionId === "root" ? ["child"] : []
  };
  dependencies.persistence.cancelSessions = (input) => {
    calls.push(["cancel-db", input]);
    return { rootSessionId: "root", runtimeCancelSessionIds: ["root", "child"], cancelledRunIds: ["run-root", "run-child"] };
  };
  dependencies.logger = { warn: (bindings, message) => warnings.push([bindings, message]), error: () => undefined };
  const application = new RunLifecycleApplication(dependencies);
  const runtimeCalls: string[] = [];

  const result = await application.cancelSession({
    sessionId: "root",
    workspaceId: "workspace",
    runtime: {
      enqueueRun: () => undefined,
      cancelSession: async (sessionId) => {
        runtimeCalls.push(sessionId);
        if (sessionId === "root") throw new Error("runtime unavailable");
      }
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["cancel-db", "cache", "cache"]);
  assert.deepEqual(runtimeCalls, ["root", "child"]);
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0] as unknown[])[1], "agent cancel runtime session failed");
});

test("RunLifecycleApplication P5 rechecks candidates after context reads and isolates enqueue failures", async () => {
  const { calls, dependencies } = createDependencies();
  const first = { workspaceId: "workspace", sessionId: "first", runId: "run-first", triggerItemId: 10 };
  const second = { workspaceId: "workspace", sessionId: "second", runId: "run-second", triggerItemId: null };
  const eligible = new Set([first.runId, second.runId]);
  const warnings: unknown[] = [];
  const enqueued: string[] = [];
  dependencies.persistence.listRecoverableRunCandidates = () => [first, second];
  dependencies.persistence.isRecoverableRunCandidate = (candidate) => {
    calls.push(["eligible", candidate.runId]);
    return eligible.has(candidate.runId);
  };
  dependencies.triggerInputReader = { getUserText: (itemId) => itemId === 10 ? "recovered input" : null };
  dependencies.logger = { warn: (bindings, message) => warnings.push([bindings, message]), error: () => undefined };
  const application = new RunLifecycleApplication(dependencies);

  await application.recoverRunsOnStartup({
    runtime: {
      enqueueRun: async (run) => {
        enqueued.push(`${run.runId}:${run.inputText}`);
        if (run.runId === first.runId) throw new Error("expected enqueue failure");
      },
      cancelSession: () => undefined
    },
    beforeFinalCheck: (candidate) => {
      if (candidate.runId === second.runId) eligible.delete(second.runId);
    }
  });

  assert.deepEqual(enqueued, ["run-first:recovered input"]);
  assert.deepEqual(calls.map(([kind]) => kind), ["eligible", "context", "eligible", "eligible", "context", "eligible"]);
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0] as unknown[])[1], "startup recovery mode=recover: enqueue run failed");
});

test("RunLifecycleApplication P5 fail recovery preserves independent steps, CAS notices and dirty-state cleanup", () => {
  const { calls, dependencies } = createDependencies();
  const candidate = { workspaceId: "workspace", sessionId: "session", runId: "run", triggerItemId: null };
  const dirty = { workspaceId: "workspace", sessionId: "dirty" };
  dependencies.persistence.listRecoverableRunCandidates = () => [candidate];
  dependencies.persistence.failNonTerminalContextItemsForRecovery = (input) => {
    calls.push(["fail-items", input]);
    return 1;
  };
  dependencies.persistence.failRunRecordForRecovery = (input) => {
    calls.push(["fail-run", input]);
    return 1;
  };
  dependencies.persistence.reclaimRunStateForRecovery = (input) => {
    calls.push(["reclaim", input]);
    return 1;
  };
  dependencies.persistence.appendRecoveryFailureNotice = (input) => calls.push(["notice", input]);
  dependencies.persistence.listInFlightSessionsWithoutActiveRunId = () => [dirty];
  dependencies.persistence.reclaimDirtyRunStateForRecovery = (input) => {
    calls.push(["dirty", input]);
    return 1;
  };
  const application = new RunLifecycleApplication(dependencies);

  application.failRunsOnStartup();

  assert.deepEqual(calls, [
    ["fail-items", { ...candidate, updatedAt: 123 }],
    ["fail-run", { ...candidate, updatedAt: 123 }],
    ["reclaim", { ...candidate, updatedAt: 123 }],
    ["notice", { ...candidate, text: "[run] marked failed on server restart (startup recovery mode: fail)", createdAt: 123 }],
    ["dirty", { ...dirty, updatedAt: 123 }]
  ]);
});
