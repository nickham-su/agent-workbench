import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, test } from "node:test";
import { dbPath } from "../../infra/fs/paths.js";
import { newSortableId } from "../../utils/ids.js";
import { createAgentService } from "./agent.composition.js";
import { agentAttachmentRelativePath, agentAttachmentStorageKey, agentAttachmentTempFilePath } from "./attachments/agent-attachment-paths.js";
import {
  prepareAgentWorkspaceAttachmentPublication,
  createAgentAttachmentTempFile,
  resolveSafeWorkspaceAgentAttachment,
  removeAgentWorkspaceAttachmentFinalFile,
  removeAgentAttachmentTempFile,
} from "./attachments/agent-attachment-storage.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { RunLifecycleApplication } from "./lifecycle/run-lifecycle-application.js";
import type { RunLifecycleApplicationDependencies, UserRunActivationInput } from "./lifecycle/run-lifecycle-ports.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  createMessageSession,
  flushStreamingParts,
  getMessageRunState,
  getMessageSessionHead,
  getToolExecution,
  startMessageRun,
  updateToolExecution,
} from "./agent-message.store.js";
import { createMessageRunRecord, getRunRecord } from "./agent-message.store.js";
import { SqliteRunLifecyclePersistence } from "./lifecycle/sqlite-run-lifecycle-persistence.js";
import { SessionRuntimeHandoffCoordinator } from "./lifecycle/session-runtime-handoff-coordinator.js";
import {
  createAgentTestFixture,
  createFakeAgentRuntime,
  createTestWorkspace,
  type AgentTestFixture,
} from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Run lifecycle fixture cleanup failed");
});

async function createMessageLifecycleFixture(title: string) {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title });
  const sessionId = newSortableId("sess");
  const createdAt = Date.now();
  createMessageSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: `${title} session`,
    kind: "primary",
    createdAt,
  });
  return { fixture, workspace, sessionId, createdAt };
}

/** 真实构造 User Message / Text Part / Run，并通过唯一入口激活 session_run_state。 */
function createAndActivateRun(params: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  runId: string;
  createdAt: number;
}) {
  const head = getMessageSessionHead(params.fixture.db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
  assert.ok(head);
  const messageId = newSortableId("msg");
  appendMessage(params.fixture.db, {
    id: messageId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: `trigger ${params.runId}` }],
    createdAt: params.createdAt,
  });
  createMessageRunRecord(params.fixture.db, {
    runId: params.runId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    triggerMessageId: messageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: null,
    parentToolExecutionId: null,
    status: "running",
    createdAt: params.createdAt,
  });
  startMessageRun(params.fixture.db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    updatedAt: params.createdAt,
  });
}

async function stageImage(fixture: AgentTestFixture, suffix: string) {
  const tempId = newSortableId("tmp");
  const attachmentId = newSortableId("att");
  const handle = await createAgentAttachmentTempFile({ dataDir: fixture.dataDir, tempId });
  await handle.writeFile(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await handle.close();
  return { attachmentId, storageKey: agentAttachmentStorageKey(attachmentId, "image/png"), tempId, filename: "image.png", mediaType: "image/png" as const, byteSize: 8, position: 0 };
}

function finalPath(fixture: AgentTestFixture, workspaceId: string, image: { attachmentId: string; storageKey: string; mediaType: "image/png" }) {
  const workspace = getWorkspace(fixture.db, workspaceId);
  assert.ok(workspace);
  return path.join(workspace.path, agentAttachmentRelativePath(image.attachmentId, image.storageKey, image.mediaType));
}

function createStorageCommitter(fixture: AgentTestFixture): NonNullable<RunLifecycleApplicationDependencies["attachmentCommitter"]> {
  return {
    prepare: async ({ workspaceId, image }) => {
      const workspace = getWorkspace(fixture.db, workspaceId);
      assert.ok(workspace);
      return prepareAgentWorkspaceAttachmentPublication({ dataDir: fixture.dataDir, workspaceDirName: workspace.dirName, attachmentId: image.attachmentId, storageKey: image.storageKey, mediaType: image.mediaType, tempId: image.tempId });
    },
    removeTemp: async ({ tempId }) => { await removeAgentAttachmentTempFile({ dataDir: fixture.dataDir, tempId }); },
    removeFinal: async ({ workspaceId, image, owned }) => {
      const workspace = getWorkspace(fixture.db, workspaceId);
      assert.ok(workspace);
      await removeAgentWorkspaceAttachmentFinalFile({ dataDir: fixture.dataDir, workspaceDirName: workspace.dirName, attachmentId: image.attachmentId, storageKey: image.storageKey, mediaType: image.mediaType, owned });
    },
  };
}

function createApplicationWithStorage(params: {
  fixture: AgentTestFixture;
  persistence: SqliteRunLifecyclePersistence;
  onContextRead?: () => void;
  coordinator?: SessionRuntimeHandoffCoordinator;
  attachmentCommitter?: NonNullable<RunLifecycleApplicationDependencies["attachmentCommitter"]>;
}) {
  const dependencies: RunLifecycleApplicationDependencies = {
    workspaceRunContextReader: { get: () => { params.onContextRead?.(); return { workspacePath: "/workspace", workspaceRepoDirNames: [] }; } },
    runStateReader: { get: () => { throw new Error("not used by startUserRun"); } },
    activeSubtaskChildQuery: { listByParentRun: () => [] },
    promptStaticCacheInvalidator: { clear: () => undefined },
    runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    persistence: params.persistence,
    attachmentCommitter: params.attachmentCommitter ?? createStorageCommitter(params.fixture),
    triggerInputReader: { getUserText: () => null },
    isContextAppendConflict: () => false,
    runtimeHandoffCoordinator: params.coordinator ?? new SessionRuntimeHandoffCoordinator(),
    clock: { nowMs: () => Date.now() },
    ids: { newId: newSortableId },
    logger: { warn: () => undefined, error: () => undefined },
  };
  return new RunLifecycleApplication(dependencies);
}

test("H1 real SQLite/FS: pre-publication DB conflict creates no final or Message graph", async () => {
  const fixture = await createAgentTestFixture({ agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, { title: "H1 database failure" });
  const image = await stageImage(fixture, "db_failure");
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });
  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId: "sess_missing", clientRequestId: "h1-db-failure", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() }));
  await assert.rejects(() => fs.access(finalPath(fixture, workspace.id, image)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, image.tempId)));
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 0);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message").get() as { count: number }).count, 0);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_run").get() as { count: number }).count, 0);
});

test("M6 real SQLite/FS: second attachment EEXIST rejects before publishing the first", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("M6 EEXIST");
  const first = await stageImage(fixture, "first");
  const second = await stageImage(fixture, "second");
  const existingFinal = finalPath(fixture, workspace.id, second);
  await fs.mkdir((await import("node:path")).dirname(existingFinal), { recursive: true });
  await fs.chmod(path.dirname(existingFinal), 0o700);
  await fs.writeFile(existingFinal, "existing");
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });

  await assert.rejects(
    () => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "m6-eexist", text: "two", inputText: "two", images: [first, { ...second, position: 1 }], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() }),
    /attachment final name is occupied/,
  );
  await assert.rejects(() => fs.access(finalPath(fixture, workspace.id, first)));
  assert.equal(await fs.readFile(existingFinal, "utf8"), "existing");
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, first.tempId)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, second.tempId)));
  for (const table of ["agent_attachment", "agent_message", "agent_run", "agent_client_request"]) {
    assert.equal((fixture.db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count, 0);
  }
});

test("M6 real SQLite/FS: unlink failure after link is cleaned through application", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("M6 unlink");
  const image = await stageImage(fixture, "unlink");
  const persistence = new SqliteRunLifecyclePersistence(fixture.db);
  const attachmentCommitter: NonNullable<RunLifecycleApplicationDependencies["attachmentCommitter"]> = createStorageCommitter(fixture);
  const application = createApplicationWithStorage({ fixture, persistence, attachmentCommitter });
  await application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "m6-unlink", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() });
  await assert.doesNotReject(() => fs.access(finalPath(fixture, workspace.id, image)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, image.tempId)));
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 1);
});

test("M6 real SQLite/FS: SQLite trigger abort rolls back graph but retains final orphan", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("M6 trigger");
  const image = await stageImage(fixture, "trigger");
  fixture.db.exec(`create trigger test_m6_abort before insert on agent_message begin select raise(abort, 'm6'); end`);
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });

  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "m6-trigger", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() }));
  await assert.doesNotReject(() => fs.access(finalPath(fixture, workspace.id, image)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, image.tempId)));
  for (const table of ["agent_attachment", "agent_message", "agent_message_part", "agent_run", "agent_client_request"]) {
    const count = (fixture.db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count;
    assert.equal(count, 0);
  }
  const state = getMessageRunState(fixture.db, workspace.id, sessionId);
  assert.ok(state);
  assert.equal(state.status, "idle");
  assert.equal(state.activeRunId, null);
});

test("H1 real SQLite/FS: cancel before final fence keeps Message、attachment and final file but never enqueues", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("H1 cancel fence");
  const image = await stageImage(fixture, "cancel_fence");
  const persistence = new SqliteRunLifecyclePersistence(fixture.db);
  const runtime = createFakeAgentRuntime();
  const application = createApplicationWithStorage({ fixture, persistence, onContextRead: () => {
    const cancelled = persistence.cancelSessions({ workspaceId: workspace.id, rootSessionId: sessionId, updatedAt: Date.now(), listActiveChildSessionIds: () => [] });
    for (const intent of cancelled.terminalIntents ?? []) {
      persistence.convergeRunTerminal({ ...intent, updatedAt: Date.now() });
    }
  } });
  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "h1-cancel-fence", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime }), (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_NOT_ACTIVE");
  assert.deepEqual(runtime.enqueueRunCalls, []);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment where id = ?").get(image.attachmentId) as { count: number }).count, 1);
  assert.equal((fixture.db.prepare("select status from agent_run order by created_at desc limit 1").get() as { status: string }).status, "cancelled");
  await assert.doesNotReject(() => fs.access(finalPath(fixture, workspace.id, image)));
});

test("M2 real SQLite: activation 后 state read 失败持久化失败 intent，随后可收敛为 failed/idle", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("M2 state read failure");
  const runId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId, createdAt });
  const persistence = new SqliteRunLifecyclePersistence(fixture.db);

  assert.equal(persistence.failRunAfterEnqueueFailureIfCurrent({ workspaceId: workspace.id, sessionId, runId, updatedAt: createdAt + 1 }), "intent-persisted");
  persistence.convergeRunTerminal({ workspaceId: workspace.id, sessionId, runId, updatedAt: createdAt + 1 });
  assert.equal(getRunRecord(fixture.db, runId)?.status, "failed");
  const state = getMessageRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state?.status, "idle");
  assert.equal(state?.activeRunId, null);
});

test("P1 real SQLite: enqueue failure settles its old Run but does not idle a newer active Run", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("P1 failure settlement");
  const olderRunId = newSortableId("run");
  const activeRunId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId: olderRunId, createdAt });
  const completedPersistence = new SqliteRunLifecyclePersistence(fixture.db);
  assert.equal(completedPersistence.persistRunTerminalIntent({
    workspaceId: workspace.id, sessionId, runId: olderRunId, status: "completed", code: "run_completed", detail: null, updatedAt: createdAt + 1,
  }), "updated");
  assert.equal(completedPersistence.convergeRunTerminal({ workspaceId: workspace.id, sessionId, runId: olderRunId, updatedAt: createdAt + 1 }).kind, "transitioned");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId: activeRunId, createdAt: createdAt + 2 });

  new SqliteRunLifecyclePersistence(fixture.db).failRunAfterEnqueueFailureIfCurrent({ workspaceId: workspace.id, sessionId, runId: olderRunId, updatedAt: createdAt + 3 });
  assert.equal(getRunRecord(fixture.db, olderRunId)?.status, "completed");
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
  const state = getMessageRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state?.status, "running");
  assert.equal(state?.activeRunId, activeRunId);
});

test("P1 real SQLite: cancel wins over a late enqueue-failure settlement", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("P1 cancel wins");
  const runId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId, createdAt });
  const persistence = new SqliteRunLifecyclePersistence(fixture.db);
  const cancelled = persistence.cancelSessions({ workspaceId: workspace.id, rootSessionId: sessionId, updatedAt: createdAt + 1, listActiveChildSessionIds: () => [] });
  assert.deepEqual(cancelled.runtimeCancelSessionIds, [sessionId]);
  for (const intent of cancelled.terminalIntents ?? []) {
    persistence.convergeRunTerminal({ ...intent, updatedAt: createdAt + 1 });
  }
  persistence.failRunAfterEnqueueFailureIfCurrent({ workspaceId: workspace.id, sessionId, runId, updatedAt: createdAt + 2 });
  assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "idle");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.activeRunId, null);
});

test("P1 real SQLite: recovery final fence observes cancellation and does not enqueue", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("P1 recovery fence");
  const runId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId, createdAt });
  const persistence = new SqliteRunLifecyclePersistence(fixture.db);
  const runtime = createFakeAgentRuntime();
  await createAgentService(fixture.ctx, fixture.app!.log).recoverRunsOnStartup({
    runtime,
    beforeFinalCheck(candidate) {
      assert.equal(candidate.runId, runId);
      const cancelled = persistence.cancelSessions({ workspaceId: workspace.id, rootSessionId: sessionId, updatedAt: createdAt + 1, listActiveChildSessionIds: () => [] });
      for (const intent of cancelled.terminalIntents ?? []) {
        persistence.convergeRunTerminal({ ...intent, updatedAt: createdAt + 1 });
      }
    },
  });
  assert.deepEqual(runtime.enqueueRunCalls, []);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "idle");
});

test("orphaned running real SQLite: failed worker settlement preserves unknown effects and releases session", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("orphaned tool settlement");
  const runId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId, createdAt });
  const assistantId = newSortableId("msg");
  const runningPartId = newSortableId("part");
  const queuedPartId = newSortableId("part");
  const runningId = newSortableId("exec");
  const queuedId = newSortableId("exec");
  const scope = { workspaceId: workspace.id, sessionId, runId };
  const head = getMessageSessionHead(fixture.db, scope)!;
  appendStreamingAssistant(fixture.db, {
    ...scope, id: assistantId, expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision, createdAt: createdAt + 1,
  });
  assert.equal(flushStreamingParts(fixture.db, {
    ...scope, messageId: assistantId, updatedAt: createdAt + 2, parts: [
      { id: runningPartId, position: 0, type: "tool_call", toolName: "apply_patch", input: {} },
      { id: queuedPartId, position: 1, type: "tool_call", toolName: "read", input: {} },
    ],
  }), "updated");
  assert.equal(completeAssistantWithExecutions(fixture.db, {
    ...scope, messageId: assistantId, updatedAt: createdAt + 3, executions: [
      { id: runningId, callPartId: runningPartId, originSessionId: sessionId, originRunId: runId, status: "queued" },
      { id: queuedId, callPartId: queuedPartId, originSessionId: sessionId, originRunId: runId, status: "queued" },
    ],
  }), "updated");
  assert.equal(updateToolExecution(fixture.db, {
    ...scope, executionId: runningId, status: "running", startedAt: createdAt + 4, updatedAt: createdAt + 4,
  }), "updated");
  const service = createAgentService(fixture.ctx, fixture.app!.log);
  assert.equal(service.persistRunTerminalIntentFromWorker({
    ...scope, status: "failed", code: "run_failed", detail: null, updatedAt: createdAt + 5,
  }).result, "updated");
  assert.equal(service.convergeRunTerminalFromWorker({ ...scope, updatedAt: createdAt + 6 }).kind, "transitioned");
  assert.equal(getRunRecord(fixture.db, runId)?.status, "failed");
  assert.equal(getRunRecord(fixture.db, runId)?.terminalResultCode, "run_failed");
  assert.equal(getToolExecution(fixture.db, runningId)?.status, "unknown");
  assert.equal(getToolExecution(fixture.db, queuedId)?.status, "cancelled");
  const state = getMessageRunState(fixture.db, workspace.id, sessionId);
  assert.equal(state?.status, "idle");
  assert.equal(state?.activeRunId, null);
});

test("P4 real SQLite: completing an old Run does not idle a newer active Run", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("P4 complete fence");
  const oldRunId = newSortableId("run");
  const activeRunId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId: oldRunId, createdAt });
  const completedPersistence = new SqliteRunLifecyclePersistence(fixture.db);
  assert.equal(completedPersistence.persistRunTerminalIntent({
    workspaceId: workspace.id, sessionId, runId: oldRunId, status: "completed", code: "run_completed", detail: null, updatedAt: createdAt + 1,
  }), "updated");
  assert.equal(completedPersistence.convergeRunTerminal({ workspaceId: workspace.id, sessionId, runId: oldRunId, updatedAt: createdAt + 1 }).kind, "transitioned");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId: activeRunId, createdAt: createdAt + 2 });

  createAgentService(fixture.ctx, fixture.app!.log).convergeRunTerminalFromWorker({ workspaceId: workspace.id, sessionId, runId: oldRunId, updatedAt: createdAt + 3 });
  assert.equal(getRunRecord(fixture.db, oldRunId)?.status, "completed");
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.activeRunId, activeRunId);
});
test("real SQLite/FS: overlapping prepared requests publish only the transaction winner", async () => {
  for (const sameRequestId of [true, false]) {
    const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("overlapping uploads");
    const first = await stageImage(fixture, "concurrent-a");
    const second = await stageImage(fixture, "concurrent-b");
    const base = createStorageCommitter(fixture);
    let preparations = 0;
    let release!: () => void;
    const bothPrepared = new Promise<void>((resolve) => { release = resolve; });
    const storage = {
      ...base,
      prepare: async (input: Parameters<typeof base.prepare>[0]) => {
        const publication = await base.prepare(input);
        if (++preparations === 2) release();
        await bothPrepared;
        return publication;
      },
    };
    const persistence = new SqliteRunLifecyclePersistence(fixture.db);
    const start = (image: typeof first, id: string) => createApplicationWithStorage({ fixture, persistence, attachmentCommitter: storage })
      .startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: id, text: "image", inputText: "image",
        images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() });
    const firstRun = start(first, "concurrent-request");
    const secondRun = start(second, sameRequestId ? "concurrent-request" : "other-request");
    const results = await Promise.allSettled([firstRun, secondRun]);
    assert.equal(preparations, 2);
    const winners = results.flatMap((result, index) => result.status === "fulfilled" && !result.value.deduplicated ? [index] : []);
    assert.equal(winners.length, 1);
    if (sameRequestId) {
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
      assert.equal((results.find((result) => result.status === "fulfilled" && result.value.deduplicated) as PromiseFulfilledResult<{ runId: string }>).value.runId,
        (results[winners[0]!] as PromiseFulfilledResult<{ runId: string }>).value.runId);
    } else {
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    }
    for (const [index, image] of [first, second].entries()) {
      if (index === winners[0]) await assert.doesNotReject(() => fs.access(finalPath(fixture, workspace.id, image)));
      else await assert.rejects(() => fs.access(finalPath(fixture, workspace.id, image)));
      await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, image.tempId)));
    }
    assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 1);
  }
});

test("real SQLite/FS: stale session title rejects before publishing final", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("stale title");
  const image = await stageImage(fixture, "title");
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });
  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "stale-title",
    text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
    uiLocale: null, expectedSessionTitle: "outdated", runtime: createFakeAgentRuntime() }));
  await assert.rejects(() => fs.access(finalPath(fixture, workspace.id, image)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, image.tempId)));
});

test("two SQLite connections: a rival cannot publish before the winner commits, then observes dedup/state", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("two connection publication");
  const winnerImage = await stageImage(fixture, "writer");
  const rivalImage = await stageImage(fixture, "rival");
  const prepare = (image: typeof winnerImage) => prepareAgentWorkspaceAttachmentPublication({
    dataDir: fixture.dataDir, workspaceDirName: workspace.dirName, attachmentId: image.attachmentId,
    storageKey: image.storageKey, mediaType: image.mediaType, tempId: image.tempId,
  });
  const winnerPublication = await prepare(winnerImage);
  const rivalPublication = await prepare(rivalImage);
  const rivalDb = new Database(dbPath(fixture.dataDir));
  // A real rival connection, not another persistence object sharing the API db handle.
  // Do not sleep on the same event loop while the winning transaction holds the lock.
  rivalDb.pragma("busy_timeout = 0");
  rivalDb.pragma("foreign_keys = ON");
  try {
    const winnerPersistence = new SqliteRunLifecyclePersistence(fixture.db);
    const rivalPersistence = new SqliteRunLifecyclePersistence(rivalDb);
    const request = (image: typeof winnerImage, clientRequestId: string): UserRunActivationInput => ({
      workspaceId: workspace.id, sessionId, clientRequestId, text: "describe", images: [image],
      runId: newSortableId("run"), agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
      uiLocale: null, createdAt: Date.now(),
    });
    const winnerInput = request(winnerImage, "same-request");
    const rivalInput = request(rivalImage, "same-request");
    const idleOnRival = rivalDb.prepare("select status from session_run_state where session_id = ?").get(sessionId) as { status: string };
    assert.equal(idleOnRival.status, "idle");
    let rivalPublishes = 0;
    const rivalPublish = () => { rivalPublishes++; rivalPublication.checkAvailable(); rivalPublication.publish(); };

    const winner = winnerPersistence.activateUserRun(winnerInput, () => {
      // If BEGIN were deferred, the rival could pass its read checks and reach
      // rivalPublish here before either transaction's first DB write.
      assert.throws(() => rivalPersistence.activateUserRun(rivalInput, rivalPublish),
        (error: unknown) => (error as { code?: string }).code === "SQLITE_BUSY");
      assert.equal(rivalPublishes, 0);
      winnerPublication.checkAvailable();
      winnerPublication.publish();
    });
    assert.equal(winner.kind, "activated");
    assert.equal(rivalPublishes, 0);
    assert.equal(rivalPersistence.activateUserRun(rivalInput, rivalPublish).kind, "deduplicated");
    assert.equal(rivalPersistence.activateUserRun(request(rivalImage, "different-request"), rivalPublish).kind, "session-running");
    assert.equal(rivalPublishes, 0);

    const pinned = await resolveSafeWorkspaceAgentAttachment({ dataDir: fixture.dataDir,
      workspaceDirName: workspace.dirName, attachmentId: winnerImage.attachmentId,
      storageKey: winnerImage.storageKey, mediaType: winnerImage.mediaType, expectedByteSize: winnerImage.byteSize });
    assert.ok(pinned);
    try {
      assert.deepEqual(await pinned.handle.readFile(), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      await pinned.handle.close();
    }
    await assert.rejects(() => fs.access(finalPath(fixture, workspace.id, rivalImage)));
    assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 1);
  } finally {
    rivalDb.close();
    await Promise.all([winnerPublication.close(), rivalPublication.close()]);
    await Promise.all([winnerImage, rivalImage].map(({ tempId }) => removeAgentAttachmentTempFile({ dataDir: fixture.dataDir, tempId })));
  }
});
