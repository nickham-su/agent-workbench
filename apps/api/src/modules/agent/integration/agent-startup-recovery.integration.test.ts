import { createAgentService } from "../agent.composition.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../../app/createApp.js";
import { openDb } from "../../../infra/db/db.js";
import { ensureDir, rmrf } from "../../../infra/fs/fs.js";
import { workspaceRoot } from "../../../infra/fs/paths.js";
import { insertWorkspace, getWorkspace } from "../../workspaces/workspace.store.js";
import { upsertWorkspaceDeletionIntent } from "../../workspaces/workspace-deletion.store.js";
import { resumePendingWorkspaceDeletions } from "../../workspaces/workspace.service.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { recoverAfterAgentRuntimeReady } from "../agent-runtime-ready.js";
import {
  createMessageRunRecord,
  getRunRecord
} from "../agent-message.store.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  createMessageSession,
  getMessage,
  flushStreamingParts,
  getMessageRunState,
  getMessageSession,
  getToolExecution,
  startMessageRun,
  cancelRunAndConverge
} from "../agent-message.store.js";
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

function createRunningMessageRun(
  fixture: Awaited<ReturnType<typeof createStartupFixture>>,
  sessionId: string,
  runId: string,
  createdAt: number,
  workspaceId = fixture.workspaceId,
) {
  const head = getMessageSession(fixture.db, workspaceId, sessionId);
  assert.ok(head, "recovery fixture session must exist");
  const triggerMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: triggerMessageId, workspaceId, sessionId,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "recovery trigger" }], createdAt
  });
  createMessageRunRecord(fixture.db, {
    runId, workspaceId, sessionId, triggerMessageId,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
    subtaskDepth: null, parentRunId: null, parentToolExecutionId: null, status: "running", createdAt
  });
  startMessageRun(fixture.db, { workspaceId, sessionId, runId, updatedAt: createdAt });
}

test("agent startup pre-listen 保持 in-flight run，fenced recovery 在 onListen 执行", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-startup-recovery-it-"));
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

  // 构造一个 in-flight run：真实 trigger Message + streaming assistant + ToolCall Part + queued execution。
  const sessionId = newSortableId("sess");
  createMessageSession(db, { id: sessionId, workspaceId, title: "startup-recovery-session", kind: "primary", createdAt: ts });
  const runId = newSortableId("run");
  const triggerMessageId = newSortableId("msg");
  appendMessage(db, {
    id: triggerMessageId, workspaceId, sessionId, expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "hello" }], createdAt: ts
  });
  createMessageRunRecord(db, {
    runId, workspaceId, sessionId, triggerMessageId, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
    subtaskDepth: null, parentRunId: null, parentToolExecutionId: null, status: "running", createdAt: ts
  });
  startMessageRun(db, { workspaceId, sessionId, runId, updatedAt: ts });
  const head = getMessageSession(db, workspaceId, sessionId);
  assert.ok(head);
  const assistantMessageId = newSortableId("msg");
  appendStreamingAssistant(db, {
    id: assistantMessageId, workspaceId, sessionId, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    runId, createdAt: ts + 1
  });
  const callPartId = newSortableId("part");
  const toolExecutionId = newSortableId("exec");
  assert.equal(flushStreamingParts(db, {
    workspaceId, sessionId, runId, messageId: assistantMessageId,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "bash", input: { command: "echo hi" }, providerToolCallId: "call_1" }],
    updatedAt: ts + 2
  }), "updated");
  // complete creates the queued execution while the assistant remains nonterminal only when executions are absent;
  // retain a separate streaming assistant and create queued execution from a completed tool-call assistant.
  assert.equal(completeAssistantWithExecutions(db, {
    workspaceId, sessionId, runId, messageId: assistantMessageId,
    executions: [{ id: toolExecutionId, callPartId, originSessionId: sessionId, originRunId: runId, status: "queued" }], updatedAt: ts + 3
  }), "updated");
  // 脏数据：in-flight 但 active_run_id 为空。
  const dirtySessionId = newSortableId("sess");
  createMessageSession(db, { id: dirtySessionId, workspaceId, title: "startup-recovery-dirty-session", kind: "primary", createdAt: ts });
  // Deliberately corrupt the current Message-model run state to verify startup recovery reconciliation.
  db.prepare("update session_run_state set status='running', active_run_id=null, updated_at=? where workspace_id=? and session_id=?").run(ts, workspaceId, dirtySessionId);

  // in-flight 数据必须在 createApp 之前写入，以验证 pre-listen 阶段不会错误终态化。
  app = await createApp({
    db,
    repoRoot,
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    logLevel: "error",
    serveWeb: false,
    webDistDir: null,
      preview: { enabled: false, runtime: null },
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
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock")
  });

  await app.ready();

  // 当前启动策略是 fenced recovery enqueue；未监听时仅执行 pre-listen 清理。
  const run = getRunRecord(db, runId);
  assert.ok(run, "run record should exist");
  assert.equal(run?.status, "running");

  const state = getMessageRunState(db, workspaceId, sessionId);
  assert.ok(state);
  assert.equal(state.status, "running");
  assert.equal(state.activeRunId, runId);

  // 真实 Message / ToolExecution 图完整保留，供 onListen fenced recovery 接手。
  const timeline = db.prepare("select id, type, status from agent_message where workspace_id=? order by created_at, id").all(workspaceId) as Array<{ id: string; type: string; status: string }>;
  assert.ok(timeline.some((message) => message.id === assistantMessageId && message.status === "completed"));
  const execution = db.prepare("select status from agent_tool_execution where id=?").get(toolExecutionId) as { status: string } | undefined;
  assert.equal(execution?.status, "queued");

  // 脏状态的整理同样由 fenced recovery 负责，预监听阶段不应擅自改写。
  const dirty = getMessageRunState(db, workspaceId, dirtySessionId);
  assert.ok(dirty);
  assert.equal(dirty.status, "running");
  } finally {
    await app?.close();
    db.close();
    await rmrf(dataDir);
  }
});

test("startup recovery 将 running 工具标记为 unknown、保留 queued，并只替换一次 partial Assistant", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const session = await createPrimarySession(fixture);
    const runId = newSortableId("run");
    const ts = Date.now();
    createRunningMessageRun(fixture, session.id, runId, ts);
    const head = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
    const assistantId = newSortableId("msg");
    appendStreamingAssistant(fixture.db, {
      id: assistantId, workspaceId: fixture.workspaceId, sessionId: session.id,
      expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
      runId, createdAt: ts + 1,
    });
    const partialPartId = newSortableId("part");
    assert.equal(flushStreamingParts(fixture.db, {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: assistantId,
      parts: [{ id: partialPartId, position: 0, type: "text", text: "partial output" }], updatedAt: ts + 2,
    }), "updated");

    const callPartId = newSortableId("part");
    const runningCallPartId = newSortableId("part");
    fixture.db.prepare(`insert into agent_message_part (id,message_id,position,type,tool_name,tool_input_json,provider_tool_call_id,updated_revision,created_at,updated_at) values (?, ?, 1, 'tool_call', 'bash', '{"command":"true"}', 'call_recovery', 0, ?, ?), (?, ?, 2, 'tool_call', 'read', '{}', 'call_running_recovery', 0, ?, ?)`)
      .run(callPartId, assistantId, ts + 3, ts + 3, runningCallPartId, assistantId, ts + 3, ts + 3);
    const queuedId = newSortableId("exec");
    const runningId = newSortableId("exec");
    fixture.db.prepare(`
      insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at)
      values (?, ?, ?, ?, 'queued', 0, 0, ?, ?), (?, ?, ?, ?, 'running', 0, 0, ?, ?)
    `).run(queuedId, callPartId, session.id, runId, ts + 3, ts + 3, runningId, runningCallPartId, session.id, runId, ts + 3, ts + 3);
    fixture.db.prepare("update session_run_state set non_terminal_tool_execution_ids_json=? where workspace_id=? and session_id=?")
      .run(JSON.stringify([queuedId, runningId]), fixture.workspaceId, session.id);

    const persistence = new SqliteRunLifecyclePersistence(fixture.db);
    const candidate = { workspaceId: fixture.workspaceId, sessionId: session.id, runId, triggerMessageId: null };
    assert.deepEqual(
      persistence.prepareRunForStartupRecovery({ ...candidate, replacementMessageId: "msg_recovered", updatedAt: ts + 4 }),
      { prepared: true, resumeAssistantMessageId: "msg_recovered" },
    );
    assert.equal(getToolExecution(fixture.db, queuedId)?.status, "queued");
    assert.equal(getToolExecution(fixture.db, runningId)?.status, "unknown");
    assert.equal(getMessage(fixture.db, assistantId)?.status, "superseded");
    const replacement = getMessage(fixture.db, "msg_recovered");
    assert.equal(replacement?.status, "streaming");
    assert.equal(replacement?.previousMessageId, getMessage(fixture.db, assistantId)?.previousMessageId);
    assert.equal(replacement?.replacesMessageId, assistantId);
    const recoveredState = getMessageRunState(fixture.db, fixture.workspaceId, session.id);
    assert.equal(recoveredState?.activeAssistantMessageId, "msg_recovered");
    assert.equal(recoveredState?.runNoticeText, "任务正在自动恢复");
    assert.equal(recoveredState?.retryCount, 0);
    assert.equal(recoveredState?.nextRetryAt, null);

    assert.deepEqual(
      persistence.prepareRunForStartupRecovery({ ...candidate, replacementMessageId: "msg_should_not_exist", updatedAt: ts + 5 }),
      { prepared: true, resumeAssistantMessageId: "msg_recovered" },
    );
    assert.equal(getMessage(fixture.db, "msg_should_not_exist"), null);
    assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, session.id)?.activeAssistantMessageId, "msg_recovered");
  } finally {
    await fixture.dispose();
  }
});

test("runtime ready 先续作 tombstone，并跳过 deleting Run 后恢复其他 Workspace", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  const deletingWorkspaceId = fixture.workspaceId;
  const deletingSession = await createPrimarySession(fixture);
  const now = Date.now();
  const deletingRunId = newSortableId("run");
  createRunningMessageRun(fixture, deletingSession.id, deletingRunId, now);

  const healthyWorkspaceId = newSortableId("ws");
  const healthyDirName = `workspace_${healthyWorkspaceId}`;
  const healthyPath = workspaceRoot(fixture.dataDir, healthyDirName);
  await fs.mkdir(healthyPath, { recursive: true });
  insertWorkspace(fixture.db, {
    id: healthyWorkspaceId,
    dirName: healthyDirName,
    title: "healthy recovery workspace",
    path: healthyPath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now,
  });
  const healthySessionId = newSortableId("sess");
  createMessageSession(fixture.db, {
    id: healthySessionId,
    workspaceId: healthyWorkspaceId,
    title: "healthy session",
    kind: "primary",
    createdAt: now,
  });
  const healthyRunId = newSortableId("run");
  createRunningMessageRun(fixture, healthySessionId, healthyRunId, now, healthyWorkspaceId);

  const deletingWorkspace = getWorkspace(fixture.db, deletingWorkspaceId);
  assert.ok(deletingWorkspace);
  upsertWorkspaceDeletionIntent(fixture.db, {
    workspaceId: deletingWorkspaceId,
    dirName: deletingWorkspace.dirName,
    now,
  });
  workspaceDeletingFence.restore(deletingWorkspaceId);
  const enqueued: string[] = [];
  try {
    await recoverAfterAgentRuntimeReady({
      runtime: {
        enqueueRun: (run) => { enqueued.push(run.runId); },
        cancelSession: () => undefined,
      },
      generation: 1,
      resumeWorkspaceDeletions: () => resumePendingWorkspaceDeletions(fixture.ctx, fixture.app.log),
      recoverRuns: ({ runtime }) => createAgentService(fixture.ctx, fixture.app.log).recoverRunsOnStartup({ runtime }),
      reconcileTerminals: async () => undefined,
      logger: fixture.app.log,
    });
  } finally {
    workspaceDeletingFence.end(deletingWorkspaceId);
    workspaceDeletingFence.end(healthyWorkspaceId);
  }

  assert.equal(getWorkspace(fixture.db, deletingWorkspaceId), null, "tombstone Workspace must resume before Run recovery");
  assert.equal(getRunRecord(fixture.db, deletingRunId), null, "deleting Run must not be enqueued");
  assert.deepEqual(enqueued, [healthyRunId], "other Workspace recovery must continue");
});

test("recover 在 enqueue 前最终 DB check 中让 cancel wins", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const session = await createPrimarySession(fixture);
    const runId = newSortableId("run");
    const ts = Date.now();
    createRunningMessageRun(fixture, session.id, runId, ts);

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
    const state = getMessageRunState(fixture.db, fixture.workspaceId, session.id);
    assert.ok(state);
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
    createRunningMessageRun(fixture, session.id, runId, ts);

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
    const state = getMessageRunState(fixture.db, fixture.workspaceId, session.id);
    assert.ok(state);
    assert.equal(state.status, "idle");
    assert.equal(state.activeRunId, null);
  } finally {
    await fixture.dispose();
  }
});

test("recover enqueue transient failure 持久保持 running、同一 runId 自愈并继续处理后续 candidate", async (t: TestContext) => {
  const fixture = await createStartupFixture(t);
  try {
    const firstSession = await createPrimarySession(fixture);
    const secondSession = await createPrimarySession(fixture);
    const ts = Date.now();
    const firstRunId = newSortableId("run");
    const secondRunId = newSortableId("run");
    for (const [sessionId, runId] of [[firstSession.id, firstRunId], [secondSession.id, secondRunId]] as const) {
      createRunningMessageRun(fixture, sessionId, runId, ts);
    }

    const enqueued: string[] = [];
    let firstAttempt = true;
    const runtime: AgentRuntimePort = {
      async enqueueRun(run) {
        enqueued.push(run.runId);
        if (run.runId === firstRunId && firstAttempt) {
          firstAttempt = false;
          throw new Error("response lost after worker accepted run");
        }
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
    assert.equal(getRunRecord(fixture.db, firstRunId)?.status, "running");
    assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, firstSession.id)?.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(enqueued, [firstRunId, secondRunId, firstRunId]);
    assert.equal(getRunRecord(fixture.db, firstRunId)?.status, "running");
    assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, firstSession.id)?.activeRunId, firstRunId);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[1], "startup recovery handoff was deferred or rejected");
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
    createRunningMessageRun(fixture, session.id, runId, ts);

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
    const finalState = getMessageRunState(fixture.db, fixture.workspaceId, session.id);
    assert.ok(finalState);
    assert.equal(finalState.status, "idle");
  } finally {
    await fixture.dispose();
  }
});
