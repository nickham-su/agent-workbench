import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { AppContext } from "../../app/context.js";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { insertWorkspace, getWorkspace } from "./workspace.store.js";
import { upsertWorkspaceDeletionIntent } from "./workspace-deletion.store.js";
import { newSortableId } from "../../utils/ids.js";
import {
  appendMessage,
  createMessageRunRecord,
  createMessageSession,
  getRunRecord,
  getMessageSession,
  startMessageRun,
} from "../agent/agent-message.store.js";
import { createAgentService } from "../agent/agent.composition.js";
import { recoverAfterAgentRuntimeReady } from "../agent/agent-runtime-ready.js";
import { resumePendingWorkspaceDeletions } from "./workspace.service.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import { registerWorkspaceRuntime, unregisterWorkspaceRuntime } from "../agent/lifecycle/workspace-runtime-registry.js";
import { SessionRuntimeHandoffCoordinator } from "../agent/lifecycle/session-runtime-handoff-coordinator.js";
import { registerWorkspacesModule } from "./workspaces.module.js";

function context(dataDir: string, db: Awaited<ReturnType<typeof openDb>>): AppContext {
  return {
    db, repoRoot: process.cwd(), dataDir, fileMaxBytes: 1024 * 1024, version: "test", logLevel: "error", serveWeb: false, webDistDir: null,
    preview: { enabled: false, runtime: null }, credentialMasterKey: Buffer.alloc(32, 3), credentialMasterKeySource: "generated", credentialMasterKeyId: "test", credentialMasterKeyCreatedAt: Date.now(),
    authToken: null, authCookieSecure: false, agentWorkerEnabled: false, agentWorkerHost: "127.0.0.1", agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(dataDir, "worker.sock"), agentWorkerConcurrency: 1, agentInternalToken: "test", agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0", agentPluginHostEnabled: false, agentPluginHostSocketPath: path.join(dataDir, "plugin.sock"), agentPluginServicesEnabled: false,
  };
}

function createRecoverableRun(params: {
  db: Awaited<ReturnType<typeof openDb>>;
  workspaceId: string;
  sessionId: string;
  runId: string;
  now: number;
}) {
  createMessageSession(params.db, {
    id: params.sessionId, workspaceId: params.workspaceId, title: "restart recovery", kind: "primary", createdAt: params.now,
  });
  const triggerMessageId = newSortableId("msg");
  const head = getMessageSession(params.db, params.workspaceId, params.sessionId);
  assert.ok(head);
  appendMessage(params.db, {
    id: triggerMessageId, workspaceId: params.workspaceId, sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "restart recovery" }], createdAt: params.now,
  });
  createMessageRunRecord(params.db, {
    runId: params.runId, workspaceId: params.workspaceId, sessionId: params.sessionId, triggerMessageId,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", subtaskDepth: null,
    parentRunId: null, parentToolExecutionId: null, status: "running", createdAt: params.now,
  });
  startMessageRun(params.db, {
    workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId, updatedAt: params.now,
  });
}

test("两次 API 生命周期以真实 SQLite hydrate tombstone，并在 runtime ready 后续作删除", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-workspace-restart-test-"));
  const deletingId = "ws_restart_deleting";
  const survivingId = "ws_restart_surviving";
  let firstDb: Awaited<ReturnType<typeof openDb>> | null = null;
  let secondDb: Awaited<ReturnType<typeof openDb>> | null = null;
  let firstApp: Awaited<ReturnType<typeof createApp>> | null = null;
  let secondApp: Awaited<ReturnType<typeof createApp>> | null = null;
  try {
    // 第一个 API 生命周期正常启动；intent 在运行期写入，模拟删除在进程退出前中断。
    firstDb = await openDb(dataDir);
    firstApp = await createApp(context(dataDir, firstDb));
    await firstApp.ready();
    const now = Date.now();
    const deletingDirName = "workspace_restart_deleting";
    const survivingDirName = "workspace_restart_surviving";
    const deletingPath = workspaceRoot(dataDir, deletingDirName);
    const survivingPath = workspaceRoot(dataDir, survivingDirName);
    await Promise.all([fs.mkdir(deletingPath, { recursive: true }), fs.mkdir(survivingPath, { recursive: true })]);
    insertWorkspace(firstDb, { id: deletingId, dirName: deletingDirName, title: "delete", path: deletingPath, terminalCredentialId: null, createdAt: now, updatedAt: now });
    insertWorkspace(firstDb, { id: survivingId, dirName: survivingDirName, title: "keep", path: survivingPath, terminalCredentialId: null, createdAt: now, updatedAt: now });
    upsertWorkspaceDeletionIntent(firstDb, { workspaceId: deletingId, dirName: deletingDirName, now });
    await firstApp.close();
    firstApp = null;
    firstDb.close();
    firstDb = null;
    workspaceDeletingFence.end(deletingId);

    // 第二个 API 生命周期注册 Workspace 模块时先 hydrate fence，local runtime ready 后安全续作。
    secondDb = await openDb(dataDir);
    secondApp = await createApp(context(dataDir, secondDb));
    await secondApp.ready();
    assert.equal(getWorkspace(secondDb, deletingId), null);
    assert.equal(secondDb.prepare("select workspace_id from workspace_deletion where workspace_id = ?").get(deletingId), undefined);
    assert.equal(workspaceDeletingFence.isDeleting(deletingId), false);
    assert.ok(getWorkspace(secondDb, survivingId), "另一 Workspace 必须保持可用");
    assert.equal(await fs.stat(survivingPath).then(() => true), true);
  } finally {
    await secondApp?.close().catch(() => undefined);
    await firstApp?.close().catch(() => undefined);
    secondDb?.close();
    firstDb?.close();
    workspaceDeletingFence.end(deletingId);
    workspaceDeletingFence.end(survivingId);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("两次 API 生命周期 hydrate deletion fence 后，ready 删除目标 Run 并恢复其他 Workspace", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-workspace-restart-recovery-test-"));
  const deletingId = "ws_restart_recovery_deleting";
  const healthyId = "ws_restart_recovery_healthy";
  let firstDb: Awaited<ReturnType<typeof openDb>> | null = null;
  let secondDb: Awaited<ReturnType<typeof openDb>> | null = null;
  let firstApp: Awaited<ReturnType<typeof createApp>> | null = null;
  let secondApp: Awaited<ReturnType<typeof createApp>> | null = null;
  let registration: { runtime: Pick<AgentRuntimePort, "cancelSessionAndWait">; handoffCoordinator: SessionRuntimeHandoffCoordinator; settleWorkspaceRunsForDeletion(workspaceId: string): string[] } | null = null;
  try {
    firstDb = await openDb(dataDir);
    firstApp = await createApp(context(dataDir, firstDb));
    await firstApp.ready();
    const now = Date.now();
    const deletingPath = workspaceRoot(dataDir, "workspace_restart_recovery_deleting");
    const healthyPath = workspaceRoot(dataDir, "workspace_restart_recovery_healthy");
    await Promise.all([fs.mkdir(deletingPath, { recursive: true }), fs.mkdir(healthyPath, { recursive: true })]);
    insertWorkspace(firstDb, {
      id: deletingId, dirName: "workspace_restart_recovery_deleting", title: "delete", path: deletingPath,
      terminalCredentialId: null, createdAt: now, updatedAt: now,
    });
    insertWorkspace(firstDb, {
      id: healthyId, dirName: "workspace_restart_recovery_healthy", title: "keep", path: healthyPath,
      terminalCredentialId: null, createdAt: now, updatedAt: now,
    });
    const deletingRunId = newSortableId("run");
    const healthyRunId = newSortableId("run");
    createRecoverableRun({ db: firstDb, workspaceId: deletingId, sessionId: newSortableId("sess"), runId: deletingRunId, now });
    createRecoverableRun({ db: firstDb, workspaceId: healthyId, sessionId: newSortableId("sess"), runId: healthyRunId, now });
    upsertWorkspaceDeletionIntent(firstDb, { workspaceId: deletingId, dirName: "workspace_restart_recovery_deleting", now });
    await firstApp.close();
    firstApp = null;
    firstDb.close();
    firstDb = null;
    workspaceDeletingFence.end(deletingId);

    // 只注册 Workspaces module：此处真实执行 durable-fence hydrate，但不启动
    // local runtime，下面的显式 ready 编排等价于 Managed Worker ready barrier。
    secondDb = await openDb(dataDir);
    const secondContext = context(dataDir, secondDb);
    secondApp = Fastify({ logger: false });
    await registerWorkspacesModule(secondApp, secondContext);
    await secondApp.ready();
    const enqueued: string[] = [];
    const runtime: AgentRuntimePort = {
      enqueueRun: (run) => { enqueued.push(run.runId); },
      cancelSession: () => undefined,
      cancelSessionAndWait: async () => true,
    };
    registration = { runtime, handoffCoordinator: new SessionRuntimeHandoffCoordinator(), settleWorkspaceRunsForDeletion: () => [] };
    registerWorkspaceRuntime(registration);
    assert.equal(workspaceDeletingFence.isDeleting(deletingId), true, "Workspaces module must hydrate durable deletion fence before ready");
    await recoverAfterAgentRuntimeReady({
      runtime,
      generation: 1,
      resumeWorkspaceDeletions: () => resumePendingWorkspaceDeletions(secondContext, secondApp!.log),
      recoverRuns: ({ runtime: readyRuntime }) => createAgentService(secondContext, secondApp!.log).recoverRunsOnStartup({ runtime: readyRuntime }),
      reconcileTerminals: async () => undefined,
      logger: secondApp.log,
    });
    assert.equal(getWorkspace(secondDb, deletingId), null);
    assert.equal(getRunRecord(secondDb, deletingRunId), null, "deleting Workspace Run must converge through deletion, never recover");
    assert.deepEqual(enqueued, [], "startup recovery must not re-enqueue business work");
    const healthyRun = getRunRecord(secondDb, healthyRunId);
    assert.equal(healthyRun?.status, "failed");
    assert.equal(healthyRun?.terminalResultCode, "run_startup_recovery_failed");
    assert.ok(getWorkspace(secondDb, healthyId));
  } finally {
    if (registration) unregisterWorkspaceRuntime(registration);
    await secondApp?.close().catch(() => undefined);
    await firstApp?.close().catch(() => undefined);
    secondDb?.close();
    firstDb?.close();
    workspaceDeletingFence.end(deletingId);
    workspaceDeletingFence.end(healthyId);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
