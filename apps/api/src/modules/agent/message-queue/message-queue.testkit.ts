import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import type { AgentQueueIdentity } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { initSchema } from "../../../infra/db/schema.js";
import { createMessageSession, getMessageRunState, persistRunTerminalIntent, convergeRunTerminal } from "../agent-message.store.js";
import { AgentAttachmentPublicationService } from "../attachments/agent-attachment-publication.service.js";
import { stageAgentImageUpload } from "../attachments/agent-attachment-storage.js";
import { RunLifecycleApplication } from "../lifecycle/run-lifecycle-application.js";
import type { AgentRuntimeRun } from "../lifecycle/run-lifecycle-ports.js";
import { SessionRuntimeHandoffCoordinator } from "../lifecycle/session-runtime-handoff-coordinator.js";
import { SqliteRunLifecyclePersistence } from "../lifecycle/sqlite-run-lifecycle-persistence.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { AgentRuntimeControlService } from "../runtime-control/runtime-control.service.js";
import { AgentRuntimeControlStore } from "../runtime-control/runtime-control.store.js";
import { AgentMessageQueueService, type QueueProfileResolver } from "./message-queue.service.js";
import { AgentMessageQueueStore } from "./message-queue.store.js";

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const scope = { workspaceId: "w1", sessionId: "s1" };
export const identity: AgentQueueIdentity = { agentId: "a", providerId: "p", modelId: "m" };
export const errorIs = (status: number, code?: string) => (error: unknown) => error instanceof HttpError && error.statusCode === status && (!code || error.code === code);

export async function queueFixture(t: TestContext, runtimeKind: "worker" | "local_fallback" = "worker") {
  const root = path.resolve(import.meta.dirname, "../../../../../../.tmp-tests");
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, "s4-queue-"));
  const dbPath = path.join(dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("foreign_keys=ON"); initSchema(db); db.pragma("journal_mode=WAL");
  const workspacePath = path.join(dataDir, "workspaces", "w1");
  await fs.mkdir(workspacePath, { recursive: true });
  db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('w1','w1','Test',?,1,1)").run(workspacePath);
  createMessageSession(db, { id: "s1", workspaceId: "w1", kind: "primary", title: "Test", createdAt: 1 });
  const store = new AgentMessageQueueStore(db);
  const persistence = new SqliteRunLifecyclePersistence(db);
  const lifecycle = new RunLifecycleApplication({
    persistence,
    workspaceRunContextReader: { get: () => ({ workspacePath, workspaceRepoDirNames: [] }) },
    runStateReader: { get: sessionId => { const state = getMessageRunState(db, "w1", sessionId); assert.ok(state); return state; } },
    activeSubtaskChildQuery: { listByParentRun: () => [] },
    promptStaticCacheInvalidator: { clear: () => undefined },
    runCompletedEventPublisher: { publishRunCompleted: () => undefined },
    triggerInputReader: { getUserText: () => null }, isContextAppendConflict: () => false,
    runtimeHandoffCoordinator: new SessionRuntimeHandoffCoordinator(), clock: { nowMs: Date.now },
    ids: { newId: prefix => `${prefix}-${randomUUID()}` }, logger: { warn: () => undefined, error: () => undefined },
  });
  const runtimeStore = new AgentRuntimeControlStore(db);
  const runtimeInstanceId = randomUUID(); const ownerApiInstanceId = randomUUID();
  runtimeStore.createInstance({ runtimeInstanceId, ownerApiInstanceId, runtimeKind });
  runtimeStore.readyInstance(runtimeInstanceId, runtimeKind === "worker"
    ? { pid: process.pid, spawnNonce: randomUUID(), spawnObservedAt: 1 }
    : { pid: process.pid, ownerApiInstanceId });
  const enqueued: AgentRuntimeRun[] = [];
  const stopCalls: string[] = [];
  let enqueueError: unknown;
  const runtime = new AgentRuntimeControlService(runtimeStore, {
    enqueueRun: run => { enqueued.push(run); if (enqueueError) throw enqueueError; },
    cancelSession: () => undefined,
    stopRunsAndWait: async input => {
      stopCalls.push(input.operationId);
      return { workspaceId: input.workspaceId, rootSessionId: input.rootSessionId, operationId: input.operationId, runtimeInstanceId: input.runtimeInstanceId, targetsHash: input.targetsHash, state: "pending", proofId: null, code: "runner_not_quiescent" };
    },
  });
  runtime.ready(runtimeInstanceId);
  let profileError: unknown;
  let defaultIdentity = identity;
  const resolveProfile: QueueProfileResolver = input => {
    if (profileError) throw profileError;
    return input.fixedIdentity ?? { ...defaultIdentity, agentId: input.requestedAgentId ?? defaultIdentity.agentId };
  };
  const publications = new AgentAttachmentPublicationService({ db, dataDir });
  const service = new AgentMessageQueueService(store, { dataDir, publications, runtimeControl: runtime, resolveProfile,
    activateOrdinarySend: input => ({ ...lifecycle.activateAcceptedUserRun(input), inputText: store.get(input, input.receiptId).input_text! }),
    handoffContinuation: run => lifecycle.handoffQueuedContinuation({ ...run, runtime }),
    resumeSession: request => lifecycle.resumeQueuedSession({ ...request, runtime }) });
  const currentRun = async () => {
    const state = getMessageRunState(db, scope.workspaceId, scope.sessionId);
    if (state?.status !== "running" || !state.activeRunId) return null;
    const row = db.prepare("select trigger_message_id as messageId from agent_run where run_id=?").get(state.activeRunId) as { messageId: string };
    return { ...scope, runId: state.activeRunId, messageId: row.messageId };
  };
  const upload = (filename = "image.png", bytes = PNG) => stageAgentImageUpload({ dataDir, attachmentId: `att_${randomUUID()}`, tempId: `tmp_${randomUUID()}`,
    filename, stream: Readable.from([bytes]), onBytes: () => undefined });
  const accept = (clientRequestId: string, text = "hello") => {
    const state = getMessageRunState(db, scope.workspaceId, scope.sessionId);
    return service.accept("s1", { workspaceId: "w1", clientRequestId, text, targetRunId: state?.status === "running" ? state.activeRunId : null });
  };
  const finish = (runId: string, status: "completed" | "failed" | "cancelled" = "completed") => {
    const runScope = { ...scope, runId };
    persistRunTerminalIntent(db, { ...runScope, status, code: status === "completed" ? "run_completed" : status === "failed" ? "run_failed" : "run_cancelled", detail: null, updatedAt: Date.now() });
    return convergeRunTerminal(db, { ...runScope, updatedAt: Date.now() });
  };
  t.after(async () => {
    service.closeAdmission(); await service.close(); await runtime.close(); lifecycle.dispose();
    workspaceDeletingFence.end("w1"); db.close(); await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { db, dbPath, dataDir, workspacePath, store, persistence, lifecycle, runtime, runtimeStore, runtimeInstanceId, publications, service, currentRun,
    resolveProfile, enqueued, stopCalls, accept, upload, finish,
    setEnqueueError: (error: unknown) => { enqueueError = error; }, setProfileError: (error: unknown) => { profileError = error; },
    setDefaultIdentity: (value: AgentQueueIdentity) => { defaultIdentity = value; } };
}
