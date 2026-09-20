import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { AgentAttachmentCommitError } from "../attachments/agent-attachment-storage.js";
import { RunLifecycleApplication } from "./run-lifecycle-application.js";
import { SessionRuntimeHandoffCoordinator } from "./session-runtime-handoff-coordinator.js";
import { workspaceDeletingFence } from "./workspace-deleting-fence.js";
import type {
  EnqueueFailureInput,
  RunLifecycleApplicationDependencies,
  UserRunActivationInput,
  UserRunActivationResult,
} from "./run-lifecycle-ports.js";

const image = (suffix: string, position: number) => ({
  attachmentId: `att_${suffix}`,
  storageKey: `att_${suffix}`,
  tempId: `tmp_${suffix}`,
  filename: "image.png",
  mediaType: "image/png" as const,
  byteSize: 12,
  position,
});

function createDependencies(params?: {
  activation?: UserRunActivationResult;
  runContext?: { workspacePath: string; workspaceRepoDirNames: string[] } | null;
  settlement?: "intent-persisted" | "failed-and-idled" | "run-failed-state-not-current" | "already-terminal" | "missing-or-mismatch";
  canEnqueue?: boolean;
}) {
  const calls: unknown[][] = [];
  const dependencies: RunLifecycleApplicationDependencies = {
    workspaceRunContextReader: { get(workspaceId) { calls.push(["context", workspaceId]); return params?.runContext ?? { workspacePath: "/workspace", workspaceRepoDirNames: ["repo"] }; } },
    runStateReader: { get: (sessionId) => ({ workspaceId: "workspace", sessionId, status: "idle", activeRunId: null, runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 0 }) },
    activeSubtaskChildQuery: { listByParentRun: () => [] },
    promptStaticCacheInvalidator: { clear: (runId) => calls.push(["cache", runId]) },
    runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    persistence: {
      activateUserRun(input: UserRunActivationInput) { calls.push(["activate", input]); return params?.activation ?? { kind: "activated", messageId: "message-7", runId: input.runId }; },
      canEnqueueUserRunIfCurrent(input) { calls.push(["fence", input]); return params?.canEnqueue ?? true; },
      failRunAfterEnqueueFailureIfCurrent(input: EnqueueFailureInput) { calls.push(["settle", input]); return params?.settlement ?? "failed-and-idled"; },
      listActiveSessionIdsForCancel: () => [],
      getCancelSessionSnapshot: () => null,
      cancelSessions: () => ({ rootSessionId: "session", runtimeCancelSessionIds: [], cancelledRunIds: [], terminalIntents: [] }),
      markRunWorkInProgress: () => "updated",
      persistRunTerminalIntent: () => "updated",
      convergeRunTerminal: () => ({ kind: "transitioned", finalStatus: "completed" }),
      listWorkspaceRunningRunCandidates: () => [],
      listRecoverableRunCandidates: () => [],
      isRecoverableRunCandidate: () => false,
    },
    triggerInputReader: { getUserText: () => null },
    isContextAppendConflict: () => false,
    runtimeHandoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    clock: { nowMs: () => 123 },
    ids: { newId: (prefix) => `${prefix}-created` },
    logger: { warn: () => undefined, error: () => undefined },
  };
  return { calls, dependencies };
}

function command(runtime: { enqueueRun: (run: unknown) => void | Promise<void> }) {
  return { workspaceId: "workspace", sessionId: "session", clientRequestId: "request", text: "trimmed text", inputText: " original text ", agentId: "agent", providerId: "provider", modelId: "model", uiLocale: null, runtime: { ...runtime, cancelSession: () => undefined } } as const;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

test("RunLifecycleApplication 在无附件时激活、围栏并入队", async () => {
  const { calls, dependencies } = createDependencies();
  const application = new RunLifecycleApplication(dependencies);
  const enqueued: unknown[] = [];
  const result = await application.startUserRun(command({ enqueueRun: (run) => { enqueued.push(run); } }));
  assert.deepEqual(result, { sessionId: "session", messageId: "message-7", runId: "run-created", deduplicated: false });
  assert.deepEqual(calls.map(([kind]) => kind), ["activate", "context", "fence"]);
  assert.equal(enqueued.length, 1);
});

test("runtime handoff: send enqueue acknowledgement 期间 cancel 等待，随后收敛并取消 runtime", async () => {
  const { calls, dependencies } = createDependencies();
  const enteredEnqueue = deferred();
  const releaseEnqueue = deferred();
  const cancelEntered = deferred();
  let cancelled = false;
  dependencies.persistence.getCancelSessionSnapshot = () => ({
    sessionId: "session", workspaceId: "workspace", session: {
      id: "session", workspaceId: "workspace", title: "session", kind: "primary", forkedFromSessionId: null, forkedFromMessageId: null,
      headMessageId: null, contextRootMessageId: null, revision: 0, createdAt: 1, updatedAt: 1,
    }, runState: { status: "running", activeRunId: "run-created" },
  });
  dependencies.persistence.listActiveSessionIdsForCancel = () => ["session"];
  dependencies.persistence.cancelSessions = () => {
    cancelled = true;
    cancelEntered.resolve();
    return { rootSessionId: "session", runtimeCancelSessionIds: ["session"], cancelledRunIds: ["run-created"], terminalIntents: [] };
  };
  dependencies.runStateReader = { get: () => ({ workspaceId: "workspace", sessionId: "session", status: "idle", activeRunId: null, runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 0 }) };
  const application = new RunLifecycleApplication(dependencies);
  const send = application.startUserRun(command({ enqueueRun: async () => {
    enteredEnqueue.resolve();
    await releaseEnqueue.promise;
  } }));
  await enteredEnqueue.promise;
  const cancel = application.cancelSession({ workspaceId: "workspace", sessionId: "session", runtime: { enqueueRun: () => undefined, cancelSession: () => undefined } });
  await Promise.resolve();
  assert.equal(cancelled, false);
  releaseEnqueue.resolve();
  await send;
  await cancelEntered.promise;
  await cancel;
  assert.equal(cancelled, true);
  assert.equal(calls.filter(([kind]) => kind === "fence").length, 1);
});

test("runtime handoff: cancel 先收敛时，已激活 send 的最终 fence 阻止 enqueue", async () => {
  const { dependencies } = createDependencies();
  const cancelEntered = deferred();
  const releaseCancel = deferred();
  let active = true;
  dependencies.persistence.getCancelSessionSnapshot = () => ({
    sessionId: "session", workspaceId: "workspace", session: {
      id: "session", workspaceId: "workspace", title: "session", kind: "primary", forkedFromSessionId: null, forkedFromMessageId: null,
      headMessageId: null, contextRootMessageId: null, revision: 0, createdAt: 1, updatedAt: 1,
    }, runState: { status: "running", activeRunId: "run-created" },
  });
  dependencies.persistence.listActiveSessionIdsForCancel = () => ["session"];
  dependencies.persistence.cancelSessions = () => {
    cancelEntered.resolve();
    return { rootSessionId: "session", runtimeCancelSessionIds: ["session"], cancelledRunIds: ["run-created"], terminalIntents: [] };
  };
  dependencies.persistence.canEnqueueUserRunIfCurrent = () => active;
  const originalCancel = dependencies.persistence.cancelSessions;
  dependencies.persistence.cancelSessions = () => {
    const result = originalCancel({ workspaceId: "workspace", rootSessionId: "session", updatedAt: 123, listActiveChildSessionIds: () => [] });
    active = false;
    return result;
  };
  const application = new RunLifecycleApplication(dependencies);
  const cancel = application.cancelSession({ workspaceId: "workspace", sessionId: "session", runtime: { enqueueRun: () => undefined, cancelSession: async () => await releaseCancel.promise } });
  await cancelEntered.promise;
  let enqueueCalls = 0;
  const send = application.startUserRun(command({ enqueueRun: () => { enqueueCalls += 1; } }));
  releaseCancel.resolve();
  await cancel;
  await assert.rejects(send, (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_NOT_ACTIVE");
  assert.equal(enqueueCalls, 0);
});

test("RunLifecycleApplication 不读取上下文或入队重复请求", async () => {
  const { calls, dependencies } = createDependencies({ activation: { kind: "deduplicated", messageId: "message-4", runId: "run-existing" } });
  const result = await new RunLifecycleApplication(dependencies).startUserRun(command({ enqueueRun: () => assert.fail("deduplicated run must not enqueue") }));
  assert.deepEqual(result, { sessionId: "session", messageId: "message-4", runId: "run-existing", deduplicated: true });
  assert.deepEqual(calls.map(([kind]) => kind), ["activate"]);
});

test("RunLifecycleApplication 在全部附件提交后才激活 SQLite", async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.attachmentCommitter = {
    commit: async ({ image }) => { calls.push(["commit", image.attachmentId]); },
    removeTemp: async ({ tempId }) => { calls.push(["remove-temp", tempId]); },
    removeFinal: async ({ image }) => { calls.push(["remove-final", image.attachmentId]); },
  };
  await new RunLifecycleApplication(dependencies).startUserRun({ ...command({ enqueueRun: () => undefined }), images: [image("first", 0), image("second", 1)] });
  assert.deepEqual(calls.map(([kind]) => kind), ["commit", "commit", "activate", "context", "fence"]);
});

test("RunLifecycleApplication 第二张附件提交失败时不激活并尽力清理", async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.attachmentCommitter = {
    commit: async ({ image: current }) => { calls.push(["commit", current.attachmentId]); if (current.position === 1) throw new Error("second commit failed"); },
    removeTemp: async ({ tempId }) => { calls.push(["remove-temp", tempId]); if (tempId.includes("second")) throw new Error("cleanup failure"); },
    removeFinal: async ({ image: current }) => { calls.push(["remove-final", current.attachmentId]); },
  };
  await assert.rejects(() => new RunLifecycleApplication(dependencies).startUserRun({ ...command({ enqueueRun: () => undefined }), images: [image("first", 0), image("second", 1)] }), /second commit failed/);
  assert.deepEqual(calls.map(([kind]) => kind), ["commit", "commit", "remove-final", "remove-temp", "remove-temp"]);
});

test("RunLifecycleApplication 将 link 成功但 unlink temp 失败的 final 纳入清理", async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.attachmentCommitter = {
    commit: async () => { throw new AgentAttachmentCommitError(true, false, { cause: new Error("unlink failed") }); },
    removeTemp: async ({ tempId }) => { calls.push(["remove-temp", tempId]); },
    removeFinal: async ({ image: current }) => { calls.push(["remove-final", current.attachmentId]); },
  };
  await assert.rejects(() => new RunLifecycleApplication(dependencies).startUserRun({ ...command({ enqueueRun: () => undefined }), images: [image("linked", 0)] }), AgentAttachmentCommitError);
  assert.deepEqual(calls.map(([kind]) => kind), ["remove-final", "remove-temp"]);
});

test("RunLifecycleApplication 对 attachment cleanup pending 不使用逻辑路径清理 final", async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.attachmentCommitter = {
    commit: async () => { throw new AgentAttachmentCommitError(true, true, { cause: new Error("directory replaced") }); },
    removeTemp: async ({ tempId }) => { calls.push(["remove-temp", tempId]); },
    removeFinal: async ({ image: current }) => { calls.push(["remove-final", current.attachmentId]); },
  };
  await assert.rejects(
    () => new RunLifecycleApplication(dependencies).startUserRun({ ...command({ enqueueRun: () => undefined }), images: [image("linked", 0)] }),
    AgentAttachmentCommitError,
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["remove-temp"]);
});

test("RunLifecycleApplication DB 激活失败时清理本请求已提交 final 和 temp", async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.persistence.activateUserRun = () => { calls.push(["activate"]); throw new Error("database failed"); };
  dependencies.attachmentCommitter = {
    commit: async ({ image: current }) => { calls.push(["commit", current.attachmentId]); },
    removeTemp: async ({ tempId }) => { calls.push(["remove-temp", tempId]); },
    removeFinal: async ({ image: current }) => { calls.push(["remove-final", current.attachmentId]); },
  };
  await assert.rejects(() => new RunLifecycleApplication(dependencies).startUserRun({ ...command({ enqueueRun: () => undefined }), images: [image("only", 0)] }), /database failed/);
  assert.deepEqual(calls.map(([kind]) => kind), ["commit", "activate", "remove-final", "remove-temp"]);
});

test("RunLifecycleApplication cancel 在最终围栏获胜时保留已激活附件且不入队", async () => {
  const { calls, dependencies } = createDependencies({ canEnqueue: false });
  dependencies.attachmentCommitter = {
    commit: async ({ image: current }) => { calls.push(["commit", current.attachmentId]); },
    removeTemp: async ({ tempId }) => { calls.push(["remove-temp", tempId]); },
    removeFinal: async ({ image: current }) => { calls.push(["remove-final", current.attachmentId]); },
  };
  await assert.rejects(() => new RunLifecycleApplication(dependencies).startUserRun({ ...command({ enqueueRun: () => assert.fail("cancelled run must not enqueue") }), images: [image("only", 0)] }), (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_NOT_ACTIVE");
  assert.deepEqual(calls.map(([kind]) => kind), ["commit", "activate", "context", "fence"]);
});

test("RunLifecycleApplication P3 conditionally settles an enqueue failure then preserves the error", async () => {
  const { calls, dependencies } = createDependencies();
  const application = new RunLifecycleApplication(dependencies);
  const enqueueError = new Error("worker accepted run but acknowledgement was lost");
  await assert.rejects(
    () => application.startUserRun(command({ enqueueRun: () => { throw enqueueError; } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "AGENT_WORKER_ENQUEUE_UNKNOWN",
  );
  // A network error cannot prove the worker did not accept the idempotent
  // runId, so the durable state must stay running for reconciliation.
  assert.deepEqual(calls.map(([kind]) => kind), ["activate", "context", "fence"]);
});

test("RunLifecycleApplication 在 ACK 丢失后以同一 runId 协调重试，不会 failed/idle", async () => {
  const { calls, dependencies } = createDependencies();
  let attempts = 0;
  const application = new RunLifecycleApplication(dependencies);
  await assert.rejects(
    () => application.startUserRun(command({ enqueueRun: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("worker accepted then lost ACK");
    } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "AGENT_WORKER_ENQUEUE_UNKNOWN",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(attempts, 2);
  assert.equal(calls.some(([kind]) => kind === "settle"), false);
});

test("RunLifecycleApplication only settles an explicit permanent enqueue rejection", async () => {
  const { calls, dependencies } = createDependencies({ settlement: "intent-persisted" });
  dependencies.persistence.convergeRunTerminal = (input) => {
    calls.push(["converge", input]);
    return { kind: "transitioned", finalStatus: "failed" };
  };
  const application = new RunLifecycleApplication(dependencies);
  const rejection = new (await import("../../../app/errors.js")).HttpError(400, "invalid enqueue", "AGENT_WORKER_ENQUEUE_REJECTED");
  await assert.rejects(() => application.startUserRun(command({ enqueueRun: () => { throw rejection; } })), (error: unknown) => error === rejection);
  assert.deepEqual(calls.map(([kind]) => kind), ["activate", "context", "fence", "settle", "converge", "cache"]);
});

test("RunLifecycleApplication reconciliation 永久拒绝 settlement 后清除 retry attempt", async () => {
  const { calls, dependencies } = createDependencies();
  let attempts = 0;
  const application = new RunLifecycleApplication(dependencies);
  const rejection = new (await import("../../../app/errors.js")).HttpError(409, "invalid enqueue", "AGENT_WORKER_ENQUEUE_REJECTED");
  await assert.rejects(
    application.startUserRun(command({ enqueueRun: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("response lost");
      throw rejection;
    } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "AGENT_WORKER_ENQUEUE_UNKNOWN",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(attempts, 2);
  assert.equal(calls.filter(([kind]) => kind === "settle").length, 1);
  assert.equal((application as any).reconciliationAttempts.has("run-created"), false);
});

test("RunLifecycleApplication reconciliation 在 cancel 后不会 late enqueue", async () => {
  const { dependencies } = createDependencies();
  let active = true;
  let enqueueCalls = 0;
  dependencies.persistence.canEnqueueUserRunIfCurrent = () => active;
  const application = new RunLifecycleApplication(dependencies);

  await assert.rejects(
    application.startUserRun(command({
      enqueueRun: () => {
        enqueueCalls += 1;
        throw new Error("ack lost");
      },
    })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "AGENT_WORKER_ENQUEUE_UNKNOWN",
  );
  active = false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(enqueueCalls, 1);
});

test("RunLifecycleApplication reconciliation 在 Workspace deleting 后不会 late enqueue", async () => {
  const { dependencies } = createDependencies();
  let enqueueCalls = 0;
  const application = new RunLifecycleApplication(dependencies);

  await assert.rejects(application.startUserRun(command({ enqueueRun: () => {
    enqueueCalls += 1;
    throw new Error("ack lost");
  } })), /enqueue status is unknown/);
  workspaceDeletingFence.begin("workspace");
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(enqueueCalls, 1);
  } finally {
    workspaceDeletingFence.end("workspace");
  }
});

test("RunLifecycleApplication dispose 清除 reconciliation timer 且禁止后续重排", async () => {
  const { dependencies } = createDependencies();
  let enqueueCalls = 0;
  const application = new RunLifecycleApplication(dependencies);
  await assert.rejects(application.startUserRun(command({ enqueueRun: () => {
    enqueueCalls += 1;
    throw new Error("response lost");
  } })), /enqueue status is unknown/);
  assert.equal(enqueueCalls, 1);
  application.dispose();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(enqueueCalls, 1);
  await assert.rejects(
    application.enqueueActivatedRunOrReconcile({
      runtime: { enqueueRun: () => { enqueueCalls += 1; } },
      run: { workspaceId: "workspace", sessionId: "session", runId: "run", workspacePath: "/workspace", workspaceRepoDirNames: [] },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "AGENT_LIFECYCLE_STOPPING",
  );
});

test("RunLifecycleApplication P3 leaves cache intact when a late enqueue settlement observes terminal state", () => {
  const { calls, dependencies } = createDependencies({ settlement: "already-terminal" });
  const application = new RunLifecycleApplication(dependencies);

  assert.equal(application.failRunAfterEnqueueFailure({ workspaceId: "workspace", sessionId: "session", runId: "run" }), "already-terminal");
  assert.deepEqual(calls.map(([kind]) => kind), ["settle"]);
});

test("RunLifecycleApplication terminal convergence always clears cache and only publishes transition", () => {
  const { calls, dependencies } = createDependencies();
  const events: unknown[] = [];
  dependencies.persistence.convergeRunTerminal = (input) => {
    calls.push(["converge", input]);
    return { kind: "transitioned", finalStatus: "completed" };
  };
  dependencies.runCompletedEventPublisher = { publishRunCompleted: (event) => events.push(event) };
  const application = new RunLifecycleApplication(dependencies);

  application.convergeRunTerminal({ workspaceId: "workspace", sessionId: "session", runId: "run", updatedAt: 123 });

  assert.deepEqual(calls, [["converge", { workspaceId: "workspace", sessionId: "session", runId: "run", updatedAt: 123 }], ["cache", "run"]]);
  assert.deepEqual(events, [{ eventId: "evt-created", occurredAt: 123, workspaceId: "workspace", sessionId: "session", runId: "run", finalStatus: "completed" }]);
});

test("RunLifecycleApplication convergence replay clears cache without duplicate event", () => {
  const { calls, dependencies } = createDependencies();
  const events: unknown[] = [];
  let transitioned = true;
  dependencies.persistence.convergeRunTerminal = (input) => {
    calls.push(["converge", input]);
    const result = transitioned ? { kind: "transitioned" as const, finalStatus: "completed" as const } : { kind: "already_converged" as const, finalStatus: "completed" as const };
    transitioned = false;
    return result;
  };
  dependencies.runCompletedEventPublisher = { publishRunCompleted: (event) => events.push(event) };
  const application = new RunLifecycleApplication(dependencies);
  const request = { workspaceId: "workspace", sessionId: "session", runId: "run", updatedAt: 123 };

  application.convergeRunTerminal(request);
  application.convergeRunTerminal(request);

  assert.equal(calls.filter(([kind]) => kind === "cache").length, 2);
  assert.equal(events.length, 1);
});

test("Workspace 删除按稳定顺序经同一终态收敛路径后才允许 drain", () => {
  const { calls, dependencies } = createDependencies();
  const events: unknown[] = [];
  dependencies.persistence.listWorkspaceRunningRunCandidates = () => [
    { workspaceId: "workspace", sessionId: "session-a", runId: "run-a", executionPhase: "terminal_intent_persisted" },
    { workspaceId: "workspace", sessionId: "session-b", runId: "run-b", executionPhase: "work_in_progress" },
  ];
  dependencies.persistence.persistRunTerminalIntent = (input) => {
    calls.push(["intent", input]);
    return "updated";
  };
  dependencies.persistence.convergeRunTerminal = (input) => {
    calls.push(["converge", input]);
    return { kind: "transitioned", finalStatus: "cancelled" };
  };
  dependencies.runCompletedEventPublisher = { publishRunCompleted: (event) => events.push(event) };
  const application = new RunLifecycleApplication(dependencies);

  assert.deepEqual(application.settleWorkspaceRunsForDeletion("workspace"), ["session-a", "session-b"]);
  assert.deepEqual(calls.map(([kind, input]) => [kind, (input as { runId?: string }).runId]), [
    ["converge", "run-a"], ["cache", undefined], ["intent", "run-b"], ["converge", "run-b"], ["cache", undefined],
  ]);
  assert.equal(events.length, 2);
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
    forkedFromMessageId: null,
    headMessageId: null,
    contextRootMessageId: null,
    revision: 0,
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
    return { rootSessionId: "root", runtimeCancelSessionIds: ["root", "child"], cancelledRunIds: ["run-root", "run-child"], terminalIntents: [
      { workspaceId: "workspace", sessionId: "root", runId: "run-root" },
      { workspaceId: "workspace", sessionId: "child", runId: "run-child" },
    ] };
  };
  dependencies.persistence.convergeRunTerminal = (input) => {
    calls.push(["converge", input]);
    return { kind: "transitioned", finalStatus: "cancelled" };
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
  assert.deepEqual(calls.map(([kind]) => kind), ["cancel-db", "converge", "cache", "converge", "cache"]);
  assert.deepEqual(runtimeCalls, ["root", "child"]);
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0] as unknown[])[1], "agent cancel runtime session failed");
});


test("startup recovery persists a stable failure intent then converges without re-enqueue", async () => {
  const { calls, dependencies } = createDependencies();
  const candidate = { workspaceId: "workspace", sessionId: "session", runId: "run-startup", runKind: "user" as const, triggerMessageId: null, executionPhase: "work_in_progress" as const };
  dependencies.persistence.listRecoverableRunCandidates = () => [candidate];
  dependencies.persistence.isRecoverableRunCandidate = () => true;
  dependencies.persistence.persistRunTerminalIntent = (input) => { calls.push(["intent", input]); return "updated"; };
  dependencies.persistence.convergeRunTerminal = (input) => { calls.push(["converge", input]); return { kind: "transitioned", finalStatus: "failed" }; };
  await new RunLifecycleApplication(dependencies).recoverRunsOnStartup({ runtime: { enqueueRun: () => assert.fail("startup must not re-enqueue work"), cancelSession: () => undefined } });
  assert.deepEqual(calls.map(([kind]) => kind), ["intent", "converge", "cache"]);
  assert.equal((calls[0]?.[1] as { code: string }).code, "run_startup_recovery_failed");
});

test("startup recovery converges persisted intent without replacing it", async () => {
  const { calls, dependencies } = createDependencies();
  const candidate = { workspaceId: "workspace", sessionId: "session", runId: "run-intent", runKind: "subtask" as const, triggerMessageId: null, executionPhase: "terminal_intent_persisted" as const };
  dependencies.persistence.listRecoverableRunCandidates = () => [candidate];
  dependencies.persistence.isRecoverableRunCandidate = () => true;
  dependencies.persistence.persistRunTerminalIntent = () => assert.fail("persisted intent must remain authoritative");
  dependencies.persistence.convergeRunTerminal = (input) => { calls.push(["converge", input]); return { kind: "transitioned", finalStatus: "cancelled" }; };
  await new RunLifecycleApplication(dependencies).recoverRunsOnStartup({ runtime: { enqueueRun: () => assert.fail("startup must not re-enqueue work"), cancelSession: () => undefined } });
  assert.deepEqual(calls.map(([kind]) => kind), ["converge", "cache"]);
});

test("user activation 后 enqueue handoff 被 deletion fence 阻止时不建立 reconciliation", async () => {
  const { dependencies } = createDependencies();
  let enqueueCalls = 0;
  let locks = 0;
  dependencies.runtimeHandoffCoordinator = {
    async runExclusive(_sessionId, operation) {
      locks += 1;
      if (locks === 1) workspaceDeletingFence.begin("workspace");
      return await operation();
    },
    async runExclusiveMany(_sessionIds, operation) { return await operation(); },
  };
  const application = new RunLifecycleApplication(dependencies);
  try {
    await assert.rejects(
      application.startUserRun(command({ enqueueRun: () => { enqueueCalls += 1; } })),
      (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    workspaceDeletingFence.end("workspace");
  }
  assert.equal(enqueueCalls, 0);
});
