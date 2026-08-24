import { createAgentService } from "../agent.composition.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../../app/createApp.js";
import { openDb } from "../../../infra/db/db.js";
import { ensureDir, rmrf } from "../../../infra/fs/fs.js";
import { agentArchivePendingSidecarPath, agentArchiveSessionDir, workspaceRoot } from "../../../infra/fs/paths.js";
import { insertWorkspace } from "../../workspaces/workspace.store.js";
import {
  appendContextItem,
  createAgentSession,
  createRunRecord,
  getRunRecord,
  getRunState as getRunStateRow,
  getSessionTranscriptItems,
  updateRunState
} from "../agent.store.js";
import { SqliteRunLifecyclePersistence } from "../lifecycle/sqlite-run-lifecycle-persistence.js";
import type { AgentRuntimePort } from "../agent.runtime-port.js";
import { newSortableId } from "../../../utils/ids.js";
import { createAgentIntegrationFixture, createPrimarySession } from "../testkit/agent-integration-testkit.js";

async function createStartupFixture(t: TestContext) {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(async () => {
    await fixture.dispose();
  });
  return fixture;
}

test("agent startup recovery mode=fail 会终止 in-flight run 并回收 run-state", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-startup-fail-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  let app: FastifyInstance | null = null;
  try {
    const workspaceId = newSortableId("ws");
    const workspaceDirName = newSortableId("workspace");
    const workspacePath = workspaceRoot(dataDir, workspaceDirName);
    await ensureDir(workspacePath);

    const ts = Date.now();
    insertWorkspace(db, {
      id: workspaceId,
      dirName: workspaceDirName,
      title: "it-workspace",
      path: workspacePath,
      terminalCredentialId: null,
      createdAt: ts,
      updatedAt: ts
    });

  // 构造一个 in-flight run: run-state=running + run record=running + context items 含 streaming/tool。
  const sessionId = newSortableId("sess");
  createAgentSession(db, {
    id: sessionId,
    workspaceId,
    title: "startup-fail-session",
    kind: "primary",
    createdAt: ts,
    forkedFromSessionId: null,
    forkedFromItemId: null
  });
  const runId = newSortableId("run");

  const user = appendContextItem(db, {
    workspaceId,
    sessionId,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "hello" },
    createdAt: ts
  });
  const assistantItem = appendContextItem(db, {
    workspaceId,
    sessionId,
    runId,
    turnId: newSortableId("turn"),
    step: 1,
    prevId: user.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "" },
    createdAt: ts
  });
  const toolItem = appendContextItem(db, {
    workspaceId,
    sessionId,
    runId,
    turnId: null,
    step: null,
    prevId: assistantItem.id,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "bash", toolCallId: "call_1", args: { command: "echo hi" }, text: "" } as any,
    createdAt: ts
  });

  createRunRecord(db, {
    runId,
    workspaceId,
    sessionId,
    triggerItemId: user.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: null,
    parentToolItemId: null,
    status: "running",
    createdAt: ts
  });
  updateRunState(db, {
    workspaceId,
    sessionId,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.id,
    runNoticeText: "",
    updatedAt: ts,
    appliedItemId: toolItem.id
  });

  // 脏数据：in-flight 但 active_run_id 为空。
  const dirtySessionId = newSortableId("sess");
  createAgentSession(db, {
    id: dirtySessionId,
    workspaceId,
    title: "startup-fail-dirty-session",
    kind: "primary",
    createdAt: ts,
    forkedFromSessionId: null,
    forkedFromItemId: null
  });
  updateRunState(db, {
    workspaceId,
    sessionId: dirtySessionId,
    status: "running",
    activeRunId: null,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: ts,
    appliedItemId: 0
  });

  // 注意：fail 模式会在模块注册阶段执行清理逻辑，因此 in-flight 数据必须在 createApp 之前写入。
  app = await createApp({
    db,
    repoRoot,
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    logLevel: "error",
    serveWeb: false,
    webDistDir: null,
    credentialMasterKey: Buffer.alloc(32, 7),
    credentialMasterKeySource: "generated",
    credentialMasterKeyId: "testkey",
    credentialMasterKeyCreatedAt: Date.now(),
    authToken: null,
    authCookieSecure: false,
    agentWorkerEnabled: false,
    agentWorkerHost: "127.0.0.1",
    agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: 1,
    agentInternalToken: internalToken,
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "fail",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock")
  });

  await app.ready();

  // 断言：run record 由 running -> failed
  const run = getRunRecord(db, runId);
  assert.ok(run, "run record should exist");
  assert.equal(run?.status, "failed");

  // 断言：run-state 回收为 idle
  const state = getRunStateRow(db, workspaceId, sessionId);
  assert.equal(state.status, "idle");
  assert.equal(state.activeRunId, null);

  // 断言：streaming/queued 等未终态 items 被置为 failed
  const items = getSessionTranscriptItems(db, workspaceId, sessionId);
  assert.ok(items.some((it) => it.kind === "assistant" && it.status === "failed"));
  assert.ok(items.some((it) => it.kind === "tool" && it.status === "failed"));
  const startupFailNotice = items.find(
    (it) => it.kind === "system" && it.output.type === "system_text" && it.output.text === "[run] marked failed on server restart (startup recovery mode: fail)"
  );
  assert.ok(startupFailNotice, "startup fail notice should be appended");
  assert.equal(startupFailNotice?.boundaryReason, null);

  // 断言：脏 run-state 也会被回收
  const dirty = getRunStateRow(db, workspaceId, dirtySessionId);
  assert.equal(dirty.status, "idle");
  } finally {
    await app?.close();
    db.close();
    await rmrf(dataDir);
  }
});

test("agent startup 会 best-effort reconcile archive pending sidecar", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-startup-pending-it-"));
  const internalToken = "test-internal-token";
  const db = await openDb(dataDir);
  let app: FastifyInstance | null = null;
  try {
    const workspaceId = newSortableId("ws");
    const workspaceDirName = newSortableId("workspace");
    await ensureDir(workspaceRoot(dataDir, workspaceDirName));
    const now = Date.now();
    insertWorkspace(db, {
      id: workspaceId,
      dirName: workspaceDirName,
      title: "startup-pending-workspace",
      path: workspaceRoot(dataDir, workspaceDirName),
      terminalCredentialId: null,
      createdAt: now,
      updatedAt: now
    });
    const sessionId = newSortableId("sess");
    createAgentSession(db, {
      id: sessionId,
      workspaceId,
      title: "startup-pending-session",
      kind: "primary",
      createdAt: now,
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const archiveDir = agentArchiveSessionDir(dataDir, workspaceId, sessionId);
    const archivePath = path.join(archiveDir, "00000001.log");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(archivePath, "before\nafter\n", "utf-8");
    const beforeSize = Buffer.byteLength("before\n", "utf-8");
    const expectedSize = Buffer.byteLength("before\nafter\n", "utf-8");
    const sidecarPath = agentArchivePendingSidecarPath(dataDir, workspaceId, sessionId);
    await fs.writeFile(sidecarPath, JSON.stringify({
      version: 1,
      operation: "compaction",
      workspaceId,
      sessionId,
      createdAt: now,
      snapshots: [{ fileKey: path.join("agent", "archive", workspaceId, sessionId, "00000001.log"), beforeSize, expectedSize }]
    }), "utf-8");

    app = await createApp({
      db, repoRoot, dataDir, fileMaxBytes: 1024 * 1024, version: "test", logLevel: "error", serveWeb: false, webDistDir: null,
      credentialMasterKey: Buffer.alloc(32, 7), credentialMasterKeySource: "generated", credentialMasterKeyId: "testkey", credentialMasterKeyCreatedAt: now,
      authToken: null, authCookieSecure: false, agentWorkerEnabled: false, agentWorkerHost: "127.0.0.1", agentWorkerPort: 0,
      agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"), agentWorkerConcurrency: 0, agentInternalToken: internalToken,
      agentWorkerResponseValidation: "strict", agentApiOrigin: "http://127.0.0.1:0", agentStartupRecoveryMode: "recover",
      agentPluginHostEnabled: false, agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"), agentPluginServicesEnabled: false
    });
    await app.ready();
    assert.equal((await fs.stat(archivePath)).size, beforeSize);
    assert.equal(await fs.stat(sidecarPath).then(() => true, () => false), false);
  } finally {
    await app?.close();
    db.close();
    await rmrf(dataDir);
  }
});

test("recover 在 enqueue 前最终 DB check 中让 cancel wins", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const session = await createPrimarySession(fixture);
    const runId = newSortableId("run");
    const ts = Date.now();
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 0,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: null,
      parentRunId: null,
      parentToolItemId: null,
      status: "running",
      createdAt: ts
    });
    updateRunState(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      status: "running",
      activeRunId: runId,
      activeAssistantItemId: null,
      runNoticeText: "",
      updatedAt: ts,
      appliedItemId: 0
    });

    const service = createAgentService(fixture.ctx, fixture.app.log);
    const persistence = new SqliteRunLifecyclePersistence(fixture.db);
    const enqueueCalls: string[] = [];
    const runtime: AgentRuntimePort = {
      enqueueRun(run) {
        enqueueCalls.push(run.runId);
      },
      cancelSession() {}
    };
    let cancelledDuringRecovery = false;

    await service.recoverRunsOnStartup({ runtime,
      beforeFinalCheck(candidate) {
        assert.equal(candidate.runId, runId, "recovery scan should have found the in-flight candidate");
        const cancelled = persistence.cancelSessions({
          workspaceId: fixture.workspaceId,
          rootSessionId: session.id,
          updatedAt: ts + 1,
          listActiveChildSessionIds: () => []
        });
        assert.deepEqual(cancelled.runtimeCancelSessionIds, [session.id]);
        cancelledDuringRecovery = true;
      }
    });

    assert.equal(cancelledDuringRecovery, true);
    assert.deepEqual(enqueueCalls, []);
    assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
    const state = getRunStateRow(fixture.db, fixture.workspaceId, session.id);
    assert.equal(state.status, "idle");
    assert.equal(state.activeRunId, null);
  } finally {
    await fixture.dispose();
  }
});

test("recover enqueue 已发出后 cancel 仍以 DB cancelled 状态为准", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const session = await createPrimarySession(fixture);
    const runId = newSortableId("run");
    const ts = Date.now();
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 0,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: null,
      parentRunId: null,
      parentToolItemId: null,
      status: "running",
      createdAt: ts
    });
    updateRunState(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      status: "running",
      activeRunId: runId,
      activeAssistantItemId: null,
      runNoticeText: "",
      updatedAt: ts,
      appliedItemId: 0
    });

    const enqueued: string[] = [];
    const runtime: AgentRuntimePort = {
      enqueueRun(run) {
        enqueued.push(run.runId);
      },
      cancelSession() {}
    };
    const service = createAgentService(fixture.ctx, fixture.app.log);
    const persistence = new SqliteRunLifecyclePersistence(fixture.db);
    await service.recoverRunsOnStartup({ runtime });
    assert.deepEqual(enqueued, [runId]);

    const cancelled = persistence.cancelSessions({
      workspaceId: fixture.workspaceId,
      rootSessionId: session.id,
      updatedAt: ts + 1,
      listActiveChildSessionIds: () => []
    });
    assert.deepEqual(cancelled.runtimeCancelSessionIds, [session.id]);
    assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
    const state = getRunStateRow(fixture.db, fixture.workspaceId, session.id);
    assert.equal(state.status, "idle");
    assert.equal(state.activeRunId, null);
  } finally {
    await fixture.dispose();
  }
});

test("recover enqueue failure 只记录并继续处理后续 candidate", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const firstSession = await createPrimarySession(fixture);
    const secondSession = await createPrimarySession(fixture);
    const ts = Date.now();
    const firstRunId = newSortableId("run");
    const secondRunId = newSortableId("run");
    for (const [sessionId, runId] of [[firstSession.id, firstRunId], [secondSession.id, secondRunId]] as const) {
      createRunRecord(fixture.db, {
        runId,
        workspaceId: fixture.workspaceId,
        sessionId,
        triggerItemId: 0,
        agentId: "default",
        providerId: "ppchat",
        modelId: "gpt-5.2",
        subtaskDepth: null,
        parentRunId: null,
        parentToolItemId: null,
        status: "running",
        createdAt: ts
      });
      updateRunState(fixture.db, {
        workspaceId: fixture.workspaceId,
        sessionId,
        status: "running",
        activeRunId: runId,
        activeAssistantItemId: null,
        runNoticeText: "",
        updatedAt: ts,
        appliedItemId: 0
      });
    }

    const enqueued: string[] = [];
    const runtime: AgentRuntimePort = {
      async enqueueRun(run) {
        enqueued.push(run.runId);
        if (run.runId === firstRunId) throw new Error("expected enqueue failure");
      },
      cancelSession() {}
    };
    const warnings: unknown[][] = [];
    const logger = {
      warn(...args: unknown[]) {
        warnings.push(args);
      }
    } as unknown as FastifyInstance["log"];

    await createAgentService(fixture.ctx, logger).recoverRunsOnStartup({ runtime });

    assert.deepEqual(enqueued, [firstRunId, secondRunId]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[1], "startup recovery mode=recover: enqueue run failed");
  } finally {
    await fixture.dispose();
  }
});

test("runtime cancel 失败仅 warning，DB cancel 保持收敛", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const session = await createPrimarySession(fixture);
    const runId = newSortableId("run");
    const ts = Date.now();
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 0,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: null,
      parentRunId: null,
      parentToolItemId: null,
      status: "running",
      createdAt: ts
    });
    updateRunState(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      status: "running",
      activeRunId: runId,
      activeAssistantItemId: null,
      runNoticeText: "",
      updatedAt: ts,
      appliedItemId: 0
    });

    const warnings: unknown[][] = [];
    const service = createAgentService(fixture.ctx, {
      ...fixture.app.log,
      warn(...args: unknown[]) {
        warnings.push(args);
      }
    } as never);
    const result = await service.cancelSessionWithRuntime({
      sessionId: session.id,
      workspaceId: fixture.workspaceId,
      runtime: {
        enqueueRun() {},
        async cancelSession() {
          throw new Error("expected runtime cancellation failure");
        }
      }
    });
    assert.equal(result.runState.status, "idle");
    assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[1], "agent cancel runtime session failed");
    assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
    assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, session.id).status, "idle");
  } finally {
    await fixture.dispose();
  }
});
