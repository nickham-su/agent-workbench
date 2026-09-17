import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import { newSortableId } from "../../utils/ids.js";
import { createAgentService } from "./agent.composition.js";
import { agentAttachmentFilePath, agentAttachmentTempFilePath } from "./attachments/agent-attachment-paths.js";
import {
  AgentAttachmentCommitError,
  commitAgentAttachmentTempFile,
  createAgentAttachmentTempFile,
  removeAgentAttachmentTempFile,
} from "./attachments/agent-attachment-storage.js";
import { RunLifecycleApplication } from "./lifecycle/run-lifecycle-application.js";
import type { RunLifecycleApplicationDependencies } from "./lifecycle/run-lifecycle-ports.js";
import {
  appendMessage,
  createMessageSession,
  getMessageRunState,
  getMessageSessionHead,
  startMessageRun,
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
  await handle.writeFile(Uint8Array.from([1, 2, 3]));
  await handle.close();
  return { attachmentId, storageKey: attachmentId, tempId, filename: "image.png", mediaType: "image/png" as const, byteSize: 3, position: 0 };
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
    attachmentCommitter: params.attachmentCommitter ?? {
      commit: async ({ workspaceId, image }) => { await commitAgentAttachmentTempFile({ dataDir: params.fixture.dataDir, workspaceId, attachmentId: image.attachmentId, tempId: image.tempId }); },
      removeTemp: async ({ tempId }) => { await removeAgentAttachmentTempFile({ dataDir: params.fixture.dataDir, tempId }); },
      removeFinal: async ({ workspaceId, image }) => { await fs.rm(agentAttachmentFilePath(params.fixture.dataDir, workspaceId, image.attachmentId), { force: true }); },
    },
    triggerInputReader: { getUserText: () => null },
    isContextAppendConflict: () => false,
    runtimeHandoffCoordinator: params.coordinator ?? new SessionRuntimeHandoffCoordinator(),
    clock: { nowMs: () => Date.now() },
    ids: { newId: newSortableId },
    logger: { warn: () => undefined, error: () => undefined },
  };
  return new RunLifecycleApplication(dependencies);
}

test("H1 real SQLite/FS: DB activation failure deletes this request final without creating Message graph", async () => {
  const fixture = await createAgentTestFixture({ agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, { title: "H1 database failure" });
  const image = await stageImage(fixture, "db_failure");
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });
  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId: "sess_missing", clientRequestId: "h1-db-failure", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() }));
  await assert.rejects(() => fs.access(agentAttachmentFilePath(fixture.dataDir, workspace.id, image.attachmentId)));
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 0);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message").get() as { count: number }).count, 0);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_run").get() as { count: number }).count, 0);
});

test("M6 real SQLite/FS: second attachment EEXIST removes only the request-owned first final", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("M6 EEXIST");
  const first = await stageImage(fixture, "first");
  const second = await stageImage(fixture, "second");
  const existingFinal = agentAttachmentFilePath(fixture.dataDir, workspace.id, second.attachmentId);
  await fs.mkdir((await import("node:path")).dirname(existingFinal), { recursive: true });
  await fs.writeFile(existingFinal, "existing");
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });

  await assert.rejects(
    () => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "m6-eexist", text: "two", inputText: "two", images: [first, { ...second, position: 1 }], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() }),
    (error: unknown) => error instanceof AgentAttachmentCommitError && !error.finalCreated && (error.cause as NodeJS.ErrnoException).code === "EEXIST",
  );
  await assert.rejects(() => fs.access(agentAttachmentFilePath(fixture.dataDir, workspace.id, first.attachmentId)));
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
  const attachmentCommitter: NonNullable<RunLifecycleApplicationDependencies["attachmentCommitter"]> = {
    commit: async ({ workspaceId, image: current }) => { await commitAgentAttachmentTempFile({
      dataDir: fixture.dataDir, workspaceId, attachmentId: current.attachmentId, tempId: current.tempId,
    }); },
    removeTemp: async ({ tempId }) => await removeAgentAttachmentTempFile({ dataDir: fixture.dataDir, tempId }),
    removeFinal: async ({ workspaceId, image: current }) => await fs.rm(agentAttachmentFilePath(fixture.dataDir, workspaceId, current.attachmentId), { force: true }),
  };
  const application = createApplicationWithStorage({ fixture, persistence, attachmentCommitter });
  await application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "m6-unlink", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() });
  await assert.doesNotReject(() => fs.access(agentAttachmentFilePath(fixture.dataDir, workspace.id, image.attachmentId)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(fixture.dataDir, image.tempId)));
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 1);
});

test("M6 real SQLite/FS: SQLite trigger abort after attachment insert rolls back graph and removes final", async () => {
  const { fixture, workspace, sessionId } = await createMessageLifecycleFixture("M6 trigger");
  const image = await stageImage(fixture, "trigger");
  fixture.db.exec(`create trigger test_m6_abort before insert on agent_message begin select raise(abort, 'm6'); end`);
  const application = createApplicationWithStorage({ fixture, persistence: new SqliteRunLifecyclePersistence(fixture.db) });

  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "m6-trigger", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime: createFakeAgentRuntime() }));
  await assert.rejects(() => fs.access(agentAttachmentFilePath(fixture.dataDir, workspace.id, image.attachmentId)));
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
    persistence.cancelSessions({ workspaceId: workspace.id, rootSessionId: sessionId, updatedAt: Date.now(), listActiveChildSessionIds: () => [] });
  } });
  await assert.rejects(() => application.startUserRun({ workspaceId: workspace.id, sessionId, clientRequestId: "h1-cancel-fence", text: "image", inputText: "image", images: [image], agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", uiLocale: null, runtime }), (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_NOT_ACTIVE");
  assert.deepEqual(runtime.enqueueRunCalls, []);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment where id = ?").get(image.attachmentId) as { count: number }).count, 1);
  assert.equal((fixture.db.prepare("select status from agent_run order by created_at desc limit 1").get() as { status: string }).status, "cancelled");
  await assert.doesNotReject(() => fs.access(agentAttachmentFilePath(fixture.dataDir, workspace.id, image.attachmentId)));
});

test("M2 real SQLite: activation 后 state read 失败可 fenced 收敛为 failed/idle", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("M2 state read failure");
  const runId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId, createdAt });
  const persistence = new SqliteRunLifecyclePersistence(fixture.db);

  assert.equal(persistence.failRunAfterEnqueueFailureIfCurrent({ workspaceId: workspace.id, sessionId, runId, updatedAt: createdAt + 1 }), "failed-and-idled");
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
  assert.equal(new SqliteRunLifecyclePersistence(fixture.db).completeRunFromWorker({
    workspaceId: workspace.id, sessionId, runId: olderRunId, status: "completed", updatedAt: createdAt + 1,
  }), true);
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
  assert.deepEqual(persistence.cancelSessions({ workspaceId: workspace.id, rootSessionId: sessionId, updatedAt: createdAt + 1, listActiveChildSessionIds: () => [] }).runtimeCancelSessionIds, [sessionId]);
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
      persistence.cancelSessions({ workspaceId: workspace.id, rootSessionId: sessionId, updatedAt: createdAt + 1, listActiveChildSessionIds: () => [] });
    },
  });
  assert.deepEqual(runtime.enqueueRunCalls, []);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "idle");
});

test("P4 real SQLite: completing an old Run does not idle a newer active Run", async () => {
  const { fixture, workspace, sessionId, createdAt } = await createMessageLifecycleFixture("P4 complete fence");
  const oldRunId = newSortableId("run");
  const activeRunId = newSortableId("run");
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId: oldRunId, createdAt });
  assert.equal(new SqliteRunLifecyclePersistence(fixture.db).completeRunFromWorker({
    workspaceId: workspace.id, sessionId, runId: oldRunId, status: "completed", updatedAt: createdAt + 1,
  }), true);
  createAndActivateRun({ fixture, workspaceId: workspace.id, sessionId, runId: activeRunId, createdAt: createdAt + 2 });

  createAgentService(fixture.ctx, fixture.app!.log).completeRunFromWorker({ workspaceId: workspace.id, sessionId, runId: oldRunId, status: "completed", updatedAt: createdAt + 3 });
  assert.equal(getRunRecord(fixture.db, oldRunId)?.status, "completed");
  assert.equal(getRunRecord(fixture.db, activeRunId)?.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.status, "running");
  assert.equal(getMessageRunState(fixture.db, workspace.id, sessionId)?.activeRunId, activeRunId);
});
