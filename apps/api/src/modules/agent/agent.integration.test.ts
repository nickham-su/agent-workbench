import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import Ajv from "ajv";
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { HttpError } from "../../app/errors.js";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import {
  agentArchivePendingSidecarPath,
  agentArchiveSessionDir,
  applyPatchUiArtifactPath,
  compactionSnippetPath,
  workspaceRepoDirPath,
  workspaceRoot,
  writeUiArtifactPath
} from "../../infra/fs/paths.js";
import { getSettingJson, setSettingJson } from "../settings/settings.store.js";
import { insertWorkspace, insertWorkspaceRepo } from "../workspaces/workspace.store.js";
import { insertRepo } from "../repos/repo.store.js";
import type { AppContext } from "../../app/context.js";
import {
  appendContextItem,
  createAgentSession,
  createRunRecord,
  getAgentSession,
  findSubtaskRunByParentTool,
  getRunRecord,
  getContextItemById,
  getLatestRunRecordBySession,
  getLatestTerminalRunRecord,
  getRunState as getRunStateRow,
  getSessionTranscriptItems,
  moveSessionHead,
  setRunStateIdle,
  updateRunRecordStatus,
  updateRunState
} from "./agent.store.js";
import { AgentService, isSubtaskParentToolUniqueConstraintError } from "./agent.service.js";
import { SqliteSubtaskMaintenancePersistence } from "./subtask/sqlite-subtask-maintenance-persistence.js";
import { AgentRuntime } from "./agent.runtime.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentApiSubtaskStartRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { normalizeMaxSubtaskDepthForUpdate } from "../settings/settings.service.js";
import { newSortableId } from "../../utils/ids.js";

type SchemaOnlyProbe = {
  observedBodies: unknown[];
  handlerCalls: number;
};

type PreValidationProbe = {
  observedBodies: unknown[];
  handlerCalls: number;
};

type Fixture = {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  workspaceId: string;
  workspacePath: string;
  internalToken: string;
  repoRoot: string;
  ctx: AppContext;
};

const fixtures = new Set<Fixture>();
const fixtureByApp = new WeakMap<FastifyInstance, Fixture>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createFixture(options?: {
  agentWorkerConcurrency?: number;
  agentTestFaults?: {
    archiveWrite?: { failAfterChunks?: number } | null;
  };
  enablePluginHost?: boolean;
  enablePluginServices?: boolean;
  agentGlobalPromptsStored?: unknown;
  agentGlobalPromptsUpdatedAt?: number;
  p0PreValidationProbe?: PreValidationProbe;
  p0SchemaOnlyProbe?: SchemaOnlyProbe;
}): Promise<Fixture> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  if (options?.agentGlobalPromptsStored !== undefined) {
    setSettingJson(
      db,
      "agent_global_prompts_v1",
      options.agentGlobalPromptsStored,
      options.agentGlobalPromptsUpdatedAt ?? Date.now()
    );
  }
  const ctx: AppContext = {
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
    agentWorkerConcurrency: options?.agentWorkerConcurrency ?? 2,
    agentInternalToken: internalToken,
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
    agentPluginHostEnabled: options?.enablePluginHost === true,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"),
    agentPluginServicesEnabled: options?.enablePluginServices === true,
    agentTestFaults: options?.agentTestFaults
  };
  const app = await createApp(ctx);
  const schemaOnlyProbe = options?.p0SchemaOnlyProbe;
  if (schemaOnlyProbe) {
    app.post(
      "/__p0-schema-only-probe",
      {
        schema: {
          body: Type.Object({ known: Type.String() }, { additionalProperties: false }),
          response: { 204: Type.Null() }
        }
      },
      async (req, reply) => {
        schemaOnlyProbe.observedBodies.push(structuredClone(req.body));
        schemaOnlyProbe.handlerCalls += 1;
        return reply.code(204).send();
      }
    );
  }
  const probe = options?.p0PreValidationProbe;
  if (probe) {
    app.post(
      "/__p0-prevalidation-probe",
      {
        schema: {
          body: Type.Object({ known: Type.String() }, { additionalProperties: false }),
          response: { 204: Type.Null() }
        },
        preValidation: async (req) => {
          probe.observedBodies.push(structuredClone(req.body));
          if (typeof req.body === "object" && req.body != null && "unexpected" in req.body) {
            throw new HttpError(400, "unexpected body key", "P0_UNKNOWN_BODY_KEY");
          }
        }
      },
      async (_req, reply) => {
        probe.handlerCalls += 1;
        return reply.code(204).send();
      }
    );
  }
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

  await app.ready();
  await configureAgentDefaults(app);
  setSettingJson(db, "agent_channel_sender_allowlist_v1", {
    items: [{ channel: "feishu", senderId: "u_allowed", remark: "default test allowlist" }]
  }, Date.now());
  const fixture: Fixture = { app, db, dataDir, workspaceId, workspacePath, internalToken, repoRoot, ctx };
  fixtures.add(fixture);
  fixtureByApp.set(app, fixture);
  return fixture;
}

test("plugin-host services reconcile can start/stop feishu gateway", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0, enablePluginHost: true, enablePluginServices: true });

  // Prepare a mock feishu plugin under dataDir/plugins so plugin discovery can find it.
  // We intentionally avoid network calls in tests.
  const pluginRoot = path.join(fixture.dataDir, "plugins", "feishu");
  await ensureDir(path.join(pluginRoot, "dist"));
  await fs.writeFile(
    path.join(pluginRoot, "agent-workbench.plugin.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "feishu",
        name: "Feishu IM",
        version: "0.0.0-test",
        description: "mock feishu plugin for integration tests",
        entry: "dist/index.mjs",
        capabilities: ["services"],
        services: [{ name: "gateway" }],
        uiHints: { sensitiveKeys: ["appSecret"] },
        configSchema: {
          type: "object",
          additionalProperties: false,
          required: ["appId", "appSecret"],
          properties: {
            appId: { type: "string", minLength: 1 },
            appSecret: { type: "string", minLength: 1 }
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(pluginRoot, "dist", "index.mjs"),
    [
      "export default {",
      "  meta: { id: 'feishu', name: 'Feishu IM', version: '0.0.0-test' },",
      "  services: {",
      "    gateway: {",
      "      async start() {",
      "        // no-op gateway (no network)",
      "        return { stop: async () => {} };",
      "      }",
      "    }",
      "  }",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );

  // Enable plugin with minimal config.
  const enableRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/plugins",
    payload: {
      plugins: [
        {
          id: "feishu",
          enabled: true,
          config: { appId: "test", appSecret: "test" }
        }
      ]
    }
  });
  assert.equal(enableRes.statusCode, 200, `enable plugin failed: ${enableRes.body}`);

  // Wait for services runtime reconcile hook to fire.
  await sleep(800);

  const host = new (await import("./agent.plugin-host-client.js" as any)).AgentPluginHostClient({
    pluginHostSocketPath: path.join(fixture.dataDir, "agent-plugin-host.sock"),
    internalToken: fixture.internalToken,
    logger: fixture.app.log
  });

  const status1 = await host.getServicesStatus();
  assert.equal(status1.running, true, `expected running=true, got running=${String(status1.running)}`);

  // Disable plugin.
  const disableRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/plugins",
    payload: {
      plugins: [
        {
          id: "feishu",
          enabled: false
        }
      ]
    }
  });
  assert.equal(disableRes.statusCode, 200, `disable plugin failed: ${disableRes.body}`);
  await sleep(500);
  const status2 = await host.getServicesStatus();
  assert.equal(status2.running, false, `expected running=false, got running=${String(status2.running)}`);
});

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

test("recover 在 enqueue 前最终 DB check 中让 cancel wins", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const session = await createSession(fixture.app, fixture.workspaceId);
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

    const service = new AgentService(fixture.ctx, fixture.app.log);
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
        service.cancelSessionCascade(session.id, { workspaceId: fixture.workspaceId });
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
    await closeFixture(fixture);
  }
});

test("recover enqueue 已发出后 cancel 仍以 DB cancelled 状态为准", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const session = await createSession(fixture.app, fixture.workspaceId);
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
    const service = new AgentService(fixture.ctx, fixture.app.log);
    await service.recoverRunsOnStartup({ runtime });
    assert.deepEqual(enqueued, [runId]);

    service.cancelSessionCascade(session.id, { workspaceId: fixture.workspaceId });
    assert.equal(getRunRecord(fixture.db, runId)?.status, "cancelled");
    const state = getRunStateRow(fixture.db, fixture.workspaceId, session.id);
    assert.equal(state.status, "idle");
    assert.equal(state.activeRunId, null);
  } finally {
    await closeFixture(fixture);
  }
});

test("recover enqueue failure 只记录并继续处理后续 candidate", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const firstSession = await createSession(fixture.app, fixture.workspaceId);
    const secondSession = await createSession(fixture.app, fixture.workspaceId);
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

    await new AgentService(fixture.ctx, logger).recoverRunsOnStartup({ runtime });

    assert.deepEqual(enqueued, [firstRunId, secondRunId]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[1], "startup recovery mode=recover: enqueue run failed");
  } finally {
    await closeFixture(fixture);
  }
});

test("runtime cancel 失败仅 warning，DB cancel 保持收敛", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const session = await createSession(fixture.app, fixture.workspaceId);
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
    const service = new AgentService(fixture.ctx, {
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
    await closeFixture(fixture);
  }
});

test("agent run mapper 对 SQLite 弱类型 lineage 值 fail-closed", async () => {
  const fixture = await createFixture();
  try {
    const sessionId = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: sessionId,
      workspaceId: fixture.workspaceId,
      title: "run-mapper",
      kind: "primary",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const parentRunId = newSortableId("run");
    const childRunId = newSortableId("run");
    createRunRecord(fixture.db, {
      runId: childRunId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: 1,
      parentRunId,
      parentToolItemId: 7,
      status: "completed",
      createdAt: Date.now()
    });
    fixture.db.prepare(`update agent_run set subtask_depth = ?, parent_tool_item_id = ?, parent_run_id = ? where run_id = ?`)
      .run("not-a-number", -1, "", childRunId);

    const record = getRunRecord(fixture.db, childRunId);
    assert.equal(record?.subtaskDepth, null);
    assert.equal(record?.parentToolItemId, null);
    assert.equal(record?.parentRunId, null);
    assert.equal(getLatestTerminalRunRecord(fixture.db, { workspaceId: fixture.workspaceId, sessionId })?.subtaskDepth, null);
    assert.equal(getLatestRunRecordBySession(fixture.db, { workspaceId: fixture.workspaceId, sessionId })?.parentToolItemId, null);

    fixture.db.prepare(`update agent_run set parent_run_id = ?, parent_tool_item_id = ?, subtask_depth = ? where run_id = ?`)
      .run(parentRunId, 7, -2, childRunId);
    assert.equal(findSubtaskRunByParentTool(fixture.db, { workspaceId: fixture.workspaceId, parentRunId, parentToolItemId: 7 })?.subtaskDepth, null);
  } finally {
    await closeFixture(fixture);
  }
});

test("primary 普通继续会重置 depth 和 parent 字段，即使最近 run 尚未 terminal", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: "run_terminal_depth_0",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null,
    status: "completed",
    createdAt
  });
  createRunRecord(fixture.db, {
    runId: "run_running_depth_2",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 2,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 2,
    parentRunId: null,
    parentToolItemId: null,
    status: "running",
    createdAt: createdAt + 1
  });
  const next = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "continue from latest run",
    clientRequestId: "latest-actual-run-depth"
  });
  const nextRun = getRunRecord(fixture.db, next.runId);
  assert.equal(nextRun?.subtaskDepth, 0);
  assert.equal(nextRun?.parentRunId, null);
  assert.equal(nextRun?.parentToolItemId, null);
});

test("primary latest Run depth 为 null 时，下一条消息自愈为独立执行根", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: "run_latest_depth_unknown",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: "legacy_parent_run",
    parentToolItemId: null,
    status: "completed",
    createdAt
  });

  const next = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "recover from unknown latest depth",
    clientRequestId: "latest-null-depth-recovery"
  });
  const nextRun = getRunRecord(fixture.db, next.runId);
  assert.equal(nextRun?.subtaskDepth, 0);
  assert.equal(nextRun?.parentRunId, null);
  assert.equal(nextRun?.parentToolItemId, null);
  assert.equal(getRunRecord(fixture.db, "run_latest_depth_unknown")?.subtaskDepth, null);
  assert.equal(getRunRecord(fixture.db, "run_latest_depth_unknown")?.parentRunId, "legacy_parent_run");
});

test("agent run 会保存 subtask depth lineage，并按 parent tool 查询 child run", async () => {
  const fixture = await createFixture();
  try {
    const sessionId = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: sessionId,
      workspaceId: fixture.workspaceId,
      title: "run-lineage",
      kind: "subtask",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const parentRunId = newSortableId("run");
    const childRunId = newSortableId("run");
    const createdAt = Date.now();

    createRunRecord(fixture.db, {
      runId: childRunId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: 2,
      parentRunId,
      parentToolItemId: 42,
      status: "running",
      createdAt
    });

    const record = getRunRecord(fixture.db, childRunId);
    assert.ok(record);
    assert.equal(record.subtaskDepth, 2);
    assert.equal(record.parentRunId, parentRunId);
    assert.equal(record.parentToolItemId, 42);

    const byParentTool = findSubtaskRunByParentTool(fixture.db, {
      workspaceId: fixture.workspaceId,
      parentRunId,
      parentToolItemId: 42
    });
    assert.equal(byParentTool?.runId, childRunId);
    assert.equal(findSubtaskRunByParentTool(fixture.db, { workspaceId: fixture.workspaceId, parentRunId, parentToolItemId: 43 }), null);
  } finally {
    await closeFixture(fixture);
  }
});

test("subtask cascade 以 run lineage 为准，不依赖 parent tool 的 subtaskSessionId 回填", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
    const started = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolItemId: parent.toolItem.item.id,
      session: { mode: "new" }
    });
    assert.equal(started.statusCode, 200, started.body);
    const child = started.json() as { sessionId: string; runId: string };

    fixture.db.prepare("update agent_context_item set tool_result_json = null, output_text = '' where id = ?").run(parent.toolItem.item.id);
    updateRunState(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: parent.parentSession.id,
      status: "running",
      activeRunId: parent.parentRunId,
      activeAssistantItemId: null,
      runNoticeText: "",
      updatedAt: Date.now(),
      appliedItemId: parent.toolItem.item.id
    });
    const cancelled = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${parent.parentSession.id}/cancel`,
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(getRunRecord(fixture.db, child.runId)?.status, "cancelled");
    assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, child.sessionId).status, "idle");
  } finally {
    await closeFixture(fixture);
  }
});

test("subtask orphan scanner 仅删除满足全部条件的空壳", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const service = new AgentService(fixture.ctx, fixture.app.log);
    const now = Date.now();
    const cases = [
      { name: "young", age: 30 * 60 * 1000, forked: true, resource: "none", expected: true },
      { name: "missing-fork", age: 25 * 60 * 60 * 1000, forked: false, resource: "none", expected: true },
      { name: "has-run", age: 25 * 60 * 60 * 1000, forked: true, resource: "run", expected: true },
      { name: "has-item-and-head", age: 25 * 60 * 60 * 1000, forked: true, resource: "item", expected: true },
      { name: "eligible", age: 25 * 60 * 60 * 1000, forked: true, resource: "none", expected: false }
    ];
    for (const item of cases) {
      const sessionId = `sess_orphan_${item.name}`;
      createAgentSession(fixture.db, {
        id: sessionId,
        workspaceId: fixture.workspaceId,
        title: item.name,
        kind: "subtask",
        createdAt: now - item.age,
        forkedFromSessionId: item.forked ? "parent" : null,
        forkedFromItemId: item.forked ? 1 : null
      });
      if (item.resource === "run") {
        createRunRecord(fixture.db, {
          runId: `run_orphan_${item.name}`,
          workspaceId: fixture.workspaceId,
          sessionId,
          triggerItemId: 0,
          agentId: "default",
          providerId: "ppchat",
          modelId: "gpt-5.2",
          status: "completed",
          createdAt: now - item.age
        });
      }
      if (item.resource === "item") {
        appendContextItem(fixture.db, {
          workspaceId: fixture.workspaceId,
          sessionId,
          runId: null,
          turnId: null,
          step: null,
          prevId: null,
          kind: "system",
          status: "completed",
          output: { type: "system_text", text: "not empty" },
          createdAt: now - item.age
        });
      }
      service.cleanupSubtaskOrphansOnStartup({ now });
      assert.equal(getAgentSession(fixture.db, sessionId) != null, item.expected, item.name);
    }

    const recheckedSessionId = "sess_orphan_rechecked";
    createAgentSession(fixture.db, {
      id: recheckedSessionId,
      workspaceId: fixture.workspaceId,
      title: "rechecked",
      kind: "subtask",
      createdAt: now - 25 * 60 * 60 * 1000,
      forkedFromSessionId: "parent",
      forkedFromItemId: 1
    });
    createRunRecord(fixture.db, {
      runId: "run_orphan_rechecked",
      workspaceId: fixture.workspaceId,
      sessionId: recheckedSessionId,
      triggerItemId: 0,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status: "completed",
      createdAt: now
    });
    assert.equal(new SqliteSubtaskMaintenancePersistence(fixture.db).deleteSuspectIfStillEligible({
      workspaceId: fixture.workspaceId,
      sessionId: recheckedSessionId,
      olderThan: now - 24 * 60 * 60 * 1000
    }), false, "deletion recheck must retain a newly non-empty candidate");
  } finally {
    await closeFixture(fixture);
  }
});

test("subtask orphan scanner 的单条删除异常不会阻断后续候选", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const now = Date.now();
    const blockedSessionId = "sess_orphan_blocked";
    const deletableSessionId = "sess_orphan_deletable";
    for (const sessionId of [blockedSessionId, deletableSessionId]) {
      createAgentSession(fixture.db, {
        id: sessionId,
        workspaceId: fixture.workspaceId,
        title: sessionId,
        kind: "subtask",
        createdAt: now - 25 * 60 * 60 * 1000,
        forkedFromSessionId: "parent",
        forkedFromItemId: 1
      });
    }
    fixture.db.exec(`
      create trigger fail_one_orphan_delete
      before delete on agent_session
      when old.id = '${blockedSessionId}'
      begin
        select raise(abort, 'injected orphan delete failure');
      end;
    `);

    new AgentService(fixture.ctx, fixture.app.log).cleanupSubtaskOrphansOnStartup({ now });

    assert.ok(getAgentSession(fixture.db, blockedSessionId));
    assert.equal(getAgentSession(fixture.db, deletableSessionId), null);
  } finally {
    await closeFixture(fixture);
  }
});

test("startSubtask failure 仅补偿本次新建空壳，不删除 existing reuse", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  try {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
    fixture.db.exec(`
      create trigger fail_subtask_user_insert
      before insert on agent_context_item
      when new.kind = 'user' and new.session_id != '${parent.parentSession.id}'
      begin
        select raise(abort, 'injected subtask start failure');
      end;
    `);
    const created = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolItemId: parent.toolItem.item.id,
      session: { mode: "new" }
    });
    assert.equal(created.statusCode, 500, created.body);
    const emptySubtasks = fixture.db.prepare("select count(*) as count from agent_session where kind = 'subtask'").get() as { count: number };
    assert.equal(emptySubtasks.count, 0);

    fixture.db.exec("drop trigger fail_subtask_user_insert");
    const existing = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: existing,
      workspaceId: fixture.workspaceId,
      title: "existing reuse",
      kind: "subtask",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    fixture.db.exec(`
      create trigger fail_existing_subtask_user_insert
      before insert on agent_context_item
      when new.kind = 'user' and new.session_id = '${existing}'
      begin
        select raise(abort, 'injected existing subtask failure');
      end;
    `);
    const reused = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolItemId: parent.toolItem.item.id,
      session: { mode: "existing", sessionId: existing }
    });
    assert.equal(reused.statusCode, 500, reused.body);
    assert.ok(getAgentSession(fixture.db, existing));
  } finally {
    await closeFixture(fixture);
  }
});

test("agent run 的 parent tool partial unique index 仅约束 subtask lineage", async () => {
  const fixture = await createFixture();
  try {
    const sessionId = newSortableId("sess");
    createAgentSession(fixture.db, {
      id: sessionId,
      workspaceId: fixture.workspaceId,
      title: "run-lineage-index",
      kind: "primary",
      createdAt: Date.now(),
      forkedFromSessionId: null,
      forkedFromItemId: null
    });
    const parentRunId = newSortableId("run");
    const base = {
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status: "running" as const,
      createdAt: Date.now()
    };

    createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 1, parentRunId, parentToolItemId: 7 });
    assert.throws(
      () => createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 1, parentRunId, parentToolItemId: 7 }),
      /UNIQUE constraint failed/
    );
    createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: 0, parentRunId, parentToolItemId: null });
    createRunRecord(fixture.db, { ...base, runId: newSortableId("run"), subtaskDepth: null, parentRunId, parentToolItemId: null });
  } finally {
    await closeFixture(fixture);
  }
});

test("subtask parent tool unique 冲突判定仅匹配目标 SQLite 约束", () => {
  assert.equal(
    isSubtaskParentToolUniqueConstraintError({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: agent_run.parent_run_id, agent_run.parent_tool_item_id"
    }),
    true
  );
  assert.equal(
    isSubtaskParentToolUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: other_table.value" }),
    false
  );
  assert.equal(
    isSubtaskParentToolUniqueConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "FOREIGN KEY constraint failed" }),
    false
  );
  assert.equal(isSubtaskParentToolUniqueConstraintError(new Error("transaction failed")), false);
});

test("maxSubtaskDepth 更新规范化只接受有限整数范围", () => {
  assert.equal(normalizeMaxSubtaskDepthForUpdate(1), 1);
  assert.equal(normalizeMaxSubtaskDepthForUpdate(5), 5);
  for (const invalid of ["1", "5", 1.5, 0, 6, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeMaxSubtaskDepthForUpdate(invalid),
      (err: unknown) => (err as { statusCode?: unknown; code?: unknown }).statusCode === 400
        && (err as { code?: unknown }).code === "AGENT_MAX_SUBTASK_DEPTH_INVALID"
    );
  }
});

async function configureAgentDefaults(app: FastifyInstance, contextWindowTokens = 128000) {
  const providersRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "ppchat",
        modelId: "gpt-5.2"
      },
      providers: [
        {
          id: "ppchat",
          name: "ppchat",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-test"
          },
          models: [
            {
              id: "gpt-5.2",
              name: "gpt-5.2",
              contextWindowTokens
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          pluginTools: [],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);
}



test("agent settings 兼容缺省 scope/order 并按原顺序归一化", async () => {
  const fixture = await createFixture();
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "b",
          name: "B",
           summary: "",
           prompt: "b",
           tools: ["bash", "read"],
           pluginTools: [],
           mcpServers: [],
           defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
           scope: "both",
           order: 9
        },
        {
          id: "a",
          name: "A",
           summary: "",
           prompt: "a",
           tools: ["bash", "read"],
           pluginTools: [],
           mcpServers: [],
           defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
           scope: "user",
           order: 3
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);

  setSettingJson(fixture.db, "agent_agents_v1", {
    agents: [
      { id: "legacy-1", name: "Legacy 1", summary: "", prompt: "", tools: ["bash"], pluginTools: [], mcpServers: [], defaultModel: null },
      { id: "legacy-2", name: "Legacy 2", summary: "", prompt: "", tools: ["read"], pluginTools: [], mcpServers: [], defaultModel: null }
    ]
  }, Date.now());

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.equal(getRes.statusCode, 200, `get agent settings failed: ${getRes.body}`);
  const body = getRes.json() as { agents: Array<{ id: string; scope: string; order: number }> };
  assert.deepEqual(body.agents.map((item) => ({ id: item.id, scope: item.scope, order: item.order })), [
    { id: "legacy-1", scope: "both", order: 0 },
    { id: "legacy-2", scope: "both", order: 1 }
  ]);
});

test("agent settings 保存并回读 scratchpad，默认工具列表仍不包含它", async () => {
  const fixture = await createFixture();
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "",
          tools: ["bash", "scratchpad", "read", "scratchpad", "subtask"],
          pluginTools: [],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);

  const body = res.json() as { agents: Array<{ tools: string[] }> };
  assert.deepEqual(body.agents[0]?.tools, ["bash", "scratchpad", "subtask"]);

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.equal(getRes.statusCode, 200, `get agent settings failed: ${getRes.body}`);
  const getBody = getRes.json() as { agents: Array<{ tools: string[] }> };
  assert.deepEqual(getBody.agents[0]?.tools, ["bash", "scratchpad", "subtask"]);

  setSettingJson(fixture.db, "agent_agents_v1", {
    agents: [
      { id: "legacy", name: "Legacy", summary: "", prompt: "", tools: undefined, pluginTools: [], mcpServers: [], defaultModel: null }
    ]
  }, Date.now());
  const fallbackRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  const fallbackBody = fallbackRes.json() as { agents: Array<{ tools: string[] }> };
  assert.deepEqual(fallbackBody.agents[0]?.tools, ["bash", "write", "apply_patch", "subtask"]);
});

test("agent prompt-context 仅在 agent.tools 显式包含 scratchpad 时暴露该工具", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const hiddenRunId = newSortableId("run");
  await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{ id: "default", name: "default", summary: "", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 0 }]
    }
  });
  createRunRecord(fixture.db, { runId: hiddenRunId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", uiLocale: "en-US", modelId: "gpt-5.2", subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "running", createdAt: Date.now() });
  const hiddenContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: hiddenRunId });
  assert.equal(hiddenContext.tools.some((item) => item.name === "scratchpad"), false);

  const visibleRunId = newSortableId("run");
  const visibleRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{ id: "default", name: "default", summary: "", prompt: "", tools: ["bash", "scratchpad", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 0 }]
    }
  });
  assert.equal(visibleRes.statusCode, 200, `update agents failed: ${visibleRes.body}`);
  createRunRecord(fixture.db, { runId: visibleRunId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", uiLocale: "en-US", modelId: "gpt-5.2", subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "running", createdAt: Date.now() });
  const visibleContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: visibleRunId });
  const scratchpadTool = visibleContext.tools.find((item) => item.name === "scratchpad");
  assert.ok(scratchpadTool);
  assert.ok(String(scratchpadTool.description || "").includes("Suggested <= 200 characters"));
  assert.equal((scratchpadTool.inputSchema as any)?.properties?.content?.maxLength, 200);
});

test("agent prompt-context 生成 subtask 描述时仅暴露 subtask/both agent", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        { id: "user-only", name: "User Only", summary: "for user", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "user", order: 0 },
        { id: "subtask-only", name: "Subtask Only", summary: "for subtask", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "subtask", order: 1 },
        { id: "shared", name: "Shared", summary: "shared", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 2 }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "shared", providerId: "ppchat", uiLocale: "en-US", modelId: "gpt-5.2", subtaskDepth: 0, status: "running", createdAt: Date.now()
  });

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const subtaskTool = promptContext.tools.find((item) => item.name === "subtask");
  assert.ok(subtaskTool, "subtask tool should exist");
  const description = String((subtaskTool as { description?: string } | undefined)?.description || "");
  assert.equal(description.includes("user-only"), false, "user-only agent should be hidden from subtask description");
  assert.equal(description.includes("subtask-only"), true, "subtask-only agent should be visible");
  assert.equal(description.includes("shared"), true, "shared agent should be visible");
});

test("agent prompt-context 中的工具描述与 schema 说明使用英文", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
            id: "default",
             name: "default",
             summary: "",
            prompt: "",
             tools: ["bash", "read", "scratchpad", "subtask", "todolist", "apply_patch"],
             pluginTools: [],
             mcpServers: [],
             defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
            scope: "both",
            order: 0
         }
       ]
     }
   });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "zh-CN",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const promptContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  const bashTool = promptContext.tools.find((item) => item.name === "bash");
  const readTool = promptContext.tools.find((item) => item.name === "read");
  const subtaskTool = promptContext.tools.find((item) => item.name === "subtask");
  const todolistTool = promptContext.tools.find((item) => item.name === "todolist");
  const scratchpadTool = promptContext.tools.find((item) => item.name === "scratchpad");
  const skillTool = promptContext.tools.find((item) => item.name === "skill");
  const applyPatchTool = promptContext.tools.find((item) => item.name === "apply_patch");
  assert.ok(String(bashTool?.description || "").includes("Run a bash command and return stdout/stderr."));
  assert.ok(String((bashTool?.inputSchema as any)?.properties?.timeout?.description || "").includes("Timeout in seconds"));
  const readLimit = (readTool?.inputSchema as any)?.properties?.limit;
  assert.equal(readLimit?.default, 500);
  assert.equal(readLimit?.maximum, 2000);
  assert.ok(String(readLimit?.description || "").includes("Default: 500"));
  assert.ok(String(readLimit?.description || "").includes("Maximum: 2000"));
  assert.ok(String(subtaskTool?.description || "").includes("Available agents:"));
  assert.equal(String(subtaskTool?.description || "").includes("可选Agent"), false);
  assert.ok(String(todolistTool?.description || "").includes("Example input:"));
  assert.ok(String(scratchpadTool?.description || "").includes("Suggested <= 200 characters"));
  assert.equal((scratchpadTool?.inputSchema as any)?.properties?.content?.maxLength, 200);
  assert.ok(String(skillTool?.description || "").includes("stable logical identifier"));
  assert.ok(String(skillTool?.description || "").includes("skillId"));
  assert.ok(String(skillTool?.description || "").includes("filePath"));
  const skillProperties = (skillTool?.inputSchema as any)?.properties;
  assert.deepEqual((skillTool?.inputSchema as any)?.required, ["skillId"]);
  assert.deepEqual(Object.keys(skillProperties || {}).sort(), ["filePath", "skillId"]);
  assert.equal(skillProperties?.id, undefined);
  assert.equal(skillProperties?.skill, undefined);
  assert.equal(skillProperties?.path, undefined);
  assert.equal(skillProperties?.skill_id, undefined);
  assert.equal(skillProperties?.file_path, undefined);
  assert.equal(skillProperties?.skillId?.minLength, undefined);
  assert.ok(String(skillProperties?.skillId?.description || "").includes("Stable logical skill identifier"));
  assert.ok(String(skillProperties?.filePath?.description || "").includes("spaces/tabs"));
  const validateSkillArgs = new Ajv({ allErrors: true, strict: false }).compile(skillTool?.inputSchema as Record<string, unknown>);
  assert.equal(validateSkillArgs({ skillId: "builtin/skill-authoring" }), true);
  assert.equal(validateSkillArgs({ skillId: "builtin/skill-authoring", filePath: "reference.md" }), true);
  for (const legacyPayload of [
    { id: "builtin/skill-authoring" },
    { skill: "builtin/skill-authoring" },
    { skill: "builtin/skill-authoring", path: "reference.md" },
    { skill_id: "builtin/skill-authoring" },
    { skill_id: "builtin/skill-authoring", file_path: "reference.md" },
    { skillId: "builtin/skill-authoring", path: "reference.md" },
    { skillId: "builtin/skill-authoring", file_path: "reference.md" },
    { skillId: "builtin/skill-authoring", skill_id: "builtin/skill-authoring" },
    { skillId: "builtin/skill-authoring", id: "builtin/skill-authoring" }
  ]) {
    assert.equal(validateSkillArgs(legacyPayload), false, `legacy payload must fail schema validation: ${JSON.stringify(legacyPayload)}`);
    assert.ok(
      validateSkillArgs.errors?.some((error) => error.keyword === "required" || error.keyword === "additionalProperties"),
      `legacy payload should fail required/additional-property validation: ${JSON.stringify(legacyPayload)}`
    );
  }
  assert.equal(String(todolistTool?.description || "").includes("完成 todolist goal 增强"), false);
  assert.equal(String(todolistTool?.description || "").includes("梳理需求与约束"), false);
  assert.ok(
    String((applyPatchTool?.inputSchema as any)?.properties?.patchText?.description || "").includes(
      "patchText must be a git unified diff text"
    )
  );
  const sessionSchema = (subtaskTool?.inputSchema as any)?.properties?.session;
  const subtaskDescriptionSchema = (subtaskTool?.inputSchema as any)?.properties?.description;
  const subtaskPromptSchema = (subtaskTool?.inputSchema as any)?.properties?.prompt;
  const subtaskAgentIdSchema = (subtaskTool?.inputSchema as any)?.properties?.agentId;
  assert.equal(subtaskDescriptionSchema?.minLength, 1);
  assert.equal(subtaskDescriptionSchema?.maxLength, undefined);
  assert.ok(String(subtaskDescriptionSchema?.description || "").includes("Longer values will be truncated to 50 characters."));
  assert.ok(String(subtaskPromptSchema?.description || "").includes("goal, scope or constraints, and deliverable boundary"));
  assert.ok(String(subtaskAgentIdSchema?.description || "").includes("assignee role template"));
  assert.ok(String(subtaskAgentIdSchema?.description || "").includes("not a specific assignee instance"));
  assert.ok(String(sessionSchema?.description || "").includes("background context or reuses prior session memory"));

  const oneOf = Array.isArray(sessionSchema?.oneOf) ? sessionSchema.oneOf : [];
  assert.ok(oneOf.length >= 3, "subtask.session.oneOf should contain multiple options");
  const newOption = oneOf.find((item: any) => item?.properties?.mode?.const === "new");
  const existingOption = oneOf.find((item: any) => item?.properties?.mode?.const === "existing");
  const forkOption = oneOf.find((item: any) => item?.properties?.mode?.const === "fork");
  assert.equal(
    oneOf.every((item: any) => typeof item?.description === "string" && !/[\u4e00-\u9fff]/.test(item.description)),
    true,
    "subtask.session.oneOf descriptions should be English"
  );
  assert.ok(String(newOption?.description || "").includes("no parent-session or prior subtask background"));
  assert.ok(String(existingOption?.description || "").includes("follow-up research"));
  assert.ok(String(existingOption?.properties?.sessionId?.description || "").includes("existing subtask session ID"));
  assert.ok(String(forkOption?.description || "").includes("full current parent-session history"));
  const subtaskDescription = String(subtaskTool?.description || "");
  assert.ok(subtaskDescription.includes("Recommended use cases:"));
  assert.ok(subtaskDescription.includes("Preserve parent-session context quality"));
  assert.ok(subtaskDescription.includes("Focus on results instead of process"));
  assert.ok(subtaskDescription.includes("Divide complex work"));
  assert.ok(subtaskDescription.includes("Usage guidance:"));
  assert.ok(subtaskDescription.includes("multiple independent tasks"));
  assert.ok(subtaskDescription.includes("implementation and code review cannot be delegated in parallel"));
  assert.ok(subtaskDescription.includes("prefer fork so the user's intent can be passed"));
  assert.ok(subtaskDescription.includes("full parent-session context"));
  assert.ok(subtaskDescription.includes("todolists"));
  assert.ok(subtaskDescription.includes("same agentId"));
  assert.ok(subtaskDescription.includes("same existing sessionId"));
  assert.ok(subtaskDescription.includes("fails after a session ID has already been created"));
  assert.ok(subtaskDescription.includes("succeeds but returns no summary"));
});

test("agent scope 校验会拒绝错误场景的 agent 并在无可用 agent 时返回明确错误", async () => {
  const fixture = await createFixture();
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        { id: "subtask-only", name: "Subtask Only", summary: "", prompt: "", tools: ["bash", "read"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "subtask", order: 0 }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const wrongRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "hi", clientRequestId: "req_scope_wrong", agentId: "subtask-only" }
  });
  assert.equal(wrongRes.statusCode, 400, `wrong scope should fail: ${wrongRes.body}`);
  assert.equal(wrongRes.json().code, "AGENT_SCOPE_NOT_ALLOWED");

  const fallbackRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "hi", clientRequestId: "req_scope_none" }
  });
  assert.equal(fallbackRes.statusCode, 400, `no available user agent should fail: ${fallbackRes.body}`);
  assert.equal(fallbackRes.json().code, "AGENT_NO_AVAILABLE_FOR_SURFACE");
});

test("GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "global_provider", modelId: "global_model" },
      providers: [
        {
          id: "global_provider",
          name: "Global Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.com/v1", apiKey: "sk-global" },
          models: [{ id: "global_model", name: "Global Model", contextWindowTokens: 128000 }]
        },
        {
          id: "agent_provider",
          name: "Agent Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.com/v1", apiKey: "sk-agent" },
          models: [{ id: "agent_model", name: "Agent Model", contextWindowTokens: 128000 }]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
           summary: "",
           prompt: "You are a helpful coding assistant.",
            tools: ["bash", "read", "write"],
            pluginTools: [],
            mcpServers: [],
            defaultModel: { providerId: "global_provider", modelId: "global_model" },
            scope: "both",
            order: 0
        },
        {
          id: "custom",
          name: "custom",
           summary: "",
           prompt: "Use a custom model.",
           tools: ["bash", "read"],
           pluginTools: [],
           mcpServers: [],
           defaultModel: { providerId: "agent_provider", modelId: "agent_model" },
           scope: "both",
           order: 1
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.equal(getRes.statusCode, 200, `get agent settings failed: ${getRes.body}`);
  const body = getRes.json() as any;
  const defaultAgent = body.agents.find((item: any) => item.id === "default");
  const customAgent = body.agents.find((item: any) => item.id === "custom");

  assert.deepEqual(defaultAgent?.resolvedModel, {
    providerId: "global_provider",
    providerName: "Global Provider",
    contextWindowTokens: 128000,
    modelId: "global_model",
    modelName: "Global Model",
    source: "agent_default"
  });
  assert.deepEqual(customAgent?.resolvedModel, {
    providerId: "agent_provider",
    providerName: "Agent Provider",
    contextWindowTokens: 128000,
    modelId: "agent_model",
    modelName: "Agent Model",
    source: "agent_default"
  });
});

test("internal runs/trigger 支持 clientRequestId 去重", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const payload = {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    agentId: "default",
    text: "hello from internal trigger",
    clientRequestId: "it_trigger_dedup_1"
  };

  const first = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload
  });
  assert.equal(first.statusCode, 201, `internal trigger first failed: ${first.body}`);
  const firstBody = first.json() as { runId: string; deduplicated: boolean; sessionId: string; messageItemId: number };
  assert.equal(firstBody.deduplicated, false);
  assert.equal(firstBody.sessionId, session.id);
  assert.ok(String(firstBody.runId).length > 0);

  const second = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload
  });
  assert.equal(second.statusCode, 201, `internal trigger second failed: ${second.body}`);
  const secondBody = second.json() as { runId: string; deduplicated: boolean; sessionId: string; messageItemId: number };
  assert.equal(secondBody.deduplicated, true);
  assert.equal(secondBody.runId, firstBody.runId);
  assert.equal(secondBody.messageItemId, firstBody.messageItemId);
  const run = getRunRecord(fixture.db, firstBody.runId);
  assert.equal(run?.subtaskDepth, 0);
  assert.equal(run?.parentRunId, null);
  assert.equal(run?.parentToolItemId, null);
});

test("internal runs/:runId/final-text 返回最终 assistant 文本", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: newSortableId("turn"),
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "final answer from integration test" }
  });
  assert.ok(assistantItem.item.id > 0);
  const runComplete = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      status: "completed"
    }
  });
  assert.equal(runComplete.statusCode, 200, `run complete failed: ${runComplete.body}`);

  const finalText = await fixture.app.inject({
    method: "GET",
    url: `/api/internal/agent/runs/${encodeURIComponent(runId)}/final-text`,
    headers: { "x-awb-agent-internal-token": fixture.internalToken }
  });
  assert.equal(finalText.statusCode, 200, `final-text query failed: ${finalText.body}`);
  const finalBody = finalText.json() as { found: boolean; text: string };
  assert.equal(finalBody.found, true);
  assert.equal(finalBody.text, "final answer from integration test");
});

test("internal events/sse 返回 run-complete 事件 chunk", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = fixture.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  assert.ok(port > 0, "listen should allocate a port");

  const session = await createSession(fixture.app, fixture.workspaceId);

  const sseAbort = new AbortController();
  let sseReader: any = null;
  let sseBody: any = null;
  let sseReady = false;

  const ssePromise = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/agent/events/sse`, {
      method: "GET",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      signal: sseAbort.signal
    });
    assert.equal(res.status, 200);
    assert.equal(String(res.headers.get("content-type") || "").includes("text/event-stream"), true);
    const body = res.body;
    if (!body) throw new Error("sse body missing");
    sseBody = body;
    const reader = body.getReader();
    sseReader = reader;
    const decoder = new TextDecoder();
    let text = "";
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes(": connected")) sseReady = true;

      if (text.includes("event: agent.run.completed.v1") && text.includes("data: {")) {
        return text;
      }
    }
    throw new Error(`sse chunk timeout: ${text}`);
  })();

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const readyStart = Date.now();
  while (!sseReady && Date.now() - readyStart < 3_000) {
    await sleep(20);
  }
  if (!sseReady) {
    throw new Error("sse ready timeout");
  }

  try {
    const complete = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      status: "completed"
    }
  });
    assert.equal(complete.statusCode, 200, `run-complete for sse failed: ${complete.body}`);

    const sseText = await ssePromise;

    assert.equal(sseText.includes("event: agent.run.completed.v1"), true);
    assert.equal(sseText.includes(`\"runId\":\"${runId}\"`), true);
    assert.equal(sseText.includes("data: {"), true);
    assert.equal(sseText.includes("\"eventType\":\"agent.run.completed.v1\""), true);
    assert.equal(sseText.includes("id: evt_"), true);
  } finally {
    sseAbort.abort();
    if (sseReader) {
      try {
        await sseReader.cancel();
      } catch {
        // ignore
      }
      sseReader = null;
    }
    if (sseBody) {
      try {
        await sseBody.cancel();
      } catch {
        // ignore
      }
      sseBody = null;
    }
    await ssePromise.catch(() => {
      // ignore: teardown path may abort reader/fetch
    });
  }
});

async function closeFixture(fixture: Fixture) {
  fixtures.delete(fixture);
  fixtureByApp.delete(fixture.app);
  await fixture.app.close();
  fixture.db.close();
  await rmrf(fixture.dataDir);
}

afterEach(async () => {
  for (const fixture of Array.from(fixtures)) {
    await closeFixture(fixture);
  }
});

async function createSession(app: FastifyInstance, workspaceId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId, title: "it-session" }
  });
  assert.equal(res.statusCode, 201, `create session failed: ${res.body}`);
  return res.json() as { id: string };
}

function createSubtaskSessionForTest(fixture: Fixture, params?: {
  title?: string;
  forkedFromSessionId?: string | null;
  forkedFromItemId?: number | null;
}) {
  const createdAt = Date.now();
  const id = newSortableId("sess");
  createAgentSession(fixture.db, {
    id,
    workspaceId: fixture.workspaceId,
    title: params?.title || "it-subtask-session",
    kind: "subtask",
    createdAt,
    forkedFromSessionId: params?.forkedFromSessionId ?? null,
    forkedFromItemId: params?.forkedFromItemId ?? null
  });
  const session = getAgentSession(fixture.db, id);
  assert.ok(session, "test subtask session should exist");
  return session;
}

async function sendMessage(app: FastifyInstance, params: { sessionId: string; workspaceId: string; text: string; clientRequestId: string }) {
  const res = await app.inject({
    method: "POST",
    url: `/api/agent/sessions/${params.sessionId}/messages`,
    payload: {
      workspaceId: params.workspaceId,
      text: params.text,
      clientRequestId: params.clientRequestId
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  return res.json() as { messageItemId: number; runId: string; deduplicated: boolean };
}

async function createSubtaskAnchor(params: {
  fixture: Awaited<ReturnType<typeof createFixture>>;
  parentDepth: number | null;
  sessionMode: "new" | "existing" | "fork";
  existingSessionId?: string;
}) {
  const parentSession = await createSession(params.fixture.app, params.fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const userItem = await createContextItemInternal({
    app: params.fixture.app,
    internalToken: params.fixture.internalToken,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "parent task" }
  });
  createRunRecord(params.fixture.db, {
    runId: parentRunId,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: userItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: params.parentDepth,
    status: "running",
    createdAt: Date.now()
  });
  const toolItem = await createContextItemInternal({
    app: params.fixture.app,
    internalToken: params.fixture.internalToken,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_depth",
    step: 1,
    prevId: userItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_subtask_depth",
      args: { description: "child", prompt: "complete child", agentId: "default", session: { mode: params.sessionMode } }
    }
  });
  return { parentSession, parentRunId, toolItem };
}

async function startSubtaskForAnchor(params: {
  fixture: Awaited<ReturnType<typeof createFixture>>;
  parentSessionId: string;
  parentRunId: string;
  parentToolItemId: number;
  session: { mode: "new" | "existing" | "fork"; sessionId?: string };
  description?: string;
  prompt?: string;
  agentId?: string;
  preforkSummaryText?: string;
  preforkMeta?: { thresholdPct: number; parentLastResponseTotalTokens: number; childContextWindowTokens: number };
}) {
  return await params.fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": params.fixture.internalToken },
    payload: {
      workspaceId: params.fixture.workspaceId,
      parentSessionId: params.parentSessionId,
      parentRunId: params.parentRunId,
      parentToolItemId: params.parentToolItemId,
      description: params.description ?? "child",
      prompt: params.prompt ?? "complete child",
      agentId: params.agentId ?? "default",
      session: params.session,
      ...(params.preforkSummaryText !== undefined ? { preforkSummaryText: params.preforkSummaryText } : {}),
      ...(params.preforkMeta !== undefined ? { preforkMeta: params.preforkMeta } : {})
    }
  });
}

function createDirectAgentService(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const ctx: AppContext = {
    db: fixture.db,
    repoRoot: fixture.repoRoot,
    dataDir: fixture.dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
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
    agentWorkerSocketPath: path.join(fixture.dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: 0,
    agentInternalToken: fixture.internalToken,
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(fixture.dataDir, "agent-plugin-host.sock")
  };
  return new AgentService(ctx, fixture.app.log);
}

async function assertDirectSubtaskStartError(params: {
  service: AgentService;
  request: AgentApiSubtaskStartRequest;
  statusCode: number;
  code: string;
}) {
  await assert.rejects(
    () => params.service.startSubtaskRunFromWorker(params.request),
    (error: unknown) => {
      const typed = error as { statusCode?: number; code?: string };
      assert.equal(typed.statusCode, params.statusCode);
      assert.equal(typed.code, params.code);
      return true;
    }
  );
}

test("subtask start reports anchor validation codes at the Route", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });

  const otherRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: otherRunId,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    triggerItemId: anchor.toolItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const anchorRunMismatch = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: otherRunId,
    parentToolItemId: anchor.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(anchorRunMismatch.statusCode, 400, anchorRunMismatch.body);
  assert.equal(anchorRunMismatch.json().code, "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH");

  const nonSubtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    runId: anchor.parentRunId,
    turnId: "turn_subtask_depth",
    step: 2,
    prevId: anchor.toolItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "bash",
      toolCallId: "call_not_subtask",
      args: { command: "true" },
      result: null
    }
  });
  const invalidAnchor = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolItemId: nonSubtaskTool.item.id,
    session: { mode: "new" }
  });
  assert.equal(invalidAnchor.statusCode, 400, invalidAnchor.body);
  assert.equal(invalidAnchor.json().code, "AGENT_SUBTASK_ANCHOR_INVALID");
});

test("subtask start stable validation codes are precise at Service boundaries", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
  const service = createDirectAgentService(fixture);
  const baseRequest = {
    workspaceId: fixture.workspaceId,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolItemId: anchor.toolItem.item.id,
    description: "child",
    prompt: "complete child",
    agentId: "default",
    session: { mode: "new" as const }
  };

  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, description: " " },
    statusCode: 400,
    code: "AGENT_SUBTASK_DESCRIPTION_REQUIRED"
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, agentId: " " },
    statusCode: 400,
    code: "AGENT_SUBTASK_AGENT_REQUIRED"
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "fork" }, preforkMeta: { thresholdPct: 95, parentLastResponseTotalTokens: 1, childContextWindowTokens: 128000 } },
    statusCode: 400,
    code: "AGENT_SUBTASK_PREFORK_META_INVALID"
  });
  const existingSessionMissingIdRequest = {
    ...baseRequest,
    session: { mode: "existing" }
  } as unknown as AgentApiSubtaskStartRequest;
  await assertDirectSubtaskStartError({
    service,
    request: existingSessionMissingIdRequest,
    statusCode: 400,
    code: "AGENT_SUBTASK_EXISTING_SESSION_REQUIRED"
  });
  const invalidSessionModeRequest = {
    ...baseRequest,
    session: { mode: "invalid" }
  } as unknown as AgentApiSubtaskStartRequest;
  await assertDirectSubtaskStartError({
    service,
    request: invalidSessionModeRequest,
    statusCode: 400,
    code: "AGENT_SUBTASK_SESSION_MODE_INVALID"
  });
  // The Service intentionally creates a new/fork session before this validation;
  // keep this case in the shared fixture to preserve the documented non-atomic behavior.
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, prompt: " " },
    statusCode: 400,
    code: "AGENT_SUBTASK_PROMPT_REQUIRED"
  });

  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: "missing-subtask-session" } },
    statusCode: 404,
    code: "AGENT_SUBTASK_SESSION_NOT_FOUND"
  });

  const foreignWorkspaceId = newSortableId("ws");
  const foreignWorkspaceDirName = newSortableId("workspace");
  const foreignWorkspacePath = workspaceRoot(fixture.dataDir, foreignWorkspaceDirName);
  await ensureDir(foreignWorkspacePath);
  insertWorkspace(fixture.db, {
    id: foreignWorkspaceId,
    dirName: foreignWorkspaceDirName,
    title: "foreign-workspace",
    path: foreignWorkspacePath,
    terminalCredentialId: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const foreignSessionId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: foreignSessionId,
    workspaceId: foreignWorkspaceId,
    title: "foreign-subtask",
    kind: "subtask",
    createdAt: Date.now()
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: foreignSessionId } },
    statusCode: 400,
    code: "AGENT_SUBTASK_WORKSPACE_MISMATCH"
  });

  const primarySession = await createSession(fixture.app, fixture.workspaceId);
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: primarySession.id } },
    statusCode: 400,
    code: "AGENT_SUBTASK_KIND_MISMATCH"
  });

  const runningSessionId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: runningSessionId,
    workspaceId: fixture.workspaceId,
    title: "running-subtask",
    kind: "subtask",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: runningSessionId,
    status: "running",
    activeRunId: "run-running-subtask",
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: runningSessionId } },
    statusCode: 409,
    code: "AGENT_SUBTASK_SESSION_RUNNING"
  });

  const invalidBoundaryAnchor = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    runId: anchor.parentRunId,
    turnId: "turn_invalid_boundary",
    step: 3,
    prevId: anchor.toolItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_invalid_boundary",
      args: { description: "child", prompt: "complete child", agentId: "default", session: { mode: "fork" } },
      result: null
    }
  });
  fixture.db.prepare("update agent_context_item set prev_id = ? where id = ?").run(999999999, invalidBoundaryAnchor.item.id);
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, parentToolItemId: invalidBoundaryAnchor.item.id, session: { mode: "fork" } },
    statusCode: 400,
    code: "AGENT_SUBTASK_FORK_BOUNDARY_INVALID"
  });
});

test("primary compact Run 固定写入 depth 0 和双空 parent 字段", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 1 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const seed = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "context for compaction",
    clientRequestId: "primary-compact-seed"
  });
  await waitRunIdle(fixture.app, session.id);

  // Fixture 已在 worker-disabled 时安装本地回退 runtime；打开 service gate 以覆盖真实 compact Run 写入。
  fixture.ctx.agentWorkerEnabled = true;
  fixture.db.prepare("update agent_run set subtask_depth = ?, parent_run_id = ?, parent_tool_item_id = ? where run_id = ?")
    .run(2, "legacy_parent", null, seed.runId);
  const compactRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "primary-compact-run"
    }
  });
  assert.equal(compactRes.statusCode, 201, compactRes.body);
  const compact = compactRes.json() as { runId: string };
  const run = getRunRecord(fixture.db, compact.runId);
  assert.equal(run?.subtaskDepth, 0);
  assert.equal(run?.parentRunId, null);
  assert.equal(run?.parentToolItemId, null);
});

test("primary 上下文 fork 创建独立执行根，不携带来源的 subtask 嵌套深度", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const source = await createSession(fixture.app, fixture.workspaceId);
  const sourceRunId = newSortableId("run");
  const sourceItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: source.id,
    runId: sourceRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "source" }
  });
  createRunRecord(fixture.db, {
    runId: sourceRunId,
    workspaceId: fixture.workspaceId,
    sessionId: source.id,
    triggerItemId: sourceItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 2,
    status: "completed",
    createdAt: Date.now()
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only" }
  });
  assert.equal(forkRes.statusCode, 201, forkRes.body);
  const forked = forkRes.json() as { id: string };
  const forkRun = await sendMessage(fixture.app, {
    sessionId: forked.id,
    workspaceId: fixture.workspaceId,
    text: "fork continuation",
    clientRequestId: "fork-depth"
  });
  const firstForkRun = getRunRecord(fixture.db, forkRun.runId);
  assert.equal(firstForkRun?.subtaskDepth, 0);
  assert.equal(firstForkRun?.parentRunId, null);
  assert.equal(firstForkRun?.parentToolItemId, null);

  const sourceItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, source.id);
  const forkedItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, forked.id);
  assert.equal(sourceItems.length, 1);
  assert.equal(sourceItems[0]?.runId, sourceRunId);
  assert.equal(forkedItems.length >= 1, true);
  assert.equal(forkedItems[0]?.kind, "user");
  assert.equal(forkedItems[0]?.runId, null, "copied context must not claim source run ownership");
  assert.equal(forkedItems[0]?.turnId, null);
  assert.equal(forkedItems[0]?.step, null);

  const secondForkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: forked.id, fromItemId: forkedItems[0]?.id, mode: "visible_only" }
  });
  assert.equal(secondForkRes.statusCode, 201, secondForkRes.body);
  const secondFork = secondForkRes.json() as { id: string };
  const secondForkRun = await sendMessage(fixture.app, {
    sessionId: secondFork.id,
    workspaceId: fixture.workspaceId,
    text: "second fork continuation",
    clientRequestId: "fork-depth-second"
  });
  const secondForkLineage = getRunRecord(fixture.db, secondForkRun.runId);
  assert.equal(secondForkLineage?.subtaskDepth, 0);
  assert.equal(secondForkLineage?.parentRunId, null);
  assert.equal(secondForkLineage?.parentToolItemId, null);

  const unknownSource = await createSession(fixture.app, fixture.workspaceId);
  const unknownItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: unknownSource.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "legacy source without run" }
  });
  const unknownForkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: unknownSource.id, fromItemId: unknownItem.item.id, mode: "visible_only" }
  });
  assert.equal(unknownForkRes.statusCode, 201, unknownForkRes.body);
  const unknownFork = unknownForkRes.json() as { id: string };
  const unknownForkRun = await sendMessage(fixture.app, {
    sessionId: unknownFork.id,
    workspaceId: fixture.workspaceId,
    text: "unknown fork continuation",
    clientRequestId: "fork-depth-unknown"
  });
  const unknownLineage = getRunRecord(fixture.db, unknownForkRun.runId);
  assert.equal(unknownLineage?.subtaskDepth, 0);
  assert.equal(unknownLineage?.parentRunId, null);
  assert.equal(unknownLineage?.parentToolItemId, null);

  const nullDepthSource = await createSession(fixture.app, fixture.workspaceId);
  const nullDepthRunId = newSortableId("run");
  const nullDepthItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: nullDepthSource.id,
    runId: nullDepthRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "legacy source with unknown depth" }
  });
  createRunRecord(fixture.db, {
    runId: nullDepthRunId,
    workspaceId: fixture.workspaceId,
    sessionId: nullDepthSource.id,
    triggerItemId: nullDepthItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: null,
    parentToolItemId: null,
    status: "completed",
    createdAt: Date.now()
  });
  const nullDepthForkRes = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: { fromSessionId: nullDepthSource.id, fromItemId: nullDepthItem.item.id, mode: "visible_only" } });
  assert.equal(nullDepthForkRes.statusCode, 201, nullDepthForkRes.body);
  const nullDepthFork = nullDepthForkRes.json() as { id: string };
  const nullDepthForkRun = await sendMessage(fixture.app, { sessionId: nullDepthFork.id, workspaceId: fixture.workspaceId, text: "keep unknown lineage", clientRequestId: "fork-depth-null-source" });
  const nullDepthLineage = getRunRecord(fixture.db, nullDepthForkRun.runId);
  assert.equal(nullDepthLineage?.subtaskDepth, 0);
  assert.equal(nullDepthLineage?.parentRunId, null);
  assert.equal(nullDepthLineage?.parentToolItemId, null);
});

test("public 和 generic internal create 固定创建 primary，并拒绝未知字段", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const publicCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "public-primary" }
  });
  assert.equal(publicCreate.statusCode, 201, publicCreate.body);
  assert.equal((publicCreate.json() as { kind: string }).kind, "primary");

  const internalCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/create",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, title: "internal-primary" }
  });
  assert.equal(internalCreate.statusCode, 201, internalCreate.body);
  assert.equal((internalCreate.json() as { kind: string }).kind, "primary");

  const sessionCountBeforeRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
  const rejectedRequests = [
    { name: "public primary kind", url: "/api/agent/sessions", headers: {}, payload: { workspaceId: fixture.workspaceId, kind: "primary" } },
    { name: "public subtask kind", url: "/api/agent/sessions", headers: {}, payload: { workspaceId: fixture.workspaceId, kind: "subtask" } },
    { name: "public arbitrary field", url: "/api/agent/sessions", headers: {}, payload: { workspaceId: fixture.workspaceId, unexpected: true } },
    { name: "internal primary kind", url: "/api/internal/agent/sessions/create", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, kind: "primary" } },
    { name: "internal subtask kind", url: "/api/internal/agent/sessions/create", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, kind: "subtask" } },
    { name: "internal arbitrary field", url: "/api/internal/agent/sessions/create", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, unexpected: true } }
  ];
  for (const rejected of rejectedRequests) {
    const response = await fixture.app.inject({ method: "POST", url: rejected.url, headers: rejected.headers, payload: rejected.payload });
    assert.equal(response.statusCode, 400, `${rejected.name}: ${response.body}`);
    assert.deepEqual(response.json(), { message: "request body contains unknown field", code: "AGENT_REQUEST_UNKNOWN_FIELD" });
    const sessionCountAfterRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
    assert.equal(sessionCountAfterRejected.count, sessionCountBeforeRejected.count, `${rejected.name} must not create a session`);
  }
});

test("public fork 固定创建 primary，并拒绝非 primary source 和未知字段", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const source = await createSession(fixture.app, fixture.workspaceId);
  const sourceItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: source.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "primary fork source" }
  });
  const accepted = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only" }
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal((accepted.json() as { kind: string }).kind, "primary");

  const sessionCountBeforeRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
  const rejectedRequests = [
    { name: "fork primary kind", payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only", kind: "primary" } },
    { name: "fork subtask kind", payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only", kind: "subtask" } },
    { name: "fork arbitrary field", payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only", unexpected: true } }
  ];
  for (const rejected of rejectedRequests) {
    const response = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: rejected.payload });
    assert.equal(response.statusCode, 400, `${rejected.name}: ${response.body}`);
    assert.deepEqual(response.json(), { message: "request body contains unknown field", code: "AGENT_REQUEST_UNKNOWN_FIELD" });
    const count = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
    assert.equal(count.count, sessionCountBeforeRejected.count, `${rejected.name} must not create a target session`);
  }

  const subtaskSource = createSubtaskSessionForTest(fixture);
  const subtaskItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: subtaskSource.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "subtask fork source" }
  });
  const sourceKindRejected = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: subtaskSource.id, fromItemId: subtaskItem.item.id, mode: "visible_only" }
  });
  assert.equal(sourceKindRejected.statusCode, 400, sourceKindRejected.body);
  assert.deepEqual(sourceKindRejected.json(), { message: "source session must be primary", code: "AGENT_FORK_SOURCE_KIND_INVALID" });
  const countAfterSourceKindRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
  assert.equal(countAfterSourceKindRejected.count, sessionCountBeforeRejected.count + 1, "source-kind rejection must not create a target session");
});

test("P0 baseline: endpoint-local preValidation sees unknown keys before schema stripping", async () => {
  const probe: PreValidationProbe = { observedBodies: [], handlerCalls: 0 };
  const fixture = await createFixture({ agentWorkerConcurrency: 0, p0PreValidationProbe: probe });

  const rejected = await fixture.app.inject({
    method: "POST",
    url: "/__p0-prevalidation-probe",
    payload: { known: "value", unexpected: "value" }
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.deepEqual(rejected.json(), { message: "unexpected body key", code: "P0_UNKNOWN_BODY_KEY" });
  assert.deepEqual(probe.observedBodies, [{ known: "value", unexpected: "value" }]);
  assert.equal(probe.handlerCalls, 0);

  const accepted = await fixture.app.inject({
    method: "POST",
    url: "/__p0-prevalidation-probe",
    payload: { known: "value" }
  });
  assert.equal(accepted.statusCode, 204, accepted.body);
  assert.equal(probe.handlerCalls, 1);
});

test("P0 baseline: schema additionalProperties:false alone strips unknown body keys and permits the request", async () => {
  const probe: SchemaOnlyProbe = { observedBodies: [], handlerCalls: 0 };
  const fixture = await createFixture({ agentWorkerConcurrency: 0, p0SchemaOnlyProbe: probe });

  const response = await fixture.app.inject({
    method: "POST",
    url: "/__p0-schema-only-probe",
    payload: { known: "value", unexpected: "value" }
  });

  assert.equal(response.statusCode, 204, response.body);
  assert.equal(probe.handlerCalls, 1);
  assert.deepEqual(probe.observedBodies, [{ known: "value" }]);
});

test("subtask start 按 depth 执行限制、mode 和轻量幂等", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { maxSubtaskDepth: 2 }
  });
  assert.equal(runtimeRes.statusCode, 200, runtimeRes.body);

  for (const mode of ["new", "fork"] as const) {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: mode });
    const res = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolItemId: parent.toolItem.item.id,
      session: { mode }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { sessionId: string; runId: string; reused: boolean };
    assert.equal(body.reused, false);
    const child = getRunRecord(fixture.db, body.runId);
    assert.equal(child?.subtaskDepth, 1);
    assert.equal(child?.parentRunId, parent.parentRunId);
    assert.equal(child?.parentToolItemId, parent.toolItem.item.id);
    const session = getAgentSession(fixture.db, body.sessionId);
    assert.equal(session?.kind, "subtask");
    assert.equal(session?.forkedFromSessionId, mode === "new" ? parent.parentSession.id : null);
    assert.equal(session?.forkedFromItemId, mode === "new" ? parent.toolItem.item.id : null);
  }

  const existingSession = createSubtaskSessionForTest(fixture, {
    title: "existing",
    forkedFromSessionId: "original-parent",
    forkedFromItemId: 7
  });
  const existingParent = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "existing" });
  const existingRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolItemId: existingParent.toolItem.item.id,
    session: { mode: "existing", sessionId: existingSession.id }
  });
  assert.equal(existingRes.statusCode, 200, existingRes.body);
  assert.equal((existingRes.json() as { agentName: string }).agentName, "default");
  const existingRun = getRunRecord(fixture.db, (existingRes.json() as { runId: string }).runId);
  assert.equal(existingRun?.subtaskDepth, 2);
  assert.equal(existingRun?.parentRunId, existingParent.parentRunId);
  assert.equal(existingRun?.parentToolItemId, existingParent.toolItem.item.id);
  const existingSessionAfter = getAgentSession(fixture.db, existingSession.id);
  assert.equal(existingSessionAfter?.forkedFromSessionId, "original-parent");
  assert.equal(existingSessionAfter?.forkedFromItemId, 7);

  const duplicate = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolItemId: existingParent.toolItem.item.id,
    session: { mode: "existing", sessionId: existingSession.id }
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal((duplicate.json() as { agentName: string }).agentName, "default");
  assert.equal((duplicate.json() as { reused: boolean }).reused, true);
  assert.equal((duplicate.json() as { runId: string }).runId, (existingRes.json() as { runId: string }).runId);

  const differentExistingSession = createSubtaskSessionForTest(fixture, { title: "different-existing" });
  const mismatch = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolItemId: existingParent.toolItem.item.id,
    session: { mode: "existing", sessionId: differentExistingSession.id }
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().code, "AGENT_SUBTASK_EXISTING_SESSION_MISMATCH");
  assert.equal(
    mismatch.json().message,
    "existing subtask session does not match the previously created child run"
  );
});

test("subtask fork 无 boundary 时保留双空 metadata 并写入 guard→prompt", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
  fixture.db.prepare("update agent_context_item set prev_id = null where id = ?").run(parent.toolItem.item.id);

  const res = await startSubtaskForAnchor({
    fixture,
    parentSessionId: parent.parentSession.id,
    parentRunId: parent.parentRunId,
    parentToolItemId: parent.toolItem.item.id,
    session: { mode: "fork" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const started = res.json() as { sessionId: string; runId: string };
  const session = getAgentSession(fixture.db, started.sessionId);
  assert.equal(session?.kind, "subtask");
  assert.equal(session?.forkedFromSessionId, null);
  assert.equal(session?.forkedFromItemId, null);

  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, "system");
  assert.equal(String((items[0]?.output as { text?: string }).text || "").includes("All history before this system message was copied"), true);
  assert.equal(items[0]?.runId, null);
  assert.equal(items[1]?.kind, "user");
  assert.equal(items[1]?.runId, started.runId);
});

test("subtask start 对 unknown 和超限 parent depth 返回明确错误", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const unknown = await createSubtaskAnchor({ fixture, parentDepth: null, sessionMode: "new" });
  const unknownRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: unknown.parentSession.id,
    parentRunId: unknown.parentRunId,
    parentToolItemId: unknown.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(unknownRes.statusCode, 409);
  assert.equal(unknownRes.json().code, "AGENT_SUBTASK_DEPTH_UNKNOWN");

  const maxRes = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 1 } });
  assert.equal(maxRes.statusCode, 200, maxRes.body);
  const exceeded = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
  const exceededRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: exceeded.parentSession.id,
    parentRunId: exceeded.parentRunId,
    parentToolItemId: exceeded.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(exceededRes.statusCode, 409);
  assert.equal(exceededRes.json().code, "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
});

test("已有 child 可在配置下调后复用，而新的同层调用按最新上限拒绝", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 2 } });
  const existing = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
  const started = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existing.parentSession.id,
    parentRunId: existing.parentRunId,
    parentToolItemId: existing.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(started.statusCode, 200, started.body);
  const original = started.json() as { runId: string; reused: boolean };
  assert.equal(original.reused, false);

  const lowered = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 1 } });
  assert.equal(lowered.statusCode, 200, lowered.body);
  const retried = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existing.parentSession.id,
    parentRunId: existing.parentRunId,
    parentToolItemId: existing.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal((retried.json() as { runId: string; reused: boolean }).runId, original.runId);
  assert.equal((retried.json() as { reused: boolean }).reused, true);

  const nextTool = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
  const rejected = await startSubtaskForAnchor({
    fixture,
    parentSessionId: nextTool.parentSession.id,
    parentRunId: nextTool.parentRunId,
    parentToolItemId: nextTool.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
});

test("subtask start preserves session union boundaries at the Route", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
  const initial = await startSubtaskForAnchor({ fixture, parentSessionId: anchor.parentSession.id, parentRunId: anchor.parentRunId, parentToolItemId: anchor.toolItem.item.id, session: { mode: "fork" } });
  assert.equal(initial.statusCode, 200, initial.body);

  const forbiddenSessionId = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolItemId: anchor.toolItem.item.id,
    session: { mode: "fork", sessionId: "SHOULD_REJECT" }
  });
  assert.equal(forbiddenSessionId.statusCode, 400);
  assert.equal((forbiddenSessionId.json() as { code?: string }).code, "AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED");

  const missingExistingSessionId = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: anchor.parentSession.id,
      parentRunId: anchor.parentRunId,
      parentToolItemId: anchor.toolItem.item.id,
      description: "child",
      prompt: "complete child",
      agentId: "default",
      session: { mode: "existing" }
    }
  });
  assert.equal(missingExistingSessionId.statusCode, 400);
  assert.equal(String(missingExistingSessionId.body).includes("AGENT_SUBTASK_EXISTING_SESSION_REQUIRED"), false);
});

function extractPromptSection(system: string, tag: string) {
  const marker = `[${tag}]`;
  const start = system.indexOf(marker);
  if (start < 0) return "";
  const afterMarker = system.indexOf("\n\n", start);
  if (afterMarker < 0) return "";
  const bodyStart = afterMarker + 2;
  const nextSection = system.indexOf("\n\n---\n[", bodyStart);
  if (nextSection < 0) {
    return system.slice(bodyStart).trim();
  }
  return system.slice(bodyStart, nextSection).trim();
}

async function getRunState(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/run-state` });
  assert.equal(res.statusCode, 200, `get run-state failed: ${res.body}`);
  return res.json() as {
    status: "idle" | "running";
    activeRunId: string | null;
    runNoticeText: string;
    lastTerminalStatus: "completed" | "failed" | "cancelled" | null;
    contextWindowTokens?: number | null;
    contextTokenRatio?: number | null;
  };
}

async function getMessagesContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  appendMessage?: { role: "system" | "user"; content: string };
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/messages-context",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.appendMessage ? { appendMessage: params.appendMessage } : {})
    }
  });
  assert.equal(res.statusCode, 200, `get messages-context failed: ${res.body}`);
  return res.json() as {
    headItemId: number | null;
    system: string;
    messages: Array<{ role: string; content: unknown }>;
  };
}

async function waitRunIdle(app: FastifyInstance, sessionId: string, timeoutMs = 6_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runState = await getRunState(app, sessionId);
    if (runState.status === "idle") return;
    await sleep(80);
  }
  throw new Error(`wait run idle timeout, sessionId=${sessionId}`);
}

async function getContextItems(app: FastifyInstance, sessionId: string, afterId?: number) {
  const url = afterId ? `/api/agent/sessions/${sessionId}/context-items?afterId=${afterId}` : `/api/agent/sessions/${sessionId}/context-items`;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `get context-items failed: ${res.body}`);
  return res.json() as {
    headItemId: number | null;
    items: Array<{
      id: number;
      kind: string;
      status: string;
      output: Record<string, any>;
      prevId: number | null;
      archiveAt: number | null;
      boundaryReason: string | null;
    }>;
  };
}

async function getContextItem(app: FastifyInstance, sessionId: string, itemId: number) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items/${itemId}` });
  assert.equal(res.statusCode, 200, `get context-item failed: ${res.body}`);
  return res.json() as { id: number; status: string; output: Record<string, unknown> };
}

async function createContextItemInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  step: number | null;
  prevId: number | null;
  kind: "user" | "assistant" | "tool" | "system";
  status: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
  output: Record<string, unknown>;
}) {
  const fixture = fixtureByApp.get(params.app);
  const existingRun = fixture && params.runId ? getRunRecord(fixture.db, params.runId) : null;
  const previousState = fixture && params.runId ? getRunStateRow(fixture.db, params.workspaceId, params.sessionId) : null;
  const temporaryRun = fixture && params.runId && !existingRun;
  if (fixture && params.runId) {
    if (temporaryRun) {
      createRunRecord(fixture.db, {
        runId: params.runId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        triggerItemId: 0,
        agentId: "default",
        providerId: "ppchat",
        modelId: "gpt-5.2",
        status: "running",
        createdAt: Date.now()
      });
    } else if (existingRun) {
      updateRunRecordStatus(fixture.db, { runId: existingRun.runId, status: "running", updatedAt: Date.now() });
    }
    updateRunState(fixture.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: "running",
      activeRunId: params.runId,
      activeAssistantItemId: null,
      updatedAt: Date.now(),
      appliedItemId: previousState?.appliedItemId ?? 0
    });
  }

  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      turnId: params.turnId,
      step: params.step,
      prevId: params.prevId,
      kind: params.kind,
      status: params.status,
      output: params.output
    }
  });
  if (fixture && params.runId && previousState) {
    if (temporaryRun) {
      fixture.db.prepare("delete from agent_run where run_id = ?").run(params.runId);
    } else if (existingRun) {
      updateRunRecordStatus(fixture.db, { runId: existingRun.runId, status: existingRun.status, updatedAt: Date.now() });
    }
    updateRunState(fixture.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: previousState.status,
      activeRunId: previousState.activeRunId,
      activeAssistantItemId: previousState.activeAssistantItemId,
      lastResponseTotalTokens: previousState.lastResponseTotalTokens,
      runNoticeText: previousState.runNoticeText,
      updatedAt: previousState.updatedAt,
      appliedItemId: previousState.appliedItemId
    });
  }
  assert.equal(res.statusCode, 200, `create internal context-item failed: ${res.body}`);
  return res.json() as { item: { id: number } };
}

async function updateContextItemInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  itemId: number;
  status?: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
  output?: Record<string, unknown>;
}) {
  const res = await params.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${params.itemId}`,
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      ...(Object.prototype.hasOwnProperty.call(params, "status") ? { status: params.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "output") ? { output: params.output } : {})
    }
  });
  assert.equal(res.statusCode, 200, `update internal context-item failed: ${res.body}`);
  return res.json() as { item: { id: number } };
}

async function updateRunStateInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  status: "idle" | "running";
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  lastResponseTotalTokens?: number | null;
  runNoticeText?: string | null;
  updatedAt?: number;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId: params.activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      ...(Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens")
        ? { lastResponseTotalTokens: params.lastResponseTotalTokens }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "runNoticeText") ? { runNoticeText: params.runNoticeText } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "updatedAt") ? { updatedAt: params.updatedAt } : {})
    }
  });
  assert.equal(res.statusCode, 200, `update internal run-state failed: ${res.body}`);
}

test("Run Routes: invalid token + invalid body is 401; valid token + invalid body is 400", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runStateBody = {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null
  };

  const validState = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: runStateBody
  });
  assert.equal(validState.statusCode, 200, validState.body);
  assert.deepEqual(validState.json(), { ok: true });

  const invalidBody = { workspaceId: fixture.workspaceId };
  for (const url of [
    "/api/internal/agent/run-state",
    "/api/internal/agent/run-complete"
  ]) {
    const validTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: invalidBody
    });
    assert.equal(validTokenInvalidBody.statusCode, 400, `${url}: ${validTokenInvalidBody.body}`);
    const validErrorBody = validTokenInvalidBody.json() as { message?: unknown; code?: unknown };
    assert.equal(typeof validErrorBody.message, "string", `${url}: ${validTokenInvalidBody.body}`);
    assert.ok(validErrorBody.code === undefined || typeof validErrorBody.code === "string", `${url}: ${validTokenInvalidBody.body}`);

    const invalidTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
      payload: invalidBody
    });
    assert.equal(invalidTokenInvalidBody.statusCode, 401, `${url}: ${invalidTokenInvalidBody.body}`);
    const invalidTokenErrorBody = invalidTokenInvalidBody.json() as { message?: unknown; code?: unknown };
    assert.equal(typeof invalidTokenErrorBody.message, "string", `${url}: ${invalidTokenInvalidBody.body}`);
    assert.ok(invalidTokenErrorBody.code === undefined || typeof invalidTokenErrorBody.code === "string", `${url}: ${invalidTokenInvalidBody.body}`);
  }
});

test("Subtask Routes: invalid token wins over invalid body and valid token reaches schema validation", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const endpoints = [
    "/api/internal/agent/subtask/prefork-plan",
    "/api/internal/agent/subtask/start",
    "/api/internal/agent/subtask/result",
    "/api/internal/agent/subtask/status"
  ];
  for (const url of endpoints) {
    const validTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(validTokenInvalidBody.statusCode, 400, `${url}: ${validTokenInvalidBody.body}`);
    const invalidTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(invalidTokenInvalidBody.statusCode, 401, `${url}: ${invalidTokenInvalidBody.body}`);
  }
});

test("Run Route: unknown top-level fields preserve the current accepted request behavior", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      extraField: "preserved"
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
});

test("Run ignored: RS-1, RS-2, RS-3 and RC-1, RC-2, RC-3 return 200 ok without DB mutation", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const sessionRs1 = await createSession(fixture.app, fixture.workspaceId);
  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: sessionRs1.id,
    status: "running",
    activeRunId: "run-rs1-first",
    activeAssistantItemId: null
  });
  const rs1Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs1.id,
      status: "running",
      activeRunId: "run-rs1-late",
      activeAssistantItemId: null
    }
  });
  assert.equal(rs1Ignored.statusCode, 200);
  assert.deepEqual(rs1Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs1.id).activeRunId, "run-rs1-first");

  const sessionRs2 = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);
  const rs2RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rs2RunId,
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const rs2Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs2.id,
      status: "running",
      activeRunId: rs2RunId,
      activeAssistantItemId: null
    }
  });
  assert.equal(rs2Ignored.statusCode, 200);
  assert.deepEqual(rs2Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs2.id).activeRunId, null);

  const sessionRs3 = await createSession(fixture.app, fixture.workspaceId);
  const rs3RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rs3RunId,
    workspaceId: fixture.workspaceId,
    sessionId: sessionRs3.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt: Date.now()
  });
  const rs3Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs3.id,
      status: "running",
      activeRunId: rs3RunId,
      activeAssistantItemId: null
    }
  });
  assert.equal(rs3Ignored.statusCode, 200);
  assert.deepEqual(rs3Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs3.id).activeRunId, null);

  const rc1Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs2.id,
      runId: "missing-run",
      status: "completed"
    }
  });
  assert.equal(rc1Ignored.statusCode, 200);
  assert.deepEqual(rc1Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs2.id).activeRunId, null);

  const rc2RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rc2RunId,
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const rc2Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs2.id,
      runId: rc2RunId,
      status: "completed"
    }
  });
  assert.equal(rc2Ignored.statusCode, 200);
  assert.deepEqual(rc2Ignored.json(), { ok: true });
  assert.equal(getRunRecord(fixture.db, rc2RunId)?.status, "running");

  const rc3RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rc3RunId,
    workspaceId: fixture.workspaceId,
    sessionId: sessionRs3.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt: Date.now()
  });
  const rc3Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs3.id,
      runId: rc3RunId,
      status: "failed"
    }
  });
  assert.equal(rc3Ignored.statusCode, 200);
  assert.deepEqual(rc3Ignored.json(), { ok: true });
  assert.equal(getRunRecord(fixture.db, rc3RunId)?.status, "completed");
});

async function getPromptContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId
    }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as {
    system: string;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    uiLocale: "zh-CN" | "en-US" | null;
    messages: Array<{ role: string; content: unknown }>;
    pendingTools: Array<{ itemId: number; status: string; toolName: string }>;
    externalSkillRoots: Array<{ sourceType: "workspace" | "repo"; repoId?: string; rootDir: string; rootPath: string }>;
  };
}

test("prompt-context reuses one run static promise and clears it when the run reaches a terminal status", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const service = createDirectAgentService(fixture) as any;
  const request = { workspaceId: fixture.workspaceId, sessionId: session.id, runId };

  await service.getPromptContextForRun(request);
  const first = service.runPromptStaticCache.get(runId);
  assert.ok(first, "first prompt-context call should populate the static cache");
  const firstPromise = first.promise;
  const firstExpiresAt = first.expiresAt;

  await service.getPromptContextForRun(request);
  const second = service.runPromptStaticCache.get(runId);
  assert.ok(second, "second prompt-context call should retain the static cache");
  assert.equal(second.promise, firstPromise, "same run should reuse the static prompt promise while it is fresh");
  assert.ok(second.expiresAt >= firstExpiresAt, "same run cache access should preserve the current access-based expiry behavior");

  service.completeRunFromWorker({
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    status: "completed"
  });
  assert.equal(service.runPromptStaticCache.has(runId), false, "terminal run completion should clear the static prompt cache");

  await service.getPromptContextForRun(request);
  const afterTerminal = service.runPromptStaticCache.get(runId);
  assert.ok(afterTerminal, "current service still permits prompt retrieval for a terminal run");
  assert.notEqual(afterTerminal.promise, firstPromise, "terminal cache clear should force a new static promise on the next retrieval");
});

async function compactContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  expectedHeadItemId: number | null;
  summaryText: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/context/compact",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      expectedHeadItemId: params.expectedHeadItemId,
      summaryText: params.summaryText
    }
  });
  assert.equal(res.statusCode, 200, `compact context failed: ${res.body}`);
  return res.json() as { compacted: boolean; summaryItemId: number | null; archivedCount: number };
}

async function archiveSearchInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  query: string;
  beforePos?: number;
  maxHits?: number;
  maxChars?: number;
  snippet?: boolean;
  regex?: boolean;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/search",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      query: params.query,
      ...(params.beforePos != null ? { beforePos: params.beforePos } : {}),
      ...(params.maxHits ? { maxHits: params.maxHits } : {}),
      ...(params.maxChars ? { maxChars: params.maxChars } : {}),
      ...(params.snippet === true ? { snippet: true } : {}),
      ...(params.regex === true ? { regex: true } : {})
    }
  });
  assert.equal(res.statusCode, 200, `archive search failed: ${res.body}`);
  return res.json() as { text: string };
}

async function archiveReadInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  beforePos?: number;
  lineCount?: number;
  maxChars?: number;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/read",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.beforePos != null ? { beforePos: params.beforePos } : {}),
      ...(params.lineCount ? { lineCount: params.lineCount } : {}),
      ...(params.maxChars ? { maxChars: params.maxChars } : {})
    }
  });
  assert.equal(res.statusCode, 200, `archive read failed: ${res.body}`);
  return res.json() as { text: string };
}

test("agent 消息去重与上下文项追加", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const clientRequestId = newSortableId("req");

  const first = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello integration",
    clientRequestId
  });
  const second = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello integration",
    clientRequestId
  });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.messageItemId, first.messageItemId);
  assert.equal(second.runId, first.runId);

  await waitRunIdle(fixture.app, session.id);
  const context = await getContextItems(fixture.app, session.id);
  const userItems = context.items.filter((item) => item.kind === "user");
  assert.equal(userItems.length, 1);
  assert.ok(String(userItems[0]?.output?.text || "").includes("hello integration"));
});

test("read-side execution-profile 与 prompt-context 不修改已有 run、session 或 context", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "read-only baseline" }
  });

  const beforeSession = getAgentSession(fixture.db, session.id);
  const beforeRun = getRunRecord(fixture.db, runId);
  const beforeRunState = getRunStateRow(fixture.db, fixture.workspaceId, session.id);
  const beforeItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id);

  const profile = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId }
  });
  assert.equal(profile.statusCode, 200, `get execution-profile failed: ${profile.body}`);
  const prompt = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId }
  });
  assert.equal(prompt.statusCode, 200, `get prompt-context failed: ${prompt.body}`);

  assert.deepEqual(getAgentSession(fixture.db, session.id), beforeSession);
  assert.deepEqual(getRunRecord(fixture.db, runId), beforeRun);
  assert.deepEqual(getRunStateRow(fixture.db, fixture.workspaceId, session.id), beforeRunState);
  assert.deepEqual(getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id), beforeItems);
});

test("agent messages-context 返回完整 messages 且支持 appendMessage", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const user = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "hello" }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: user.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "world" }
  });

  const beforeItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id);
  const beforeRunState = getRunStateRow(fixture.db, fixture.workspaceId, session.id);

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    appendMessage: { role: "user", content: "append" }
  });
  assert.equal(typeof ctx.headItemId, "number");
  assert.ok(ctx.messages.length >= 3);
  assert.equal(ctx.messages.at(-1)?.role, "user");
  assert.equal(ctx.messages.at(-1)?.content, "append");
  assert.ok(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"));
  assert.deepEqual(getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id), beforeItems);
  assert.deepEqual(getRunStateRow(fixture.db, fixture.workspaceId, session.id), beforeRunState);
});

test("agent messages-context system 根据 active run 的 uiLocale 返回英文语言约束", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });

  assert.ok(ctx.system.includes("Language requirement: use English consistently for this run."));
  assert.equal(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"), false);
});

test("agent messages-context 在 activeRun 缺失时回退到当前 session 最近 run 的 uiLocale", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now() - 10_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "completed",
    createdAt: Date.now()
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });

  assert.ok(ctx.system.includes("Language requirement: use English consistently for this run."));
});

test("agent messages-context 在当前 session 无可用 locale 时回退到全局最近 run 的 uiLocale", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const targetSession = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "completed",
    createdAt: Date.now() - 20_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "completed",
    createdAt: Date.now() - 10_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now()
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id
  });

  assert.ok(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"));
});

test("agent messages-context 回退到全局最近 run 时会忽略非法 uiLocale 脏值", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const targetSession = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "completed",
    createdAt: Date.now() - 30_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "completed",
    createdAt: Date.now() - 20_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "fr-FR" as any,
    status: "completed",
    createdAt: Date.now() - 10_000
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id
  });

  assert.ok(ctx.system.includes("Language requirement: use English consistently for this run."));
  assert.equal(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"), false);
});

test("agent context-items 支持 afterId 增量查询", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "first",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const full = await getContextItems(fixture.app, session.id);
  const lastId = full.items.at(-1)?.id ?? 0;

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "second",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const delta = await getContextItems(fixture.app, session.id, lastId);
  assert.ok(delta.items.length > 0);
  assert.ok(
    delta.items.every((item) => item.id > lastId),
    `unexpected delta items; lastId=${String(lastId)} ids=${delta.items.map((i) => i.id).join(",")}`
  );
});

test("agent context-items 支持 assistant reasoning 字段的创建与读取", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "hello"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "结论正文",
      reasoning: {
        text: "先分析上下文,再给结论"
      }
    }
  });

  const full = await getContextItems(fixture.app, session.id);
  const assistant = full.items.find((item) => item.id === assistantItem.item.id);
  assert.ok(assistant);
  assert.equal(assistant?.kind, "assistant");
  assert.equal(assistant?.output.type, "assistant_text");
  assert.equal(assistant?.output.text, "结论正文");
  assert.deepEqual((assistant?.output as any).reasoning, { text: "先分析上下文,再给结论" });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.deepEqual((single.output as any).reasoning, { text: "先分析上下文,再给结论" });
});

test("agent context-items 支持 assistant reasoning 字段的更新", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_update",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "初始正文"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: assistantItem.item.id,
    status: "completed",
    output: {
      type: "assistant_text",
      text: "最终正文",
      reasoning: { text: "补充后的思考内容" }
    }
  });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.equal(single.output.text, "最终正文");
  assert.deepEqual((single.output as any).reasoning, { text: "补充后的思考内容" });
  assert.equal((single.output as any).error, undefined);
});

test("assistant reasoning 不应进入 prompt-context", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 0,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "继续" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_reasoning_prompt",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "正式回答", reasoning: { text: "隐藏思考" } }
  });

  const prompt = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(JSON.stringify(prompt.messages).includes("正式回答"));
  assert.equal(JSON.stringify(prompt.messages).includes("隐藏思考"), false);
});

test("assistant reasoning 不应进入 archive line", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "用户消息" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_archive",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "正式回答", reasoning: { text: "不应归档的思考" } }
  });

  const clearRes = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/clear`, payload: { workspaceId: fixture.workspaceId, reason: "切换新任务" } });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);

  const archiveFilePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  const archiveText = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveText.includes("正式回答"));
  assert.equal(archiveText.includes("不应归档的思考"), false);
});

test("assistant failed item 会通过 output.error 返回错误且正文不混入 [run]", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_failed_assistant",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "failed",
    output: {
      type: "assistant_text",
      text: "半截回答",
      error: "model idle timeout after 30000ms"
    }
  });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.equal(single.output.text, "半截回答");
  assert.equal((single.output as any).error, "model idle timeout after 30000ms");
  assert.equal(single.output.text.includes("[run]"), false);
});

test("prompt-context 仅注入最近一次且无 tool item 的 failed assistant", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 0,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "继续" }
  });
  const failedAssistant = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_failed_prompt",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "failed",
    output: { type: "assistant_text", text: "半截输出", error: "provider error" }
  });

  const prompt = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(prompt.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("半截输出")));
  assert.equal(prompt.messages.some((m) => JSON.stringify(m.content).includes("provider error")), false);
  assert.equal(prompt.messages.some((m) => JSON.stringify(m.content).includes("[run]")), false);
  assert.ok(failedAssistant.item.id > 0);
});

test("非 system item 写入 boundaryReason 会被忽略", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const appended = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    boundaryReason: "should-not-be-stored",
    output: {
      type: "user_text",
      text: "hello"
    },
    createdAt: Date.now()
  });

  assert.equal(appended.boundaryReason, null);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items[0]?.kind, "user");
  assert.equal(context.items[0]?.boundaryReason, null);
});

test("agent cancel 仅终止执行并保留消息,活跃项标记为 cancelled", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: Date.now()
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "start"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "working..."
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "bash",
      args: {
        command: "sleep 10"
      }
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id,
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel run failed: ${cancelRes.body}`);
  const cancelBody = cancelRes.json() as { ok: boolean; session: { id: string; headItemId: number | null } };
  assert.equal(cancelBody.session.id, session.id);
  assert.equal(cancelBody.session.headItemId, toolItem.item.id);

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);
  assert.equal(runState.lastTerminalStatus, "cancelled");

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, toolItem.item.id);
  assert.equal(context.items.length, 3);
  const latestAssistant = context.items.find((item) => item.id === assistantItem.item.id);
  const latestTool = context.items.find((item) => item.id === toolItem.item.id);
  assert.equal(latestAssistant?.status, "cancelled");
  assert.equal(latestTool?.status, "cancelled");
});

test("agent cancel 会将 subtask 工具项明确改写为 cancelled 并保留 subtask_session_id + existing 提示", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const subtaskSessionId = "sess_subtask_cancelled_1";

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: Date.now()
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel_subtask",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "starting subtask..."
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel_subtask",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_cancel_subtask_1",
      args: {
        description: "研究问题",
        prompt: "请直接完成这个子任务",
        agentId: "default",
        session: { mode: "fork" }
      },
      text: `tool: subtask\nstatus: running\nsubtask_session_id: ${subtaskSessionId}\n\nSubtask started.`,
      result: {
        subtaskSessionId
      }
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id,
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel subtask run failed: ${cancelRes.body}`);

  const cancelledItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(cancelledItem.status, "cancelled");
  assert.equal(cancelledItem.output.type, "tool");

  const text = String((cancelledItem.output as { text?: string }).text || "");
  assert.equal(text.includes("tool: subtask"), true);
  assert.equal(text.includes("status: cancelled"), true);
  assert.equal(text.includes(`subtask_session_id: ${subtaskSessionId}`), true);
  assert.equal(text.includes('mode: "existing"'), true);
  assert.equal(text.includes(`sessionId: "${subtaskSessionId}"`), true);
});

test("run-complete(cancelled) 会收敛该 run 下的非终态 context items", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_run_complete_cancelled",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "partial streaming..."
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_run_complete_cancelled",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_run_complete_cancelled_subtask",
      args: { description: "研究问题", prompt: "...", agentId: "default", session: { mode: "new" } },
      text: "tool: subtask\nstatus: running\nsubtask_session_id: sess_sub_x\n\nSubtask started.",
      result: { subtaskSessionId: "sess_sub_x" }
    }
  });

  // Mark run-state as running, so completeRunFromWorker should settle it to idle.
  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id
  });

  const completeRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      status: "cancelled",
      updatedAt: createdAt + 123
    }
  });
  assert.equal(completeRes.statusCode, 200, `run-complete cancelled failed: ${completeRes.body}`);

  const runRecord = getRunRecord(fixture.db, runId);
  assert.equal(runRecord?.status, "cancelled");

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);

  const assistantAfter = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(assistantAfter.status, "cancelled");

  const toolAfter = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(toolAfter.status, "cancelled");
  assert.equal(toolAfter.output.type, "tool");
  const toolText = String((toolAfter.output as { text?: string }).text || "");
  assert.equal(toolText.includes("tool: subtask"), true);
  assert.equal(toolText.includes("status: cancelled"), true);
});

test("agent cancel 会收敛隐藏链上的未终态 items 与关联 run", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();

  const baseRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: baseRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt
  });

  const user1 = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: baseRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "第一问" }
  });
  const assistant1 = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: baseRunId,
    turnId: "turn_cancel_hidden_1",
    step: 1,
    prevId: user1.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "第一答" }
  });
  const user2 = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: baseRunId,
    turnId: null,
    step: null,
    prevId: assistant1.item.id,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "第二问" }
  });

  const hiddenRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: hiddenRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: user2.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: createdAt + 1
  });

  const hiddenAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: hiddenRunId,
    turnId: "turn_cancel_hidden_2",
    step: 1,
    prevId: user2.item.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "hidden working" },
    createdAt: createdAt + 2
  });
  const hiddenTool = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: hiddenRunId,
    turnId: "turn_cancel_hidden_2",
    step: 1,
    prevId: hiddenAssistant.id,
    kind: "tool",
    status: "running",
    output: { type: "tool", toolName: "bash", args: { command: "sleep 10" } } as any,
    createdAt: createdAt + 3
  });
  moveSessionHead(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    expectedHeadItemId: hiddenTool.id,
    nextHeadItemId: user2.item.id,
    updatedAt: createdAt + 4
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel hidden run failed: ${cancelRes.body}`);

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);
  assert.equal(runState.lastTerminalStatus, "cancelled");

  const hiddenAssistantAfter = getContextItemById(fixture.db, hiddenAssistant.id);
  const hiddenToolAfter = getContextItemById(fixture.db, hiddenTool.id);
  assert.equal(hiddenAssistantAfter?.status, "cancelled");
  assert.equal(hiddenToolAfter?.status, "cancelled");

  const hiddenRunAfter = getRunRecord(fixture.db, hiddenRunId);
  assert.equal(hiddenRunAfter?.status, "cancelled");

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, user2.item.id);
  assert.equal(context.items.map((item) => item.id).includes(hiddenAssistant.id), false);
  assert.equal(context.items.map((item) => item.id).includes(hiddenTool.id), false);
});

test("agent cancel 不应把仅因脏 non-terminal item 命中的 terminal run 改写为 cancelled", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();

  const terminalRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: terminalRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt
  });

  const user = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: terminalRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "可见消息" }
  });

  const dirtyAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: terminalRunId,
    turnId: "turn_cancel_terminal_run_dirty",
    step: 1,
    prevId: user.item.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "dirty hidden assistant" },
    createdAt: createdAt + 1
  });
  moveSessionHead(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    expectedHeadItemId: dirtyAssistant.id,
    nextHeadItemId: user.item.id,
    updatedAt: createdAt + 2
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel terminal run dirty item failed: ${cancelRes.body}`);

  const dirtyAssistantAfter = getContextItemById(fixture.db, dirtyAssistant.id);
  assert.equal(dirtyAssistantAfter?.status, "cancelled");

  const terminalRunAfter = getRunRecord(fixture.db, terminalRunId);
  assert.equal(terminalRunAfter?.status, "completed");
});

test("agent cancel 会基于当前 active run 的 subtask 结果精确级联取消活动 child，且不误取消历史 fork child", { concurrency: false }, async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const now = Date.now();

  const parent = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now
  });

  const parentAssistant = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    runId: parentRunId,
    turnId: "turn_parent_cancel_cascade",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "starting child" }
  });

  const staleForkChildId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: staleForkChildId,
    workspaceId: fixture.workspaceId,
    title: "stale-child",
    kind: "subtask",
    createdAt: now + 1,
    forkedFromSessionId: parent.id,
    forkedFromItemId: parentAssistant.item.id
  });
  const staleForkRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: staleForkRunId,
    workspaceId: fixture.workspaceId,
    sessionId: staleForkChildId,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now + 1
  });
  const staleForkAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: staleForkChildId,
    runId: staleForkRunId,
    turnId: "turn_stale_child",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "stale child still running" },
    createdAt: now + 1
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: staleForkChildId,
    status: "running",
    activeRunId: staleForkRunId,
    activeAssistantItemId: staleForkAssistant.id,
    runNoticeText: "",
    updatedAt: now + 1,
    appliedItemId: staleForkAssistant.id
  });

  const activeChildId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: activeChildId,
    workspaceId: fixture.workspaceId,
    title: "active-existing-child",
    kind: "subtask",
    createdAt: now + 2,
    forkedFromSessionId: newSortableId("sess"),
    forkedFromItemId: null
  });
  const activeChildRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: activeChildRunId,
    workspaceId: fixture.workspaceId,
    sessionId: activeChildId,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now + 2
  });
  const activeChildAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: activeChildId,
    runId: activeChildRunId,
    turnId: "turn_active_child",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "active child running" },
    createdAt: now + 2
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: activeChildId,
    status: "running",
    activeRunId: activeChildRunId,
    activeAssistantItemId: activeChildAssistant.id,
    runNoticeText: "",
    updatedAt: now + 2,
    appliedItemId: activeChildAssistant.id
  });

  const reusedCompletedChildId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: reusedCompletedChildId,
    workspaceId: fixture.workspaceId,
    title: "reused-completed-child",
    kind: "subtask",
    createdAt: now + 3,
    forkedFromSessionId: newSortableId("sess"),
    forkedFromItemId: null
  });
  const reusedCompletedChildRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: reusedCompletedChildRunId,
    workspaceId: fixture.workspaceId,
    sessionId: reusedCompletedChildId,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now + 3
  });
  const reusedCompletedChildAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: reusedCompletedChildId,
    runId: reusedCompletedChildRunId,
    turnId: "turn_reused_completed_child",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "reused child still running elsewhere" },
    createdAt: now + 3
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: reusedCompletedChildId,
    status: "running",
    activeRunId: reusedCompletedChildRunId,
    activeAssistantItemId: reusedCompletedChildAssistant.id,
    runNoticeText: "",
    updatedAt: now + 3,
    appliedItemId: reusedCompletedChildAssistant.id
  });

  const completedSubtaskItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    runId: parentRunId,
    turnId: "turn_parent_cancel_cascade_completed",
    step: 0,
    prevId: parentAssistant.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_parent_cancel_cascade_completed",
      args: { description: "old child", prompt: "finished", session: { mode: "existing", sessionId: reusedCompletedChildId } },
      text: `tool: subtask\nstatus: completed\nsubtask_session_id: ${reusedCompletedChildId}\n\nCompleted.`,
      result: { subtaskSessionId: reusedCompletedChildId }
    }
  });

  const activeSubtaskItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    runId: parentRunId,
    turnId: "turn_parent_cancel_cascade",
    step: 1,
    prevId: completedSubtaskItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_parent_cancel_cascade_1",
      args: { description: "reuse child", prompt: "continue child", session: { mode: "existing", sessionId: activeChildId } },
      text: `tool: subtask\nstatus: running\nsubtask_session_id: ${activeChildId}\n\nSubtask started.`,
      result: { subtaskSessionId: activeChildId }
    }
  });
  fixture.db.prepare(
    "update agent_run set parent_run_id = ?, parent_tool_item_id = ? where run_id = ?"
  ).run(parentRunId, activeSubtaskItem.item.id, activeChildRunId);

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: parentAssistant.item.id
  });

  // 窄测试观察 seam：本地 AgentRuntime 没有可替换的 runtime 注入点，
  // 仅在这个不可并发测试内观察 cancelSession，并在 finally 中恢复原型。
  const runtimeCancelSessionIds: string[] = [];
  const originalCancelSession = AgentRuntime.prototype.cancelSession;
  AgentRuntime.prototype.cancelSession = function observedCancelSession(sessionId: string) {
    runtimeCancelSessionIds.push(sessionId);
    return originalCancelSession.call(this, sessionId);
  };

  const cancelRes = await (async () => {
    try {
      return await fixture.app.inject({
        method: "POST",
        url: `/api/agent/sessions/${parent.id}/cancel`,
        payload: { workspaceId: fixture.workspaceId }
      });
    } finally {
      AgentRuntime.prototype.cancelSession = originalCancelSession;
    }
  })();
  assert.equal(cancelRes.statusCode, 200, `cancel cascade failed: ${cancelRes.body}`);
  assert.deepEqual(runtimeCancelSessionIds, [parent.id, activeChildId]);
  assert.equal(runtimeCancelSessionIds.filter((sessionId) => sessionId === parent.id).length, 1);
  assert.equal(runtimeCancelSessionIds.filter((sessionId) => sessionId === activeChildId).length, 1);
  assert.equal(runtimeCancelSessionIds.includes(staleForkChildId), false);
  assert.equal(runtimeCancelSessionIds.includes(reusedCompletedChildId), false);

  const parentState = await getRunState(fixture.app, parent.id);
  assert.equal(parentState.status, "idle");
  assert.equal(parentState.lastTerminalStatus, "cancelled");

  const activeChildState = await getRunState(fixture.app, activeChildId);
  assert.equal(activeChildState.status, "idle");
  assert.equal(activeChildState.lastTerminalStatus, "cancelled");

  const activeChildRun = getRunRecord(fixture.db, activeChildRunId);
  assert.equal(activeChildRun?.status, "cancelled");
  const activeChildAssistantAfter = getContextItemById(fixture.db, activeChildAssistant.id);
  assert.equal(activeChildAssistantAfter?.status, "cancelled");

  const staleForkState = await getRunState(fixture.app, staleForkChildId);
  assert.equal(staleForkState.status, "running");
  assert.equal(staleForkState.activeRunId, staleForkRunId);
  const staleForkRun = getRunRecord(fixture.db, staleForkRunId);
  assert.equal(staleForkRun?.status, "running");
  const staleForkAssistantAfter = getContextItemById(fixture.db, staleForkAssistant.id);
  assert.equal(staleForkAssistantAfter?.status, "streaming");

  const reusedCompletedChildState = await getRunState(fixture.app, reusedCompletedChildId);
  assert.equal(reusedCompletedChildState.status, "running");
  assert.equal(reusedCompletedChildState.activeRunId, reusedCompletedChildRunId);
  const reusedCompletedChildRun = getRunRecord(fixture.db, reusedCompletedChildRunId);
  assert.equal(reusedCompletedChildRun?.status, "running");
  const reusedCompletedChildAssistantAfter = getContextItemById(fixture.db, reusedCompletedChildAssistant.id);
  assert.equal(reusedCompletedChildAssistantAfter?.status, "streaming");
});

test("agent runtime settings maxSubtaskDepth 默认值、边界和非法更新", async () => {
  const fixture = await createFixture();

  const defaultRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(defaultRes.json().maxSubtaskDepth, 1);

  const minRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { maxSubtaskDepth: 1 }
  });
  assert.equal(minRes.statusCode, 200, minRes.body);
  assert.equal(minRes.json().maxSubtaskDepth, 1);

  const maxRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { maxSubtaskDepth: 5 }
  });
  assert.equal(maxRes.statusCode, 200, maxRes.body);
  assert.equal(maxRes.json().maxSubtaskDepth, 5);

  for (const invalid of [0, 6, -1, 1.5, "1", "5"]) {
    const invalidRes = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/runtime",
      payload: { maxSubtaskDepth: invalid }
    });
    assert.equal(invalidRes.statusCode, 400, invalidRes.body);
    assert.equal(invalidRes.json().code, "AGENT_MAX_SUBTASK_DEPTH_INVALID");
  }

  const unchangedRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(unchangedRes.statusCode, 200);
  assert.equal(unchangedRes.json().maxSubtaskDepth, 5);

  for (const corrupt of [0, 6, 1.5, "1", null]) {
    setSettingJson(fixture.db, "agent_runtime_v1", { maxSubtaskDepth: corrupt }, Date.now());
    const corruptRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
    assert.equal(corruptRes.statusCode, 200);
    assert.equal(corruptRes.json().maxSubtaskDepth, 1, `stored ${String(corrupt)} should fall back to default`);
  }
});

test("agent runtime settings 可通过 execution-profile 下发", async () => {
  const fixture = await createFixture();

  const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: {
      modelIdleTimeoutMs: 1234,
      modelTotalTimeoutMs: 5678,
      modelRequestMaxRetries: 4
    }
  });
  assert.equal(runtimeRes.statusCode, 200, `update agent runtime settings failed: ${runtimeRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_runtime_settings"
  });

  const runRecord = getRunRecord(fixture.db, msg.runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, null, "missing uiLocale should be stored as null");

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: msg.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get execution profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.runtime?.modelIdleTimeoutMs, 1234);
  assert.equal(profile.runtime?.modelTotalTimeoutMs, 5678);
  assert.equal(profile.runtime?.modelRequestMaxRetries, 4);
  assert.equal(typeof profile.runtime?.autoCompactThresholdPct, "number");
  assert.equal(typeof profile.model?.contextWindowTokens, "number");
  assert.equal(profile.provider?.options?.apiMode, "responses");
  assert.equal(profile.compaction, null);
});

test("agent runtime compactionModel 支持保存、下发、清空和引用保护", async () => {
  const fixture = await createFixture();

  const providers = [
    {
      id: "ppchat",
      name: "ppchat",
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
      models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }]
    },
    {
      id: "compaction-provider",
      name: "Compaction Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.invalid/v1", apiKey: "sk-compaction" },
      models: [{ id: "compact-model", name: "Compact Model", contextWindowTokens: 32000 }]
    }
  ];

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: { default: null, providers }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const emptyRuntimeRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(emptyRuntimeRes.statusCode, 200);
  assert.equal(emptyRuntimeRes.json().compactionModel, null);

  const invalidRuntimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "missing-model" } }
  });
  assert.equal(invalidRuntimeRes.statusCode, 400);
  assert.equal(invalidRuntimeRes.json().code, "AGENT_MODEL_NOT_FOUND");

  const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "compact-model" } }
  });
  assert.equal(runtimeRes.statusCode, 200, `update runtime settings failed: ${runtimeRes.body}`);
  assert.deepEqual(runtimeRes.json().compactionModel, {
    providerId: "compaction-provider",
    modelId: "compact-model"
  });

  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_runtime_compaction_model"
  });
  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(profileRes.statusCode, 200, `get execution profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.model?.id, "gpt-5.2");
  assert.equal(profile.compaction?.source, "runtime_compaction");
  assert.equal(profile.compaction?.provider?.id, "compaction-provider");
  assert.equal(profile.compaction?.model?.id, "compact-model");

  const clearRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: null }
  });
  assert.equal(clearRes.statusCode, 200);
  assert.equal(clearRes.json().compactionModel, null);

  const profileAfterClearRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(profileAfterClearRes.statusCode, 200);
  assert.equal(profileAfterClearRes.json().compaction, null);

  const setAgainRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "compact-model" } }
  });
  assert.equal(setAgainRes.statusCode, 200);

  const clearCompactionApiKeyRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: null,
      providers: providers.map((provider) => provider.id === "compaction-provider"
        ? { ...provider, options: { ...provider.options, apiKey: null } }
        : provider)
    }
  });
  assert.equal(clearCompactionApiKeyRes.statusCode, 200, `clear compaction apiKey failed: ${clearCompactionApiKeyRes.body}`);

  const profileWithoutCompactionKeyRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(profileWithoutCompactionKeyRes.statusCode, 200, `get execution profile without compaction key failed: ${profileWithoutCompactionKeyRes.body}`);
  assert.equal(profileWithoutCompactionKeyRes.json().model?.id, "gpt-5.2");
  assert.equal(profileWithoutCompactionKeyRes.json().compaction, null);

  const removeReferencedProviderRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: { default: null, providers: [providers[0]] }
  });
  assert.equal(removeReferencedProviderRes.statusCode, 409);
  assert.equal(removeReferencedProviderRes.json().code, "AGENT_PROVIDER_MODEL_RENAME_REFERENCED");

  const renameReferencedModelRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: null,
      providers: providers.map((provider) => provider.id === "compaction-provider"
        ? { ...provider, models: [{ id: "compact-model-v2", name: "Compact Model v2", contextWindowTokens: 32000 }] }
        : provider)
    }
  });
  assert.equal(renameReferencedModelRes.statusCode, 409);
  assert.equal(renameReferencedModelRes.json().code, "AGENT_PROVIDER_MODEL_RENAME_REFERENCED");
});

test("openai provider apiMode 会在 settings 与 execution-profile/single-call profile 中透传", async () => {
  const fixture = await createFixture();

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat",
            apiMode: "chatCompletions"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        },
        {
          id: "anthropic_provider",
          name: "anthropic_provider",
          npm: "@ai-sdk/anthropic",
          options: {
            baseURL: "https://api.anthropic.com/v1",
            apiKey: "sk-anthropic",
            // 非 openai provider 上送该字段也应被忽略。
            apiMode: "chatCompletions"
          },
          models: [
            {
              id: "claude-sonnet",
              name: "claude-sonnet",
              contextWindowTokens: 200000
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `update providers failed: ${providersRes.body}`);

  const getProvidersRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/providers" });
  assert.equal(getProvidersRes.statusCode, 200, `get providers failed: ${getProvidersRes.body}`);
  const providersBody = getProvidersRes.json() as any;
  const openaiProvider = providersBody.providers.find((item: any) => item.id === "compat_openai");
  const anthropicProvider = providersBody.providers.find((item: any) => item.id === "anthropic_provider");
  assert.equal(openaiProvider?.options?.apiMode, "chatCompletions");
  assert.equal(anthropicProvider?.options?.apiMode, undefined);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "compat_openai", modelId: "deepseek-v3" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_provider_api_mode"
  });

  const executionProfileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: msg.runId
    }
  });
  assert.equal(executionProfileRes.statusCode, 200, `get execution profile failed: ${executionProfileRes.body}`);
  const executionProfile = executionProfileRes.json() as any;
  assert.equal(executionProfile.provider?.id, "compat_openai");
  assert.equal(executionProfile.provider?.options?.apiMode, "chatCompletions");

  const singleCallProfileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/single-call-model-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: msg.runId
    }
  });
  assert.equal(singleCallProfileRes.statusCode, 200, `get single-call model profile failed: ${singleCallProfileRes.body}`);
  const singleCallProfile = singleCallProfileRes.json() as any;
  assert.equal(singleCallProfile.provider?.id, "compat_openai");
  assert.equal(singleCallProfile.provider?.options?.apiMode, "chatCompletions");

  const invalidModeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat",
            apiMode: "invalid-mode"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });

  assert.equal(invalidModeRes.statusCode, 400, `update provider with invalid apiMode should fail: ${invalidModeRes.body}`);
  const invalidModeBody = invalidModeRes.json() as any;
  assert.equal(typeof invalidModeBody?.message, "string");

  const keepModeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });
  assert.equal(keepModeRes.statusCode, 200, `update provider without apiMode failed: ${keepModeRes.body}`);
  const keepModeBody = keepModeRes.json() as any;
  const keepModeProvider = keepModeBody.providers.find((item: any) => item.id === "compat_openai");
  assert.equal(keepModeProvider?.options?.apiMode, "chatCompletions");
});

test("subtask session 的 execution-profile 按 subtask surface 校验", async () => {
  const fixture = await createFixture();

  const settingsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "subtask-agent",
          name: "subtask-agent",
          summary: "",
          prompt: "You are a subtask specialist.",
          tools: ["bash", "read"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "subtask",
          order: 0
        }
      ]
    }
  });
  assert.equal(settingsRes.statusCode, 200, `update agent settings failed: ${settingsRes.body}`);

  const session = createSubtaskSessionForTest(fixture, { title: "subtask-profile" });

  const createdAt = Date.now();
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "subtask-agent",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt
  });

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId }
  });
  assert.equal(profileRes.statusCode, 200, `get subtask execution profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.agent?.id, "subtask-agent");
});

test("run 创建后若 agent scope 改为不允许, execution-profile 会返回明确错误", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const sent = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_scope_changed_after_run"
  });

  const updateRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "subtask",
          order: 0
        }
      ]
    }
  });
  assert.equal(updateRes.statusCode, 200, `update agent settings failed: ${updateRes.body}`);

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: sent.runId }
  });
  assert.equal(profileRes.statusCode, 400, `execution profile should reject changed scope: ${profileRes.body}`);
  assert.equal(profileRes.json().code, "AGENT_SCOPE_NOT_ALLOWED");
});

test("agent prompt-context 根据 run uiLocale 注入语言与时间运行时约束", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: {
      workspaceId: fixture.workspaceId,
      text: "hello",
      clientRequestId: "req_locale_prompt",
      uiLocale: "en-US"
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  const body = res.json() as { runId: string };

  const runRecord = getRunRecord(fixture.db, body.runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, "en-US");

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: body.runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(prompt.system.includes("[output_format_instructions]"), "system should include output format instructions section");
  assert.ok(prompt.system.includes("[runtime_constraints]"), "system should include runtime constraints section");
  assert.equal(prompt.system.includes("## Runtime Constraints"), false, "system should not include legacy runtime constraints heading");
  assert.ok(outputSection.includes("Output format requirements:"));
  assert.ok(runtimeSection.includes("Language requirement: use English consistently for this run."));
  assert.ok(runtimeSection.includes("If you call todolist, the goal and todos[].content must also be in English."));
  assert.equal(runtimeSection.includes("Current system time:"), false);
  assert.equal(runtimeSection.includes("Time zone:"), false);
  assert.equal(outputSection.includes("Completion constraints:"), false, "output format instructions should not contain completion constraints");
});

test("agent prompt-context 在 zh-CN locale 下使用中文 output/runtime sections 且完成判定约束只在 runtime_constraints 中", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(outputSection.includes("输出格式要求："));
  assert.ok(runtimeSection.includes("语言要求：本轮对话请统一使用简体中文。"));
  assert.equal(runtimeSection.includes("当前系统时间："), false);
  assert.equal(runtimeSection.includes("当前时区："), false);
  assert.equal(outputSection.includes("完成判定约束："), false, "output format instructions should not contain completion constraints");
});

test("agent prompt-context 在缺省 locale 下使用 locale-neutral 英文 output/runtime sections 且不附加语言要求", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_locale_null_prompt"
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: msg.runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(outputSection.includes("Output format requirements:"));
  assert.equal(runtimeSection.includes("Current system time:"), false);
  assert.equal(runtimeSection.includes("Time zone:"), false);
  assert.equal(runtimeSection.includes("Language requirement: use English consistently for this run."), false, "null locale should not add English language requirement");
  assert.equal(outputSection.includes("输出格式要求："), false, "null locale should not mix Chinese output instruction text");
});

test("agent prompt-context 对 store 中非法 uiLocale 回退为 locale-neutral 英文，避免中英混用", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "fr-FR" as any,
    status: "running",
    createdAt: Date.now()
  });

  const runRecord = getRunRecord(fixture.db, runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, null, "run mapper should fail closed for invalid locale data");

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(outputSection.includes("Output format requirements:"));
  assert.equal(outputSection.includes("输出格式要求："), false, "invalid locale fallback should not use Chinese output text");
  assert.equal(runtimeSection.includes("语言要求：本轮对话请统一使用简体中文。"), false, "invalid locale fallback should not use Chinese runtime text");
});

test("agent prompt-context 在当前 run uiLocale 为空时回退到当前 session 最近 run 的 uiLocale", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now() - 20_000
  });
  const targetRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: targetRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt: Date.now() - 10_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "completed",
    createdAt: Date.now()
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: targetRunId
  });
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.equal(prompt.uiLocale, "en-US");
  assert.ok(runtimeSection.includes("Language requirement: use English consistently for this run."));
});

test("agent prompt-context 在当前 session 无可用 locale 时回退到全局最近 run 的 uiLocale", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const targetSession = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);

  const targetRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: targetRunId,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt: Date.now() - 20_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now()
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    runId: targetRunId
  });
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.equal(prompt.uiLocale, "zh-CN");
  assert.ok(runtimeSection.includes("语言要求：本轮对话请统一使用简体中文。"));
});

test("agent compact 在 worker 不可用时仍接受 uiLocale 参数", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/compact`, payload: { workspaceId: fixture.workspaceId, clientRequestId: "req_compact_locale", uiLocale: "zh-CN" } });
  assert.equal(res.statusCode, 503, `compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});

test("agent compact 在 worker 不可用时返回 503", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: newSortableId("req")
    }
  });
  assert.equal(res.statusCode, 503, `compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});

test("internal compact 需要 internal token", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/internal/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "req_internal_compact_unauthorized"
    }
  });
  assert.equal(res.statusCode, 401, `internal compact should require token: ${res.body}`);
});

test("internal compact 在 worker 不可用时返回 503", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/internal/agent/sessions/${session.id}/compact`,
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "req_internal_compact_worker_unavailable",
      uiLocale: "zh-CN"
    }
  });
  assert.equal(res.statusCode, 503, `internal compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});

test("agent clear 会归档当前可见上下文并插入 clear 边界 marker", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "旧任务: 先完成接口改造"
    }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "旧任务答复: 可以先做字段迁移。"
    }
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId,
      reason: "切换新任务",
      uiLocale: "zh-CN"
    }
  });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);
  const clearBody = clearRes.json() as { ok: boolean; session: { id: string; headItemId: number | null } };
  assert.equal(clearBody.session.id, session.id);
  assert.ok((clearBody.session.headItemId ?? 0) > assistantItem.item.id);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items.length, 3);
  assert.equal(context.items[0]?.archiveAt == null, false);
  assert.equal(context.items[1]?.archiveAt == null, false);
  assert.equal(context.items[2]?.kind, "system");
  assert.equal(context.items[2]?.boundaryReason, "clear");
  assert.equal(context.items[2]?.archiveAt, null);
  assert.ok(String(context.items[2]?.output?.text || "").includes("archive_search"));

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: clearBody.session.headItemId || context.items[2]!.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const oldUserLeak = promptContext.messages.find((item) => String(item.content || "").includes("旧任务: 先完成接口改造"));
  assert.equal(oldUserLeak, undefined);
  const clearSummary = promptContext.messages.find((item) => item.role === "system" && String(item.content || "").includes("已开始新任务"));
  assert.ok(clearSummary);

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveContent.includes("旧任务: 先完成接口改造"));
  assert.ok(archiveContent.includes("旧任务答复: 可以先做字段迁移。"));

  const clearAgainRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearAgainRes.statusCode, 400, `clear should be no-op when only marker visible: ${clearAgainRes.body}`);
  assert.equal(clearAgainRes.json().code, "AGENT_CLEAR_NOT_NEEDED");
});

test("agent clear 在 en-US locale 下生成英文摘要，且缺省 locale 回退英文", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "old task" }
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId,
      reason: "switch task",
      uiLocale: "en-US"
    }
  });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);

  const context = await getContextItems(fixture.app, session.id);
  assert.ok(String(context.items.at(-1)?.output?.text || "").includes("A new task has started (switch task)."));

  const session2 = await createSession(fixture.app, fixture.workspaceId);
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session2.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "another old task" }
  });
  const clearRes2 = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session2.id}/clear`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(clearRes2.statusCode, 200, `clear session without locale failed: ${clearRes2.body}`);
  const context2 = await getContextItems(fixture.app, session2.id);
  assert.ok(String(context2.items.at(-1)?.output?.text || "").includes("A new task has started."));
});

test("subtask 会话的 send、compact、clear 保持只读且不修改状态", async () => {
  const fixture = await createFixture();
  const subtaskSession = createSubtaskSessionForTest(fixture);
  const beforeState = await getRunState(fixture.app, subtaskSession.id);
  const beforeHead = (await getContextItems(fixture.app, subtaskSession.id)).headItemId;

  const sendRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/messages`,
    payload: {
      workspaceId: fixture.workspaceId,
      text: "must remain read-only",
      clientRequestId: "subtask-readonly-send"
    }
  });
  assert.equal(sendRes.statusCode, 400, `send subtask should fail: ${sendRes.body}`);
  assert.equal(sendRes.json().code, "AGENT_SUBTASK_READONLY");

  const compactRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "subtask-readonly-compact"
    }
  });
  assert.equal(compactRes.statusCode, 400, `compact subtask should fail: ${compactRes.body}`);
  assert.equal(compactRes.json().code, "AGENT_SUBTASK_READONLY");

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 400, `clear subtask should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_SUBTASK_READONLY");
  assert.equal((await getContextItems(fixture.app, subtaskSession.id)).headItemId, beforeHead);
  assert.deepEqual(await getRunState(fixture.app, subtaskSession.id), beforeState);
  const runCount = fixture.db.prepare("select count(*) as count from agent_run where session_id = ?").get(subtaskSession.id) as { count: number };
  assert.equal(runCount.count, 0);
});

test("agent prompt-context 在 depth 达到上限时隐藏 subtask 工具", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const session = createSubtaskSessionForTest(fixture);

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    subtaskDepth: 1,
    status: "running",
    createdAt: Date.now()
  });

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const toolNames = promptContext.tools.map((item) => item.name);
  assert.equal(toolNames.includes("subtask"), false, "subtask tool should be hidden at the configured depth limit");
  assert.equal(toolNames.includes("bash"), true, "other enabled tools should remain visible");
});

test("agent prompt-context 在 depth=1、max=2 的 subtask run 中保留 subtask 工具", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const settingsRes = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 2 } });
  assert.equal(settingsRes.statusCode, 200, settingsRes.body);
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "",
        tools: ["bash", "subtask"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agentsRes.statusCode, 200, agentsRes.body);
  const session = createSubtaskSessionForTest(fixture, { title: "nested" });
  const sessionId = session.id;
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 1,
    parentRunId: newSortableId("run"),
    parentToolItemId: 1,
    status: "running",
    createdAt: Date.now()
  });
  const context = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId, runId });
  assert.equal(context.tools.some((item) => item.name === "subtask"), true);
});

test("agent subtask fork 在复制历史与子任务 prompt 之间插入 system 提示", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请调用 subtask 把任务交给另一个 agent。"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "我会调用工具处理这个任务。"
    }
  });

  const readToolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "read",
      toolCallId: "call_subtask_read",
      args: { filePath: "README.md" },
      text: "tool: read\nstatus: completed\n\nREADME snippet"
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: readToolItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_subtask_fork",
      args: {
        description: "研究问题",
        prompt: "请直接完成这个子任务",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const startRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId: parentRunId,
      parentToolItemId: toolItem.item.id,
      description: "研究问题",
      prompt: "请直接完成这个子任务",
      agentId: "default",
      session: { mode: "fork" }
    }
  });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string; runId: string; agentName: string };
  assert.equal(started.agentName, "default");


  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length >= 3, true, "forked subtask session should contain copied user, system guard and prompt user");

  const copiedUser = items[0];
  const systemItem = items[1];
  const promptUser = items[2];
  assert.equal(items.some((item) => item.id !== copiedUser?.id && item.kind === "assistant"), false, "forked subtask session should not copy the triggering assistant turn");
  assert.equal(items.some((item) => item.kind === "tool"), false, "forked subtask session should not copy tool items from the triggering turn");
  assert.equal(copiedUser?.kind, "user");
  assert.equal(copiedUser?.output.type, "user_text");
  assert.equal((copiedUser?.output as { text?: string }).text, "请调用 subtask 把任务交给另一个 agent。");
  assert.equal(systemItem?.kind, "system");
  assert.equal(systemItem?.output.type, "system_text");
  assert.equal(
    String((systemItem?.output as { text?: string }).text || "").includes("All history before this system message was copied from the parent session"),
    true
  );
  assert.equal(promptUser?.kind, "user");
  assert.equal(promptUser?.output.type, "user_text");
  assert.equal((promptUser?.output as { text?: string }).text, "请直接完成这个子任务");

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: started.sessionId,
    runId: started.runId
  });
  assert.equal(
    promptContext.messages.some((message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("All history before this system message was copied from the parent session")
    ),
    true
  );
  assert.equal(promptContext.uiLocale, "en-US");
  assert.equal(
    promptContext.tools.some((tool) => tool.name === "subtask"),
    false,
    "forked subtask session should not expose subtask tool"
  );
  assert.ok(promptContext.system.includes("[runtime_constraints]"));
  assert.equal(promptContext.system.includes("## Runtime Constraints"), false);
  assert.ok(promptContext.system.includes("Language requirement: use English consistently for this run."));
  assert.equal(promptContext.system.includes("Current system time:"), false);
  assert.equal(promptContext.system.includes("Time zone:"), false);
});

test("subtask start with preforkSummaryText should inject summary->guard->prompt without copying parent history", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSessionRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "parent-prefork" }
  });
  assert.equal(parentSessionRes.statusCode, 201, `create parent session failed: ${parentSessionRes.body}`);
  const parentSession = parentSessionRes.json() as { id: string };

  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "this is parent history that must not be copied"
    }
  });
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const parentAssistant = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork",
    step: 1,
    prevId: parentUser.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "prepare subtask"
    }
  });

  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork",
    step: 1,
    prevId: parentAssistant.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 200000,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: subtaskTool.item.id
  });

  const startRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
       session: { mode: "fork" },
       preforkSummaryText: "prefork summary",
       preforkMeta: {
         thresholdPct: 95,
         parentLastResponseTotalTokens: 200000,
         childContextWindowTokens: 128000,
         extra: true
       }
    }
  });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string };

  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length, 3, "prefork path should only inject summary/guard/prompt items");
  assert.equal(items[0]?.kind, "system");
  assert.equal((items[0]?.output as { text?: string } | undefined)?.text, "prefork summary");
  assert.equal(items[1]?.kind, "system");
  assert.equal(String((items[1]?.output as { text?: string } | undefined)?.text || "").includes("All history before this system message was copied from the parent session"), true);
  assert.equal(items[2]?.kind, "user");
  assert.equal((items[2]?.output as { text?: string } | undefined)?.text, "please do prefork task");
  assert.equal(items.some((item) => item.kind === "user" && (item.output as { text?: string }).text === "this is parent history that must not be copied"), false);
});

test("subtask start should reject preforkSummaryText when mode=new/existing", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare prefork mode reject" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_mode_reject",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_mode_reject",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const modeNewRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "new" },
      preforkSummaryText: "prefork summary"
    }
  });
  assert.equal(modeNewRes.statusCode, 400);
  assert.equal((modeNewRes.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_NOT_ALLOWED");

  const existingSession = createSubtaskSessionForTest(fixture, { title: "existing-subtask" });

  const modeExistingRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "existing", sessionId: existingSession.id },
      preforkSummaryText: "prefork summary"
    }
  });
  assert.equal(modeExistingRes.statusCode, 400);
  assert.equal((modeExistingRes.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_NOT_ALLOWED");
});

test("subtask start should reject too long preforkSummaryText", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare prefork too long" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_too_long",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_too_long",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const tooLongSummary = "x".repeat(20_001);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "fork" },
      preforkSummaryText: tooLongSummary
    }
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_SUMMARY_TOO_LONG");
});

test("subtask start should allow description length 50 and silently truncate >50", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare description length boundary" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_description_boundary",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_description_boundary",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const maxAllowedDescription = "d".repeat(50);
  const basePayload = {
    workspaceId: fixture.workspaceId,
    parentSessionId: parentSession.id,
    parentRunId,
    parentToolItemId: subtaskTool.item.id,
    prompt: "please do subtask with max allowed description length",
    agentId: "default",
    session: { mode: "fork" as const }
  };
  const acceptedRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { ...basePayload, description: maxAllowedDescription }
  });
  assert.equal(acceptedRes.statusCode, 200, `description length 50 should be accepted: ${acceptedRes.body}`);
  const acceptedBody = acceptedRes.json() as { sessionId: string };
  const acceptedSession = getAgentSession(fixture.db, acceptedBody.sessionId);
  assert.equal(acceptedSession?.title, `${maxAllowedDescription} (fork)`);

  const tooLongDescription = `  ${"d".repeat(51)}  `;
  const truncatedDescription = "d".repeat(50);
  const truncatedRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { ...basePayload, description: tooLongDescription }
  });
  assert.equal(truncatedRes.statusCode, 200, `description length 51 should be accepted and truncated: ${truncatedRes.body}`);
  const truncatedBody = truncatedRes.json() as { sessionId: string };
  const truncatedSession = getAgentSession(fixture.db, truncatedBody.sessionId);
  assert.equal(truncatedSession?.title, `${truncatedDescription} (fork)`);
});

test("subtask start should reject mismatched preforkMeta", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare prefork meta mismatch" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_meta_mismatch",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_meta_mismatch",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const updatedAt = Date.now();
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 200000,
    runNoticeText: "",
    updatedAt,
    appliedItemId: subtaskTool.item.id
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "fork" },
      preforkSummaryText: "prefork summary",
      preforkMeta: { thresholdPct: 95, parentLastResponseTotalTokens: 199999, childContextWindowTokens: 128000 }
    }
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_META_MISMATCH");
});

test("subtask prefork-plan should use default threshold and return correct shouldPrefork", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSessionRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "parent-prefork-plan" }
  });
  assert.equal(parentSessionRes.statusCode, 201, `create parent session failed: ${parentSessionRes.body}`);
  const parentSession = parentSessionRes.json() as { id: string };

  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "prefork-plan parent user"
    }
  });
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_plan",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_plan",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const shouldNotPreforkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default"
    }
  });
  assert.equal(shouldNotPreforkRes.statusCode, 200, `prefork-plan failed: ${shouldNotPreforkRes.body}`);
  const shouldNotPreforkBody = shouldNotPreforkRes.json() as {
    shouldPrefork: boolean;
    thresholdPct: number;
    parentLastResponseTotalTokens: number | null;
    childContextWindowTokens: number;
    thresholdTokens: number;
  };
  assert.equal(shouldNotPreforkBody.thresholdPct, 95);
  assert.equal(shouldNotPreforkBody.childContextWindowTokens, 128000);
  assert.equal(shouldNotPreforkBody.thresholdTokens, 121600);
  assert.equal(shouldNotPreforkBody.parentLastResponseTotalTokens, null);
  assert.equal(shouldNotPreforkBody.shouldPrefork, false);

  const updatedAt = Date.now();
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 200000,
    runNoticeText: "",
    updatedAt,
    appliedItemId: subtaskTool.item.id
  });

  const shouldPreforkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default"
    }
  });
  assert.equal(shouldPreforkRes.statusCode, 200, `prefork-plan failed: ${shouldPreforkRes.body}`);
  const shouldPreforkBody = shouldPreforkRes.json() as {
    shouldPrefork: boolean;
    parentLastResponseTotalTokens: number | null;
  };
  assert.equal(shouldPreforkBody.parentLastResponseTotalTokens, 200000);
  assert.equal(shouldPreforkBody.shouldPrefork, true);

  await configureAgentDefaults(fixture.app, 1);
  const minimumPlanRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, parentSessionId: parentSession.id, parentRunId, parentToolItemId: subtaskTool.item.id, agentId: "default", thresholdPct: 50 }
  });
  assert.equal(minimumPlanRes.statusCode, 200, minimumPlanRes.body);
  assert.deepEqual(minimumPlanRes.json(), { shouldPrefork: true, thresholdPct: 50, parentLastResponseTotalTokens: 200000, childContextWindowTokens: 1, thresholdTokens: 1 });
});

test("subtask prefork-plan should reject invalid thresholdPct", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_plan_invalid",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_plan_invalid",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default",
      thresholdPct: 49
    }
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID");
});

test("agent subtask fork 对父 run 非法 locale 做归一化回退，避免继续传播非法值", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "fr-FR" as any,
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_invalid_locale",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "subtask", toolCallId: "call_subtask_invalid_locale", args: { description: "研究问题", prompt: "请直接完成这个子任务", agentId: "default", session: { mode: "fork" } } }
  });
  const startRes = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" }, payload: { workspaceId: fixture.workspaceId, parentSessionId: parentSession.id, parentRunId, parentToolItemId: toolItem.item.id, description: "研究问题", prompt: "请直接完成这个子任务", agentId: "default", session: { mode: "fork" } } });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string; runId: string };
  const subtaskRun = getRunRecord(fixture.db, started.runId);
  assert.equal(subtaskRun?.uiLocale, null);
  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  const guardItem = items.find((item) => item.kind === "system" && item.output.type === "system_text");
  assert.ok(guardItem);
  assert.equal(String((guardItem?.output as { text?: string } | undefined)?.text || "").includes("You are working in a subtask session derived from a parent session."), true);
});

test("subtask 失败时 getSubtaskRunResultFromWorker 仍返回 partial text", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = createSubtaskSessionForTest(fixture, { title: "it-subtask-result" });
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "failed",
    createdAt
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_subtask_failed_partial",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "failed",
    output: {
      type: "assistant_text",
      text: "partial result from subtask",
      error: "failed after 3 retries: timeout"
    }
  });

  const resultRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId
    }
  });
  assert.equal(resultRes.statusCode, 200, `get subtask result failed: ${resultRes.body}`);
  assert.equal((resultRes.json() as { resultText: string }).resultText, "partial result from subtask");
});

test("subtask result follows assistant, then system, then empty fallback and status exposes all terminal states", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const createRun = async (status: "running" | "completed" | "failed" | "cancelled", suffix: string) => {
    const session = await createSession(fixture.app, fixture.workspaceId);
    const runId = newSortableId(`run-${suffix}`);
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status,
      createdAt: Date.now()
    });
    return { session, runId };
  };

  for (const status of ["running", "completed", "failed", "cancelled"] as const) {
    const current = await createRun(status, status);
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/subtask/status",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId, sessionId: current.session.id, runId: current.runId }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status });
  }

  const assistantPreferred = await createRun("completed", "assistant-preferred");
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: assistantPreferred.session.id,
    runId: assistantPreferred.runId,
    turnId: "turn_result_priority",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "assistant result" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: assistantPreferred.session.id,
    runId: assistantPreferred.runId,
    turnId: "turn_result_priority",
    step: 2,
    prevId: assistantItem.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "system fallback" }
  });
  const assistantResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: assistantPreferred.session.id, runId: assistantPreferred.runId }
  });
  assert.equal(assistantResult.statusCode, 200);
  assert.deepEqual(assistantResult.json(), { resultText: "assistant result" });

  const systemOnly = await createRun("completed", "system-only");
  const olderSystem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: systemOnly.session.id,
    runId: systemOnly.runId,
    turnId: "turn_result_system",
    step: 1,
    prevId: null,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "system result" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: systemOnly.session.id,
    runId: systemOnly.runId,
    turnId: "turn_result_system",
    step: 2,
    prevId: olderSystem.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "   " }
  });
  const systemResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: systemOnly.session.id, runId: systemOnly.runId }
  });
  assert.deepEqual(systemResult.json(), { resultText: "system result" });

  const allBlankSystem = await createRun("completed", "all-blank-system");
  const blankSystem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: allBlankSystem.session.id,
    runId: allBlankSystem.runId,
    turnId: "turn_result_all_blank_system",
    step: 1,
    prevId: null,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: allBlankSystem.session.id,
    runId: allBlankSystem.runId,
    turnId: "turn_result_all_blank_system",
    step: 2,
    prevId: blankSystem.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "\t  " }
  });
  const allBlankSystemResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: allBlankSystem.session.id, runId: allBlankSystem.runId }
  });
  assert.deepEqual(allBlankSystemResult.json(), { resultText: "" });

  const blankAssistantWithSystem = await createRun("completed", "blank-assistant-system");
  const blankAssistant = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: blankAssistantWithSystem.session.id,
    runId: blankAssistantWithSystem.runId,
    turnId: "turn_result_blank_assistant_system",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "  " }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: blankAssistantWithSystem.session.id,
    runId: blankAssistantWithSystem.runId,
    turnId: "turn_result_blank_assistant_system",
    step: 2,
    prevId: blankAssistant.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "system after blank assistant" }
  });
  const blankAssistantResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: blankAssistantWithSystem.session.id, runId: blankAssistantWithSystem.runId }
  });
  assert.deepEqual(blankAssistantResult.json(), { resultText: "system after blank assistant" });

  const empty = await createRun("running", "empty");
  const emptyResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: empty.session.id, runId: empty.runId }
  });
  assert.deepEqual(emptyResult.json(), { resultText: "" });
});

test("failed tool item 可保留 subtask partial result 且 error 不混入 partial 文本", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_failed_subtask_tool",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "failed",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_failed_subtask_tool",
      args: { description: "研究问题" },
      text: "tool: subtask\nstatus: failed\n\nsubtask failed",
      result: {
        subtaskSessionId: "sess_subtask_failed",
        resultText: "partial result from subtask"
      },
      error: "subtask failed"
    }
  });

  const single = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(single.output.type, "tool");
  assert.equal(single.status, "failed");
  assert.equal(String(single.output.error || ""), "subtask failed");
  assert.equal(String(single.output.text || "").includes("partial result from subtask"), false);
  assert.equal(
    String((((single.output.result as { resultText?: string } | undefined)?.resultText) || "")),
    "partial result from subtask"
  );
});

test("agent prompt-context 对 primary 会话保留 subtask 工具", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const primarySession = await createSession(fixture.app, fixture.workspaceId);
  const seedRunId = newSortableId("run");
  const seedUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: primarySession.id,
    runId: seedRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "primary 会话内容" }
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: primarySession.id,
      fromItemId: seedUser.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkRes.statusCode, 201, `fork primary session failed: ${forkRes.body}`);
  const forkedPrimary = forkRes.json() as { id: string };

  for (const sessionId of [primarySession.id, forkedPrimary.id]) {
    const runId = newSortableId("run");
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: 0,
      status: "running",
      createdAt: Date.now()
    });
    const promptContext = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId,
      runId
    });
    assert.equal(promptContext.tools.some((tool) => tool.name === "subtask"), true, "primary session should keep subtask tool");
  }
});

test("delete workspace 会清理 dataDir 下的 agent 归档目录", async () => {
  const fixture = await createFixture();
  const archiveSessionPath = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, "sess_cleanup");
  const archiveWorkspacePath = path.dirname(archiveSessionPath);
  await fs.mkdir(archiveSessionPath, { recursive: true });
  await fs.writeFile(path.join(archiveSessionPath, "00000001.log"), "line\n", "utf-8");

  const deleteRes = await fixture.app.inject({
    method: "DELETE",
    url: `/api/workspaces/${fixture.workspaceId}`
  });
  assert.equal(deleteRes.statusCode, 204, `delete workspace failed: ${deleteRes.body}`);

  const archiveWorkspaceExists = await fs
    .stat(archiveWorkspacePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(archiveWorkspaceExists, false, "workspace archive directory should be removed");
});

test("agent clear 在空会话返回 AGENT_CLEAR_EMPTY", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 400, `clear empty session should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_CLEAR_EMPTY");
});

test("agent clear 在会话运行中返回 AGENT_CLEAR_NOT_IDLE", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试 clear 运行中校验"
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: newSortableId("run"),
    activeAssistantItemId: null,
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 409, `clear running session should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_CLEAR_NOT_IDLE");
});

test("agent revert 在会话运行中返回 AGENT_REVERT_NOT_IDLE", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: Date.now()
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试运行中禁止回退"
    }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_revert_running",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "working..."
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id,
  });

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertRes.statusCode, 409, `revert running session should fail: ${revertRes.body}`);
  assert.equal(revertRes.json().code, "AGENT_REVERT_NOT_IDLE");

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, assistantItem.item.id);
  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "running");
  assert.equal(runState.activeRunId, runId);
});

test("agent revert 在 idle 且存在非终态残留 item 时返回 AGENT_REVERT_HAS_NON_TERMINAL_ITEMS", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试 idle 下非终态残留禁止回退"
    }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_revert_dirty",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "残留中的输出"
    }
  });

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertRes.statusCode, 409, `revert dirty idle session should fail: ${revertRes.body}`);
  assert.equal(revertRes.json().code, "AGENT_REVERT_HAS_NON_TERMINAL_ITEMS");
});

test("agent revert 在 idle 时可回退到可见 item 并隐藏后续分支", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "问题A"
    }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_revert_success",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "答复A"
    }
  });
  const trailingUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: assistantItem.item.id,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "问题B"
    }
  });

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: assistantItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertRes.statusCode, 200, `revert visible item should succeed: ${revertRes.body}`);
  const revertBody = revertRes.json() as { ok: boolean; session: { id: string; headItemId: number | null } };
  assert.equal(revertBody.session.id, session.id);
  assert.equal(revertBody.session.headItemId, assistantItem.item.id);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, assistantItem.item.id);
  assert.deepEqual(context.items.map((item) => item.id), [userItem.item.id, assistantItem.item.id]);
  assert.equal(context.items.some((item) => item.id === trailingUser.item.id), false);
});

test("agent clear 并发请求会串行执行且不会重复归档", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userText = "并发清空测试-用户消息";
  const assistantText = "并发清空测试-助手消息";
  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: userText
    }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: assistantText
    }
  });

  const [r1, r2] = await Promise.all([
    fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/clear`,
      payload: { workspaceId: fixture.workspaceId }
    }),
    fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/clear`,
      payload: { workspaceId: fixture.workspaceId }
    })
  ]);

  const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 400]);
  const failed = r1.statusCode === 400 ? r1 : r2;
  assert.equal(failed.json().code, "AGENT_CLEAR_NOT_NEEDED");

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  const userHits = archiveContent.split(userText).length - 1;
  const assistantHits = archiveContent.split(assistantText).length - 1;
  assert.equal(userHits, 1);
  assert.equal(assistantHits, 1);
});

test("agent providers settings 要求 contextWindowTokens 必填且合法", async () => {
  const fixture = await createFixture();

  const missingFieldRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "ppchat",
        modelId: "gpt-5.2"
      },
      providers: [
        {
          id: "ppchat",
          name: "ppchat",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-test"
          },
          models: [
            {
              id: "gpt-5.2",
              name: "gpt-5.2"
            }
          ]
        }
      ]
    }
  });
  assert.equal(missingFieldRes.statusCode, 400);

  const tooLargeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "ppchat",
        modelId: "gpt-5.2"
      },
      providers: [
        {
          id: "ppchat",
          name: "ppchat",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-test"
          },
          models: [
            {
              id: "gpt-5.2",
              name: "gpt-5.2",
              contextWindowTokens: 10000001
            }
          ]
        }
      ]
    }
  });
  assert.equal(tooLargeRes.statusCode, 400);
});

test("run-state 支持 runNoticeText 更新与 idle 自动清空", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "Request failed, retrying in 2s (1/3): timeout"
  });

  const runningState = await getRunState(fixture.app, session.id);
  assert.equal(runningState.status, "running");
  assert.equal(runningState.runNoticeText, "Request failed, retrying in 2s (1/3): timeout");

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
  });

  const idleState = await getRunState(fixture.app, session.id);
  assert.equal(idleState.status, "idle");
  assert.equal(idleState.runNoticeText, "");
  assert.equal(idleState.lastTerminalStatus, null);
});

test("run-state 返回最近一次终态 run 结果", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;
  const createdAt = Date.now();
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "completed",
    createdAt
  });
  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: createdAt
  });

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.lastTerminalStatus, "completed");
});

test("run-state 不应把旧 terminal run 误认为当前这次 idle 的终态", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;
  const createdAt = Date.now();
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "completed",
    createdAt
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: createdAt + 1000
  });

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.lastTerminalStatus, null);
});

test("internal sessions/status-summary 返回 run 摘要（elapsed/contextWindowTokens/ratio）", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;

  const runId = newSortableId("run");
  const createdAt = Date.now() - 1500;
  const updatedAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 64000,
    runNoticeText: "",
    updatedAt,
    appliedItemId: 0
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      sessionId: session.id,
      // Compatibility: use `agentId` as documented.
      agentId: "default"
    }
  });
  assert.equal(res.statusCode, 200, `status-summary failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.session?.id, session.id);
  assert.equal(body.session?.workspaceId, fixture.workspaceId);
  assert.equal(body.agent?.id, "default");
  assert.equal(body.agent?.name, "default");
  assert.equal(body.runState?.status, "running");
  assert.equal(body.runState?.activeRunId, runId);
  assert.equal(body.runState?.lastResponseTotalTokens, 64000);
  // Compatibility: runState.terminalStatus alias
  assert.equal(body.runState?.contextWindowTokens, 128000);
  assert.ok(Math.abs((body.runState?.contextTokenRatio ?? 0) - 0.5) < 1e-9);
  assert.equal(body.runState?.terminalStatus, body.runState?.lastTerminalStatus);
  assert.equal(body.startedAt, createdAt);
  assert.equal(body.contextWindowTokens, 128000);
  assert.equal(body.contextWindowTokens, body.runState?.contextWindowTokens);
  assert.ok(Math.abs(body.contextTokenRatio - 0.5) < 1e-9);
  assert.equal(body.contextTokenRatio, body.runState?.contextTokenRatio);
  assert.ok(typeof body.elapsedMs === "number" && body.elapsedMs >= 0);

  {
    // Precedence: selectedAgentId wins when both are provided.
    const resPreferSelected = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/sessions/status-summary",
      headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
      payload: { sessionId: session.id, agentId: "missing", selectedAgentId: "default" }
    });
    assert.equal(resPreferSelected.statusCode, 200);
    const prefer = resPreferSelected.json() as any;
    assert.equal(prefer.agent?.id, "default");
  }

  // updatedAt should be stable across calls (generatedAt changes)
  const updatedAt1 = body.updatedAt;
  const generatedAt1 = body.generatedAt;
  await sleep(10);
  const res2 = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: session.id, agentId: "default" }
  });
  assert.equal(res2.statusCode, 200);
  const body2 = res2.json() as any;
  assert.equal(body2.updatedAt, updatedAt1);
  assert.ok(typeof body2.generatedAt === "number" && body2.generatedAt >= generatedAt1);

  const resNoAgent = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      sessionId: session.id
    }
  });
  assert.equal(resNoAgent.statusCode, 200, `status-summary(no agent) failed: ${resNoAgent.body}`);
  const bodyNoAgent = resNoAgent.json() as any;
  assert.equal(bodyNoAgent.agent, null);
  assert.equal(bodyNoAgent.contextWindowTokens, bodyNoAgent.runState?.contextWindowTokens ?? null);
  assert.equal(bodyNoAgent.contextTokenRatio, bodyNoAgent.runState?.contextTokenRatio ?? null);
});

test("internal channels/allowlist/check 命中 allowlist 时返回 allowed=true 与 role", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken,
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(res.statusCode, 200, `allowlist check failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.allowed, true);
  assert.equal(body.role, "user");
  assert.equal(body.reason, undefined);
});

test("internal channels/allowlist/check 未命中 allowlist 时返回 allowed=false 与 reason", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken,
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_unknown"
    }
  });
  assert.equal(res.statusCode, 200, `allowlist check failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.allowed, false);
  assert.equal(body.role, undefined);
  assert.equal(body.reason, "sender is not allowed");
});

test("internal channels/allowlist/check 缺失或错误 internal token 返回 401", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const noTokenRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(noTokenRes.statusCode, 401);

  const badTokenRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": "bad-token",
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(badTokenRes.statusCode, 401);
});

test("internal channels/allowlist/check plugin caller mismatch 返回 401", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken,
      "x-awb-plugin-id": "not-feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "PLUGIN_CALLER_MISMATCH");
});

test("internal sessions/status-summary 需要 internal token 且 sessionId 必须存在", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const noTokenRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    payload: { sessionId: "sess_missing" }
  });
  assert.equal(noTokenRes.statusCode, 401);

  const notFoundRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: "sess_missing" }
  });
  assert.equal(notFoundRes.statusCode, 404);
  assert.equal(notFoundRes.json().code, "SESSION_NOT_FOUND");

  const agentNotFoundRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: "sess_missing", selectedAgentId: "agent_missing" }
  });
  // sessionId missing still dominates; ensure agent not found is covered in another test
  assert.equal(agentNotFoundRes.statusCode, 404);
});

test("internal sessions/status-summary sessionId 为空白时返回 400 + SESSION_ID_REQUIRED", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: "   " }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "SESSION_ID_REQUIRED");
});

test("internal sessions/status-summary agent 不存在时返回 400 + AGENT_NOT_FOUND", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: session.id, agentId: "agent_missing" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "AGENT_NOT_FOUND");
});

test("internal agents/list 传入非法 surface 返回 400", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/agents/list",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { workspaceId: fixture.workspaceId, surface: "subtask" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(String((res.json() as { message?: string }).message || "").toLowerCase().includes("surface"), true);
});

test("subtask prefork-plan 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);
  setSettingJson(
    fixture.db,
    "workspace_agent_enablement_v1",
    {
      workspaces: {
        [fixture.workspaceId]: {
          mode: "subset",
          enabledAgentIds: [],
          updatedAt: Date.now()
        }
      }
    },
    Date.now()
  );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt: Date.now()
  });
  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId,
    turnId: "turn_prefork_no_agent_enabled",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "subtask", toolCallId: "call_prefork_no_agent_enabled", args: { description: "do task", prompt: "do task", agentId: "default", session: { mode: "fork" } } }
  });

  const planRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId: runId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default"
    }
  });
  assert.equal(planRes.statusCode, 400);
  assert.equal((planRes.json() as { code?: string }).code, "AGENT_DISABLED_IN_WORKSPACE");
});

test("internal sessions/context-items-tail 返回尾部上下文项", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const user1 = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_tail_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "hello 1" }
  });
  const assistant2 = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_tail_1",
    step: 2,
    prevId: user1.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "hello 2" }
  });
  const tool3 = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_tail_1",
    step: 3,
    prevId: assistant2.item.id,
    kind: "tool",
    status: "completed",
    output: { type: "tool", toolName: "todolist", result: { goal: "x", todos: [] } }
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "feishu", sessionId: session.id, tailLimit: 2 }
  });
  assert.equal(res.statusCode, 200, `context-items-tail failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.sessionId, session.id);
  assert.equal(Array.isArray(body.items), true);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0]?.id, assistant2.item.id);
  assert.equal(body.items[1]?.id, tool3.item.id);
});

test("internal sessions/context-items-tail sessionId 为空白时返回 400 + SESSION_ID_REQUIRED", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "feishu", sessionId: "   ", tailLimit: 1 }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "SESSION_ID_REQUIRED");
});

test("internal sessions/context-items-tail 缺少 x-awb-plugin-id 时返回 400 + PLUGIN_ID_REQUIRED", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { pluginId: "feishu", sessionId: session.id, tailLimit: 1 }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "PLUGIN_ID_REQUIRED");
});

test("internal sessions/context-items-tail 缺少 body.pluginId 时返回 400 + PLUGIN_ID_REQUIRED", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: session.id, tailLimit: 1 }
  });

  assert.equal(res.statusCode, 400);
  assert.ok(typeof res.json().message === "string" && res.json().message.length > 0);
});

test("internal sessions/context-items-tail header/body pluginId 不一致时返回 401 + PLUGIN_ID_MISMATCH", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "slack", sessionId: session.id, tailLimit: 1 }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "PLUGIN_ID_MISMATCH");
});

test("single-call model profile 使用 agent 显式默认模型", async () => {
  const fixture = await createFixture();

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "global_provider",
        modelId: "global_model"
      },
      providers: [
        {
          id: "global_provider",
          name: "global_provider",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-global"
          },
          models: [
            {
              id: "global_model",
              name: "global_model",
              contextWindowTokens: 128000
            }
          ]
        },
        {
          id: "agent_provider",
          name: "agent_provider",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-agent"
          },
          models: [
            {
              id: "agent_model",
              name: "agent_model",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: {
            providerId: "agent_provider",
            modelId: "agent_model"
          },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const sent = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_single_call_model_profile"
  });

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/single-call-model-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: sent.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get single-call model profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.resolved?.source, "agent_default");
  assert.equal(profile.provider?.id, "agent_provider");
  assert.equal(profile.model?.id, "agent_model");
});

test("agent context 压缩后会归档并支持 archive_search/read", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    uiLocale: "en-US",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "历史问题: 请整理最近的变更"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "已完成: 新增归档与压缩方案草稿"
    }
  });

  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: assistantItem.item.id,
    summaryText: "压缩摘要: 已归档旧上下文,后续从本摘要继续。"
  });
  assert.equal(compact.compacted, true);
  assert.equal(compact.archivedCount, 2);
  assert.ok((compact.summaryItemId ?? 0) > 0);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items.length, 3, "transcript should keep archived items visible in UI");
  assert.equal(context.items[0]?.archiveAt == null, false);
  assert.equal(context.items[1]?.archiveAt == null, false);
  assert.equal(context.items[2]?.kind, "system");
  assert.equal(context.items[2]?.boundaryReason, "compaction");
  assert.ok(String(context.items[2]?.output?.text || "").includes("压缩摘要"));

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const compactSummaryMessage = promptContext.messages.find(
    (item) => item.role === "system" && String(item.content || "").includes("压缩摘要")
  );
  assert.ok(compactSummaryMessage, "compaction summary should participate in prompt messages");

  const summaryIndex = promptContext.messages.findIndex(
    (item) => item.role === "system" && String(item.content || "").includes("压缩摘要")
  );
  const snippetIndex = promptContext.messages.findIndex(
    (item) => item.role === "system" && (String(item.content || "").includes("压缩前尾部摘录") || String(item.content || "").includes("Pre-compaction tail excerpt"))
  );
  assert.ok(snippetIndex >= 0, "compaction snippet should be injected after summary");
  assert.ok(summaryIndex >= 0 && snippetIndex === summaryIndex + 1, "snippet should appear right after compaction summary");

  const snippetMessage = promptContext.messages[snippetIndex] as any;
  assert.ok(String(snippetMessage?.content || "").includes("pos="), "snippet should include pos lines");
  assert.ok(String(snippetMessage?.content || "").includes("archive_read"), "snippet should remind archive_read");
  const archivedUserLeak = promptContext.messages.find(
    (item) => item.role === "user" && String(item.content || "").includes("历史问题")
  );
  assert.equal(archivedUserLeak, undefined, "archived transcript items should not be included in model prompt");

  const forkArchivedVisibleOnlyRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: userItem.item.id,
      mode: "visible_only"
    }
  });
  assert.equal(
    forkArchivedVisibleOnlyRes.statusCode,
    400,
    `fork archived item in visible_only mode should fail: ${forkArchivedVisibleOnlyRes.body}`
  );
  assert.equal(forkArchivedVisibleOnlyRes.json().code, "AGENT_ARCHIVED_ITEM_IMMUTABLE");

  const summaryItemId = context.items[2]?.id ?? 0;
  assert.ok(summaryItemId > 0);

  const forkSystemRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: summaryItemId,
      mode: "with_archive"
    }
  });
  assert.equal(forkSystemRes.statusCode, 400, `fork from system should fail: ${forkSystemRes.body}`);
  assert.equal(forkSystemRes.json().code, "AGENT_FORK_ITEM_KIND_INVALID");

  const afterSummaryUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_2",
    step: 1,
    prevId: summaryItemId,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "后续问题: 这个方案需要怎么落地?"
    }
  });

  const afterSummaryAssistant = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_2",
    step: 1,
    prevId: afterSummaryUser.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "后续答复: 先做字段与路由改造,再补充测试。"
    }
  });

  const forkArchivedWithArchiveRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: userItem.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkArchivedWithArchiveRes.statusCode, 201, `fork archived item in with_archive mode should succeed: ${forkArchivedWithArchiveRes.body}`);
  const forkArchivedWithArchiveSession = forkArchivedWithArchiveRes.json() as { id: string };
  const forkArchivedWithArchiveContext = await getContextItems(fixture.app, forkArchivedWithArchiveSession.id);
  assert.equal(forkArchivedWithArchiveContext.items.length, 1);
  assert.equal(forkArchivedWithArchiveContext.items[0]?.archiveAt, null);

  const forkWithArchiveRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: afterSummaryAssistant.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkWithArchiveRes.statusCode, 201, `fork with archive should succeed: ${forkWithArchiveRes.body}`);
  const forkWithArchiveSession = forkWithArchiveRes.json() as { id: string };
  const forkWithArchiveContext = await getContextItems(fixture.app, forkWithArchiveSession.id);
  assert.equal(forkWithArchiveContext.items.length, 5);
  assert.equal(forkWithArchiveContext.items[0]?.archiveAt == null, false);
  assert.equal(forkWithArchiveContext.items[1]?.archiveAt == null, false);
  assert.equal(forkWithArchiveContext.items[2]?.kind, "system");
  assert.equal(forkWithArchiveContext.items[3]?.kind, "user");
  assert.equal(forkWithArchiveContext.items[4]?.kind, "assistant");

  const forkArchiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, forkWithArchiveSession.id),
    "00000001.log"
  );
  const forkArchiveContent = await fs.readFile(forkArchiveFilePath, "utf-8");
  assert.ok(forkArchiveContent.includes("历史问题"));
  assert.ok(forkArchiveContent.includes("新增归档与压缩方案草稿"));

  const revertArchivedRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertArchivedRes.statusCode, 400, `revert archived item should fail: ${revertArchivedRes.body}`);
  assert.equal(revertArchivedRes.json().code, "AGENT_ARCHIVED_ITEM_IMMUTABLE");

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveContent.includes("历史问题"));
  assert.ok(archiveContent.includes("新增归档与压缩方案草稿"));

  const forkRollbackFixture = await createFixture({
    agentWorkerConcurrency: 0,
    agentTestFaults: {
      archiveWrite: {
        failAfterChunks: 1
      }
    }
  });
  const forkRollbackSession = await createSession(forkRollbackFixture.app, forkRollbackFixture.workspaceId);
  const forkRunId = newSortableId("run");
  const archivedUser = await createContextItemInternal({
    app: forkRollbackFixture.app,
    internalToken: forkRollbackFixture.internalToken,
    workspaceId: forkRollbackFixture.workspaceId,
    sessionId: forkRollbackSession.id,
    runId: forkRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "需要被归档复制的历史问题" }
  });
  await createContextItemInternal({
    app: forkRollbackFixture.app,
    internalToken: forkRollbackFixture.internalToken,
    workspaceId: forkRollbackFixture.workspaceId,
    sessionId: forkRollbackSession.id,
    runId: forkRunId,
    turnId: "turn_fork_archive_fail",
    step: 1,
    prevId: archivedUser.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "需要被归档复制的历史回答" }
  });
  const clearRollbackRes = await forkRollbackFixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${forkRollbackSession.id}/clear`,
    payload: { workspaceId: forkRollbackFixture.workspaceId, reason: "触发归档" }
  });
  assert.equal(clearRollbackRes.statusCode, 200, `clear rollback session failed: ${clearRollbackRes.body}`);

  const liveUser = await createContextItemInternal({
    app: forkRollbackFixture.app,
    internalToken: forkRollbackFixture.internalToken,
    workspaceId: forkRollbackFixture.workspaceId,
    sessionId: forkRollbackSession.id,
    runId: forkRunId,
    turnId: null,
    step: null,
    prevId: clearRollbackRes.json().session.headItemId,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "新的可见问题" }
  });

  const sessionsBefore = forkRollbackFixture.db.prepare(`select count(*) as c from agent_session where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  const itemsBefore = forkRollbackFixture.db.prepare(`select count(*) as c from agent_context_item where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  const forkFailRes = await forkRollbackFixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: forkRollbackSession.id, fromItemId: liveUser.item.id, mode: "with_archive" }
  });
  assert.equal(forkFailRes.statusCode, 500, `fork with archive failure should bubble: ${forkFailRes.body}`);
  assert.equal(forkFailRes.json().code, "AGENT_FORK_ARCHIVE_FAILED");

  const sessionsAfter = forkRollbackFixture.db.prepare(`select count(*) as c from agent_session where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  const itemsAfter = forkRollbackFixture.db.prepare(`select count(*) as c from agent_context_item where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  assert.equal(sessionsAfter.c, sessionsBefore.c, "failed fork should not leave a new session row behind");
  assert.equal(itemsAfter.c, itemsBefore.c, "failed fork should not leave cloned context items behind");

  const forkChildren = forkRollbackFixture.db.prepare(`select id from agent_session where workspace_id = ? and forked_from_session_id = ?`).all(forkRollbackFixture.workspaceId, forkRollbackSession.id) as Array<{ id: string }>;
  assert.equal(forkChildren.length, 0, "failed fork should not leave fork child sessions behind");
  const archiveEntries = await fs.readdir(path.join(forkRollbackFixture.dataDir, "agent", "archive", forkRollbackFixture.workspaceId)).catch(() => [] as string[]);
  assert.deepEqual(archiveEntries, [forkRollbackSession.id], "failed fork should not leave archive dir for forked session behind");

  const search = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "归档"
  });
  const searchLines = search.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(searchLines.length >= 1);
  assert.ok(/^pos=\d+ \| /.test(searchLines[0] || ""), "search output should include pos prefix");

  const searchPage1 = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "item=",
    maxHits: 1
  });
  const searchPage1Line = searchPage1.text.trim();
  assert.ok(searchPage1Line.length > 0);
  const searchPage1PosMatch = /^pos=(\d+) \| /.exec(searchPage1Line);
  assert.ok(searchPage1PosMatch, "search page 1 should include pos prefix");
  const searchPage1Pos = Number(searchPage1PosMatch?.[1] || "0");
  assert.ok(searchPage1Pos > 0);

  const searchPage2 = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "item=",
    maxHits: 1,
    beforePos: searchPage1Pos
  });
  const searchPage2Line = searchPage2.text.trim();
  const searchPage2PosMatch = /^pos=(\d+) \| /.exec(searchPage2Line);
  assert.ok(searchPage2PosMatch, "search page 2 should include pos prefix");
  const searchPage2Pos = Number(searchPage2PosMatch?.[1] || "0");
  assert.ok(searchPage2Pos > 0 && searchPage2Pos < searchPage1Pos, "beforePos should continue to older hits");

  const optionLikeQuery = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "--glob"
  });
  assert.equal(typeof optionLikeQuery.text, "string");

  const readLatest = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 5
  });
  const readLatestLines = readLatest.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(readLatestLines.length >= 2);
  const latestFirstPos = Number(/^pos=(\d+) \| /.exec(readLatestLines[0] || "")?.[1] || "0");
  const latestSecondPos = Number(/^pos=(\d+) \| /.exec(readLatestLines[1] || "")?.[1] || "0");
  assert.ok(latestFirstPos > 0 && latestSecondPos > latestFirstPos, "read should be old->new order");

  const readOlder = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    beforePos: latestSecondPos,
    lineCount: 5
  });
  const readOlderLine = readOlder.text.trim();
  const readOlderPos = Number(/^pos=(\d+) \| /.exec(readOlderLine)?.[1] || "0");
  assert.ok(readOlderPos > 0 && readOlderPos < latestSecondPos, "archive_read.beforePos should only return older lines");

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: afterSummaryAssistant.item.id,
    kind: "system",
    status: "completed",
    output: {
      type: "system_text",
      text: "[run] max steps exceeded"
    }
  });

  const promptContextAfterRunSystem = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const leakedRunSystemMessage = promptContextAfterRunSystem.messages.find(
    (item) => item.role === "system" && String(item.content || "").includes("[run] max steps exceeded")
  );
  assert.equal(leakedRunSystemMessage, undefined, "runtime run-status system text should not leak into model prompt");
});

test("agent prompt-context 未发生 compaction 时不应注入 compaction snippet", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_nocompact_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "hi"
    }
  });
  assert.ok(userItem.item.id > 0);

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.equal(
    context.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")),
    false
  );
});

test("agent prompt-context compaction snippet 缓存缺失时应即时重建", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compact_cache_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "历史问题: cache miss"
    }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compact_cache_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "ok"
    }
  });

  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: assistantItem.item.id,
    summaryText: "压缩摘要: cache test"
  });
  assert.equal(compact.compacted, true);
  assert.ok((compact.summaryItemId ?? 0) > 0);
  const summaryItemId = compact.summaryItemId as number;

  // 首次调用触发生成并写入缓存.
  const ctx1 = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(ctx1.messages.some((m) => m.role === "system" && String(m.content || "").includes("Pre-compaction tail excerpt")));

  const cachePath = compactionSnippetPath(fixture.dataDir, fixture.workspaceId, session.id, summaryItemId);
  await fs.rm(cachePath, { force: true });

  // 删除缓存后再次调用,应即时重建并注入.
  const ctx2 = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(ctx2.messages.some((m) => m.role === "system" && String(m.content || "").includes("Pre-compaction tail excerpt")));
});

test("compaction snippet 在 zh-CN locale 下保持中文提示", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "旧上下文" }
  });
  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: userItem.item.id,
    summaryText: "压缩摘要"
  });
  assert.equal(compact.compacted, true);
  const ctx = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(ctx.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")));
});

test("archive v2 边界行为: 校验/大小写/跨文件pos/截断/半行过滤", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  await fs.mkdir(archiveDir, { recursive: true });

  const file1Lines = Array.from({ length: 100 }, (_, idx) => {
    const n = idx + 1;
    const tail = n === 100 ? "BoundaryToken" : `line-${n}`;
    return `item=${n} ts=${n} kind=user status=completed tool=- | ${tail}`;
  });
  const longText = `LONG-${"x".repeat(1300)}`;
  const file2Line1 = `item=101 ts=101 kind=assistant status=completed tool=- | ${longText}`;
  const file2PartialLine = "item=102 ts=102 kind=assistant status=completed tool=- | PartialOnlyToken";

  await fs.writeFile(path.join(archiveDir, "00000001.log"), `${file1Lines.join("\n")}\n`, "utf-8");
  await fs.writeFile(path.join(archiveDir, "00000002.log"), `${file2Line1}\n${file2PartialLine}`, "utf-8");

  const invalidBeforePosRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/search",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      query: "token",
      beforePos: 1
    }
  });
  assert.equal(invalidBeforePosRes.statusCode, 400, "beforePos<2 should be rejected");

  const caseInsensitiveSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "boundarytoken",
    maxHits: 1
  });
  assert.ok(caseInsensitiveSearch.text.startsWith("pos=100 |"), "search should be case-insensitive and return pos=100");

  const readLatest = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 1
  });
  assert.ok(readLatest.text.startsWith("pos=101 |"), "latest line should come from file2 line1 with pos=101");

  const readOlder = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    beforePos: 101,
    lineCount: 1
  });
  assert.ok(readOlder.text.startsWith("pos=100 |"), "beforePos should read strictly older line across file boundary");

  const halfLineSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "PartialOnlyToken"
  });
  assert.equal(halfLineSearch.text.trim(), "", "search should ignore unfinished last line without trailing newline");

  const truncatedRead = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 1,
    maxChars: 1000
  });
  assert.ok(truncatedRead.text.startsWith("pos=101 |"), "truncated output should keep pos prefix");
  assert.ok(
    truncatedRead.text.includes("[超过最大字符数限制,从此处截断内容]"),
    "truncated output should include truncation marker"
  );
});

test("archive_search snippet 模式返回命中窗口并限制单行窗口数量", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  await fs.mkdir(archiveDir, { recursive: true });

  const repeatedText = `${Array.from({ length: 7 }, (_, idx) => `seg${idx + 1}-${"x".repeat(140)} KEYWORD`).join(" ")} TAILMARK`;
  const line = `item=1 ts=1 kind=user status=completed tool=- | ${repeatedText}`;
  await fs.writeFile(path.join(archiveDir, "00000001.log"), `${line}\n`, "utf-8");

  const fullLineSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "keyword",
    maxHits: 1
  });
  const fullLineOutput = fullLineSearch.text.trim();
  assert.ok(fullLineOutput.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));
  assert.equal((fullLineOutput.match(/KEYWORD/g) || []).length, 7, "default search should keep full line by default");

  const regexZeroWidth = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "\\b",
    regex: true,
    maxHits: 1
  });
  assert.ok(regexZeroWidth.text.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));

  const regexZeroWidthSnippet = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "$",
    regex: true,
    maxHits: 1,
    snippet: true
  });
  assert.ok(regexZeroWidthSnippet.text.includes("TAILMARK"), "snippet+regex zero-width should include tail window");

  const snippetSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "keyword",
    maxHits: 1,
    snippet: true
  });
  const snippetOutput = snippetSearch.text.trim();
  assert.ok(snippetOutput.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));
  const keywordCount = (snippetOutput.match(/KEYWORD/g) || []).length;
  assert.ok(keywordCount > 0, "snippet search should include keyword windows");
  assert.ok(keywordCount <= 5, "snippet mode should cap windows per line to 5");
  assert.ok(snippetOutput.includes("..."), "snippet mode should include omission marker between windows");
});

test("agent prompt-context 使用结构化 tool-call/tool-result 消息", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试结构化工具调用"
    }
  });

  const assistantToolCall = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_structured",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "我先写文件"
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_structured",
    step: 1,
    prevId: assistantToolCall.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "tool_test.txt",
        content: "hello"
      },
      result: {
        summary: "Wrote file tool_test.txt",
        content: "ok"
      }
    }
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_after",
    step: 2,
    prevId: toolItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "写入成功,准备继续"
    }
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-call";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include tool-call part");

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-result";
    });
  });
  assert.ok(toolResultMessage, "tool message should include tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string }).type === "tool-result";
      })
    : null;
  assert.ok(toolResultPart && typeof toolResultPart === "object", "tool-result part should exist");
  assert.equal(
    String((toolResultPart as { output?: { type?: string } }).output?.type || ""),
    "text",
    "tool-result output should be ai-sdk structured output"
  );
});

test("agent prompt-context 对 apply_patch 保留 patchText 输入,并使用文本结果", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请应用补丁"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "开始应用补丁"
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: {
        patchText: "*** Begin Patch\n*** Update File: foo.ts\n@@\n-console.log('a')\n+console.log('b')\n*** End Patch"
      },
      text: "apply_patch queued"
    }
  });

  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: {
        patchText: "*** Begin Patch\n*** Update File: foo.ts\n@@\n-console.log('a')\n+console.log('b')\n*** End Patch"
      },
      result: {
        text: "Success. Updated the following files:\nM foo.ts",
        summary: {
          fileCount: 1,
          additions: 1,
          deletions: 1
        },
        files: [
          {
            type: "update",
            path: "foo.ts",
            before: "console.log('a')\n",
            after: "console.log('b')\n",
            additions: 1,
            deletions: 1
          }
        ]
      },
      text: "Success. Updated the following files:\nM foo.ts"
    }
  });

  const storedTool = await getContextItem(fixture.app, session.id, toolItem.item.id);
  const storedResult = (storedTool.output?.result ?? {}) as Record<string, unknown>;
  const storedFiles = Array.isArray(storedResult.files) ? storedResult.files : [];
  const first = (storedFiles[0] ?? {}) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(first, "before"), false, "DB apply_patch result should strip before");
  assert.equal(Object.prototype.hasOwnProperty.call(first, "after"), false, "DB apply_patch result should strip after");

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/apply-patch-artifact`
  });
  assert.equal(artifactRes.statusCode, 200, `apply_patch artifact fetch failed: ${artifactRes.body}`);
  const artifact = artifactRes.json() as { files?: Array<Record<string, unknown>> };
  const artifactFiles = Array.isArray(artifact.files) ? artifact.files : [];
  const artifactFirst = artifactFiles[0] ?? {};
  assert.equal(typeof artifactFirst.before, "string");
  assert.equal(typeof artifactFirst.after, "string");

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-call";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "apply_patch";
      })
    : null;
  assert.ok(toolCallPart && typeof toolCallPart === "object", "apply_patch tool-call should exist");
  assert.equal(
    typeof (toolCallPart as { input?: { patchText?: unknown } }).input?.patchText,
    "string",
    "apply_patch tool-call input should keep patchText"
  );

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "apply_patch";
    });
  });
  assert.ok(toolResultMessage, "tool message should include apply_patch tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-result" &&
          (part as { toolName?: string }).toolName === "apply_patch";
      })
    : null;
  assert.ok(toolResultPart && typeof toolResultPart === "object", "apply_patch tool-result part should exist");

  const output = (toolResultPart as { output?: { type?: string; value?: string } }).output;
  assert.equal(String(output?.type || ""), "text");
  assert.equal(String(output?.value || "").includes("Success. Updated the following files"), true);
});

test("agent prompt-context 支持 todolist 工具输入输出", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请维护任务清单"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "更新任务清单"
    }
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_1",
      args: {
        goal: "完成 todolist goal 增强与展示",
        todos: [
          { content: "梳理需求", status: "completed" },
          { content: "实现功能", status: "in_progress" }
        ]
      },
      result: {
        goal: "完成 todolist goal 增强与展示",
        summary: {
          total: 2,
          pending: 0,
          inProgress: 1,
          completed: 1,
          cancelled: 0
        },
        todos: [
          { content: "梳理需求", status: "completed" },
          { content: "实现功能", status: "in_progress" }
        ]
      },
      text: "Todo list updated: total=2"
    }
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "todolist";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include todolist tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "todolist";
      })
    : null;
  const input = (toolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(String(input.goal || ""), "完成 todolist goal 增强与展示");
  assert.equal(Array.isArray(input.todos), true, "todolist tool-call input should include todos");

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "todolist";
    });
  });
  assert.ok(toolResultMessage, "tool message should include todolist tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-result" &&
          (part as { toolName?: string }).toolName === "todolist";
      })
    : null;
  const output = (toolResultPart as { output?: { type?: string; value?: string } } | null)?.output;
  assert.equal(String(output?.type || ""), "text", "todolist tool-result output should be text");
  assert.equal(String(output?.value || "").includes("Todo list updated"), true, "todolist tool-result should be summary text");

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, "完成 todolist goal 增强与展示");
});

test("agent prompt-context: todolist goal 超长时自动截断并更新 session title", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const longGoal = "这是一个非常长的 todolist goal，用来验证超过五十个字符后会被自动截断而不是直接报错失败，需要继续追加更多文字";
  const normalizedGoal = "这是一个非常长的 todolist goal，用来验证超过五十个字符后会被自动截断而不是直接报错失…";
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "请维护任务清单" }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_truncate",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "更新任务清单" }
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_truncate",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_goal_truncate",
      args: { goal: longGoal, todos: [{ content: "实现功能", status: "in_progress" }] },
      result: { goal: longGoal, summary: { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 }, todos: [{ content: "实现功能", status: "in_progress" }] }
    }
  });

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, normalizedGoal);
});

test("agent prompt-context: todolist goal 为空白时不更新 session title", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", status: "running", createdAt
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_blank",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_goal_blank",
      args: { goal: "   ", todos: [{ content: "实现功能", status: "in_progress" }] },
      result: { goal: "   ", summary: { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 }, todos: [{ content: "实现功能", status: "in_progress" }] }
    }
  });

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, "it-session");
});

test("agent internal: 禁止 append completed apply_patch(必须走 update 写 artifact)", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: null,
      turnId: null,
      step: null,
      prevId: null,
      kind: "tool",
      status: "completed",
      output: {
        type: "tool",
        toolName: "apply_patch",
        toolCallId: "call_apply_patch_1",
        args: { patchText: "*** Begin Patch\n*** End Patch" },
        result: { text: "ok", summary: { fileCount: 0, additions: 0, deletions: 0 }, files: [] },
        text: "ok"
      }
    }
  });
  assert.equal(res.statusCode, 400);
});

test("apply_patch artifact 文件缺失时返回 404", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: { patchText: "*** Begin Patch\n*** End Patch" },
      text: "queued"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: { patchText: "*** Begin Patch\n*** End Patch" },
      result: {
        text: "ok",
        summary: { fileCount: 1, additions: 1, deletions: 0 },
        files: [
          {
            type: "add",
            path: "foo.ts",
            before: "",
            after: "console.log(1)\n",
            additions: 1,
            deletions: 0
          }
        ]
      },
      text: "ok"
    }
  });

  const artifactPath = path.join(
    fixture.dataDir,
    "tmp",
    "agent",
    "ui-artifacts",
    "apply_patch",
    fixture.workspaceId,
    "call_apply_patch_1.json"
  );
  await fs.rm(artifactPath, { force: true });

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/apply-patch-artifact`
  });
  assert.equal(artifactRes.statusCode, 404);
});

test("artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const externalDir = path.join(fixture.dataDir, "outside-artifacts");
  let prevId: number | null = null;

  for (const entry of [
    {
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_symlink",
      artifactPath: applyPatchUiArtifactPath,
      suffix: "apply-patch-artifact"
    },
    {
      toolName: "write",
      toolCallId: "call_write_symlink",
      artifactPath: writeUiArtifactPath,
      suffix: "write-artifact"
    }
  ] as const) {
    const item = await createContextItemInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: null,
      turnId: null,
      step: null,
      prevId,
      kind: "tool",
      status: "queued",
      output: { type: "tool", toolName: entry.toolName, toolCallId: entry.toolCallId, text: "queued" }
    });
    prevId = item.item.id;
    const artifactFile = entry.artifactPath(fixture.dataDir, fixture.workspaceId, entry.toolCallId);
    const artifactDir = path.dirname(artifactFile);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.rm(artifactDir, { recursive: true, force: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, path.basename(artifactFile)), "{}", "utf8");
    await fs.symlink(externalDir, artifactDir, "dir");

    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/sessions/${session.id}/context-items/${item.item.id}/${entry.suffix}`
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /Invalid path/);
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("artifact 写入目录为越界 symlink 时仍以 slim result 完成 update", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const externalDir = path.join(fixture.dataDir, "outside-artifacts");
  const previousLogLevel = fixture.app.log.level;
  fixture.app.log.level = "fatal";
  try {
  const toolCallId = "call_write_write_symlink";
  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId,
      args: { filePath: "result.txt", content: "complete content" },
      text: "queued"
    }
  });
  const artifactFile = writeUiArtifactPath(fixture.dataDir, fixture.workspaceId, toolCallId);
  const artifactDir = path.dirname(artifactFile);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.rm(artifactDir, { recursive: true, force: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.symlink(externalDir, artifactDir, "dir");

  const response = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${toolItem.item.id}`,
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      status: "completed",
      output: {
        type: "tool",
        toolName: "write",
        toolCallId,
        args: { filePath: "result.txt", content: "complete content" },
        result: {
          text: "wrote result.txt",
          filePath: "result.txt",
          bytesWritten: 16,
          existedBefore: false,
          before: { available: true, text: "" },
          after: { available: true, text: "complete content" }
        },
        text: "completed"
      }
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  const output = (response.json() as { item: { output: { result: Record<string, unknown> } } }).item.output.result;
  assert.equal(Object.hasOwn(output, "before"), false);
  assert.equal(Object.hasOwn(output, "after"), false);
  assert.equal(output.filePath, "result.txt");
  assert.equal(await fs.lstat(artifactDir).then((st) => st.isSymbolicLink()), true);
  await fs.rm(artifactDir, { recursive: true, force: true });
  } finally {
  fixture.app.log.level = previousLogLevel;
  }
});

test("write completed 后保留完整 args、瘦身 result 并支持 artifact 拉取", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请写入文件"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "开始写文件"
    }
  });

  const writeContent = [
    "# 完整历史写入内容",
    "中文多行内容必须原样保留。",
    "x".repeat(320),
    "最后一行不能被截断。"
  ].join("\n");
  const writeBytes = Buffer.byteLength(writeContent, "utf8");

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "foo.txt",
        content: writeContent
      },
      text: "write queued"
    }
  });

  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "foo.txt",
        content: writeContent
      },
      result: {
        summary: "Wrote file foo.txt",
        filePath: "foo.txt",
        bytesWritten: writeBytes,
        existedBefore: false,
        before: {
          available: false,
          truncated: false,
          bytes: 0,
          reason: "missing_file"
        },
        after: {
          available: true,
          text: writeContent,
          truncated: false,
          bytes: writeBytes
        }
      },
      text: "ok: wrote file"
    }
  });

  const storedTool = await getContextItem(fixture.app, session.id, toolItem.item.id);
  const storedOutput = storedTool.output as { args?: Record<string, unknown>; result?: Record<string, unknown> };
  const storedArgs = storedOutput.args || {};
  assert.equal(storedArgs.filePath, "foo.txt");
  assert.equal(storedArgs.content, writeContent, "write args should preserve complete content");
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "contentBytes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "contentPreview"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "contentTruncated"), false);

  const storedResult = storedOutput.result || {};
  assert.equal(Object.prototype.hasOwnProperty.call(storedResult, "before"), false, "write result should strip before");
  assert.equal(Object.prototype.hasOwnProperty.call(storedResult, "after"), false, "write result should strip after");

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/write-artifact`
  });
  assert.equal(artifactRes.statusCode, 200, `write artifact fetch failed: ${artifactRes.body}`);
  const artifact = artifactRes.json() as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  assert.equal(artifact.before?.available, false);
  assert.equal(artifact.after?.available, true);
  assert.equal(typeof artifact.after?.text, "string");

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include write tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const input = (toolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(input.filePath, "foo.txt");
  assert.equal(input.content, writeContent, "write tool-call input should preserve complete content");
  assert.equal(Object.prototype.hasOwnProperty.call(input, "contentBytes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "contentPreview"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "contentTruncated"), false);
  assert.equal(artifact.after?.text, writeContent);

  const messagesContext = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });
  const messagesAssistant = messagesContext.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  const messagesToolCallPart = Array.isArray(messagesAssistant?.content)
    ? messagesAssistant.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const messagesInput = (messagesToolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(messagesInput.content, writeContent, "messages-context should preserve complete write content");

  const forkBoundary = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: toolItem.item.id,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "继续处理"
    }
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: forkBoundary.item.id,
      mode: "visible_only"
    }
  });
  assert.equal(forkRes.statusCode, 201, `fork write session failed: ${forkRes.body}`);
  const forked = forkRes.json() as { id: string };
  const forkContext = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: forked.id
  });
  const forkedWriteAssistant = forkContext.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  const forkedWritePart = Array.isArray(forkedWriteAssistant?.content)
    ? forkedWriteAssistant.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const forkedWriteInput = (forkedWritePart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(forkedWriteInput.content, writeContent, "forked Prompt should preserve complete write content");

  const legacyAssistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_legacy",
    step: 2,
    prevId: forkBoundary.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "处理旧 write 记录"
    }
  });
  const legacyCompletedItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_legacy",
    step: 2,
    prevId: legacyAssistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_legacy",
      args: {
        filePath: "legacy.txt",
        contentBytes: 123,
        contentPreview: "legacy preview"
      },
      text: "legacy write completed"
    }
  });
  const legacyFailedItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_legacy",
    step: 2,
    prevId: legacyCompletedItem.item.id,
    kind: "tool",
    status: "failed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_legacy_failed",
      args: {
        filePath: "legacy-failed.txt",
        contentBytes: 456
      },
      text: "legacy write fallback text",
      error: "legacy write failure"
    }
  });

  const legacyContext = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });
  const legacyAssistant = legacyContext.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; text?: string }).type === "text" &&
        String((part as { text?: string }).text || "").includes("Historical write input unavailable: legacy.txt");
    });
  });
  assert.ok(legacyAssistant, "legacy metadata-only writes should degrade to text records");
  const legacyParts = Array.isArray(legacyAssistant?.content) ? legacyAssistant.content : [];
  const legacyText = legacyParts
    .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.ok(legacyText.includes("Historical write input unavailable: legacy.txt"));
  assert.ok(legacyText.includes("legacy write completed"), "completed legacy result should remain in history");
  assert.ok(legacyText.includes("Historical write input unavailable: legacy-failed.txt"));
  assert.ok(legacyText.includes("legacy write failure"), "failed legacy error should remain in history");
  const legacyWriteCalls = legacyParts.filter((part) => {
    if (!part || typeof part !== "object") return false;
    return (part as { type?: string; toolName?: string }).type === "tool-call" &&
      (part as { toolName?: string }).toolName === "write";
  });
  assert.equal(legacyWriteCalls.length, 0, "legacy metadata-only writes must not become schema-invalid tool-calls");
  const legacyToolResults = legacyContext.messages
    .filter((message) => message.role === "tool" && Array.isArray(message.content))
    .flatMap((message) => message.content)
    .filter((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "write";
    });
  assert.equal(legacyToolResults.length, 1, "only the complete write should retain a tool-result");
});

test("write artifact 文件缺失时返回 404", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: { filePath: "foo.txt", content: "hello" },
      text: "queued"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: { filePath: "foo.txt", content: "hello" },
      result: {
        summary: "Wrote file foo.txt",
        filePath: "foo.txt",
        bytesWritten: 5,
        existedBefore: false,
        before: { available: false, truncated: false, bytes: 0, reason: "missing_file" },
        after: { available: true, text: "hello", truncated: false, bytes: 5 }
      },
      text: "ok"
    }
  });

  const artifactPath = path.join(
    fixture.dataDir,
    "tmp",
    "agent",
    "ui-artifacts",
    "write",
    fixture.workspaceId,
    "call_write_1.json"
  );
  await fs.rm(artifactPath, { force: true });

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/write-artifact`
  });
  assert.equal(artifactRes.statusCode, 404);
});

test("write 在 cancel 终态会保留完整 args.content", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_cancel",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_cancel",
      args: {
        filePath: "cancel.txt",
        content: "secret cancel payload"
      }
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel write run failed: ${cancelRes.body}`);

  const cancelledItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(cancelledItem.status, "cancelled");
  const args = (cancelledItem.output as { args?: Record<string, unknown> }).args || {};
  assert.equal(args.filePath, "cancel.txt");
  assert.equal(args.content, "secret cancel payload");
  assert.equal(Object.prototype.hasOwnProperty.call(args, "contentBytes"), false);
});

test("write 在 failed 终态会保留完整 args.content", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const writeContent = "失败时也必须保留完整写入意图\n".repeat(30);
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_failed",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_failed",
      args: {
        filePath: "failed.txt",
        content: writeContent
      }
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "failed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_failed",
      args: {
        filePath: "failed.txt",
        content: writeContent
      },
      text: "write failed",
      error: "simulated failure"
    }
  });

  const failedItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(failedItem.status, "failed");
  const args = (failedItem.output as { args?: Record<string, unknown> }).args || {};
  assert.equal(args.filePath, "failed.txt");
  assert.equal(args.content, writeContent);
  assert.equal(Object.prototype.hasOwnProperty.call(args, "contentBytes"), false);
});

test("agent tool 字符串结果保持原始字符串语义", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试字符串结果"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_string_result",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "调用工具获取字符串"
    }
  });

  const rawString = '{"ok":true}';
  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_string_result",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "bash",
      toolCallId: "call_string_result",
      args: {
        command: "echo test"
      },
      result: rawString
    }
  });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(typeof detail.output.result, "string");
  assert.equal(String(detail.output.result || ""), rawString);
});

test("agent 兼容部分迁移数据: tool_call_json 缺失时回退 legacy output", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请读取文件"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_legacy_fallback",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "准备调用 read"
    }
  });

  const legacyToolOutput = {
    type: "tool",
    toolName: "read",
    toolCallId: "call_legacy_read",
    args: {
      filePath: "README.md"
    }
  };

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_legacy_fallback",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: legacyToolOutput
  });

  fixture.db
    .prepare(
      `
        update agent_context_item
        set tool_name = @toolName,
            tool_call_id = null,
            tool_call_json = null,
            tool_result_json = null,
            output_text = '',
            output_json = @outputJson
        where id = @id
      `
    )
    .run({
      id: toolItem.item.id,
      toolName: "read",
      outputJson: JSON.stringify(legacyToolOutput)
    });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(String(detail.output.toolName || ""), "read");
  assert.equal(String(detail.output.toolCallId || ""), "call_legacy_read");
  assert.equal(String((detail.output.args as { filePath?: string } | undefined)?.filePath || ""), "README.md");

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.equal(promptContext.pendingTools.length, 1);
});

test("agent 兼容早期拆分数据: 缺少 resultFormat 时保留结构化工具结果", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试结构化兼容"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compat_result",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "调用 todolist"
    }
  });

  const structuredResult = {
    summary: { total: 1, pending: 0, inProgress: 0, completed: 1, cancelled: 0 },
    todos: [{ content: "完成兼容", status: "completed" }]
  };

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compat_result",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_compat_todolist",
      args: {
        todos: [{ content: "完成兼容", status: "completed" }]
      },
      result: structuredResult
    }
  });

  fixture.db
    .prepare(
      `
        update agent_context_item
        set output_text = @outputText,
            tool_result_json = @toolResultJson,
            output_json = '{}'
        where id = @id
      `
    )
    .run({
      id: toolItem.item.id,
      outputText: JSON.stringify(structuredResult),
      toolResultJson: JSON.stringify({ status: "completed" })
    });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(typeof detail.output.result, "object");
  assert.equal(
    Array.isArray((detail.output.result as { todos?: unknown[] } | undefined)?.todos),
    true,
    "result should remain structured object"
  );

  const sessionAfterCompat = getAgentSession(fixture.db, session.id);
  assert.ok(sessionAfterCompat, "compat session should exist");
  assert.equal(sessionAfterCompat?.title, "it-session", "compat todolist without goal should not change session title");
});

test("agent settings 兼容缺省 globalPromptIds", async () => {
  const fixture = await createFixture();
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);
  const body = res.json() as { agents: Array<{ globalPromptIds?: string[] }> };
  assert.deepEqual(body.agents[0]?.globalPromptIds ?? [], []);
});

test("agent global prompts 保存选择指令后展开提示词内容配置", async () => {
  const fixture = await createFixture();
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        {
          id: "global_system_prompt",
          title: "ignored",
          prompt: "SYSTEM",
          command: "system-command",
          expandOnSelect: true
        },
        {
          id: "gp_expand",
          title: "Expand",
          prompt: "EXPAND_PROMPT",
          command: "expand",
          expandOnSelect: true
        },
        {
          id: "gp_disabled",
          title: "Disabled",
          prompt: "DISABLED_PROMPT",
          command: "disabled",
          expandOnSelect: false
        },
        {
          id: "gp_without_command",
          title: "Without command",
          prompt: "WITHOUT_COMMAND_PROMPT",
          expandOnSelect: true
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update global prompts failed: ${res.body}`);

  const items = (res.json() as {
    items: Array<{ id: string; command?: string; expandOnSelect?: boolean }>;
  }).items;
  assert.deepEqual(items.find((item) => item.id === "gp_expand"), {
    id: "gp_expand",
    title: "Expand",
    prompt: "EXPAND_PROMPT",
    command: "expand",
    expandOnSelect: true
  });
  assert.equal(items.find((item) => item.id === "gp_disabled")?.expandOnSelect, undefined);
  assert.equal(items.find((item) => item.id === "gp_without_command")?.expandOnSelect, undefined);
  assert.equal(items.find((item) => item.id === "gp_without_command")?.command, undefined);
  assert.equal(items.find((item) => item.id === "global_system_prompt")?.expandOnSelect, undefined);
  assert.equal(items.find((item) => item.id === "global_system_prompt")?.command, undefined);

  const getRes = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/global-prompts"
  });
  assert.equal(getRes.statusCode, 200, `get global prompts failed: ${getRes.body}`);
  const getItems = (getRes.json() as {
    items: Array<{ id: string; command?: string; expandOnSelect?: boolean }>;
  }).items;
  assert.equal(getItems.find((item) => item.id === "gp_expand")?.expandOnSelect, true);
  assert.equal(getItems.find((item) => item.id === "gp_disabled")?.expandOnSelect, undefined);
});

test("agent global prompts 拒绝非布尔的选择展开配置", async () => {
  const fixture = await createFixture();
  for (const expandOnSelect of ["true", 1]) {
    const res = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/global-prompts",
      payload: {
        items: [
          { id: "global_system_prompt", title: "ignored", prompt: "SYSTEM" },
          { id: "gp_invalid", title: "Invalid", prompt: "PROMPT", command: "invalid", expandOnSelect }
        ]
      }
    });
    assert.equal(res.statusCode, 400, `invalid expand-on-select should fail: ${res.body}`);
  }
});

test("agent global prompts 归一化历史选择展开配置且不重写缺失字段", async () => {
  const legacyUpdatedAt = 123;
  const legacyFixture = await createFixture({
    agentGlobalPromptsStored: {
      items: [
        { id: "global_system_prompt", title: "Global System Prompt", prompt: "SYSTEM" },
        { id: "gp_legacy", title: "Legacy", prompt: "LEGACY", command: "legacy" }
      ]
    },
    agentGlobalPromptsUpdatedAt: legacyUpdatedAt
  });
  assert.equal(
    getSettingJson(legacyFixture.db, "agent_global_prompts_v1")?.updatedAt,
    legacyUpdatedAt,
    "missing expandOnSelect should not trigger a settings rewrite"
  );

  const fixture = await createFixture({
    agentGlobalPromptsStored: {
      items: [
        {
          id: "global_system_prompt",
          title: "Global System Prompt",
          prompt: "SYSTEM",
          expandOnSelect: true
        },
        { id: "gp_enabled", title: "Enabled", prompt: "ENABLED", command: "enabled", expandOnSelect: true },
        { id: "gp_false", title: "False", prompt: "FALSE", command: "false", expandOnSelect: false },
        { id: "gp_invalid", title: "Invalid", prompt: "INVALID", command: "invalid", expandOnSelect: "true" },
        { id: "gp_no_command", title: "No command", prompt: "NO_COMMAND", expandOnSelect: true }
      ]
    },
    agentGlobalPromptsUpdatedAt: legacyUpdatedAt
  });

  const stored = getSettingJson(fixture.db, "agent_global_prompts_v1");
  assert.ok(stored, "normalized settings should be stored");
  assert.ok(stored.updatedAt > legacyUpdatedAt, "invalid historical values should be normalized and persisted");
  const storedItems = (stored?.value as { items: Array<{ id: string; command?: string; expandOnSelect?: boolean }> }).items;
  assert.equal(storedItems.find((item) => item.id === "gp_enabled")?.expandOnSelect, true);
  assert.equal(storedItems.find((item) => item.id === "gp_false")?.expandOnSelect, undefined);
  assert.equal(storedItems.find((item) => item.id === "gp_invalid")?.expandOnSelect, undefined);
  assert.equal(storedItems.find((item) => item.id === "gp_no_command")?.expandOnSelect, undefined);
});

test("agent prompt-context 全局提示词按列表顺序注入(方案A)", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  const initialGlobalPrompts = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/global-prompts"
  });
  assert.equal(initialGlobalPrompts.statusCode, 200, `get global prompts failed: ${initialGlobalPrompts.body}`);
  const seededItems = (initialGlobalPrompts.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  const seededSystemPrompt = seededItems.find((item) => item.id === "global_system_prompt");
  assert.ok(seededSystemPrompt, "seeded global system prompt should exist");
  assert.equal(seededSystemPrompt?.title, "Global System Prompt");
  assert.ok(String(seededSystemPrompt?.prompt || "").trim().length > 0, "seeded global system prompt should be non-empty");

  const globalPromptsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "ignored", prompt: "CUSTOM_SYSTEM_BASE" },
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(globalPromptsRes.statusCode, 200, `update global prompts failed: ${globalPromptsRes.body}`);
  const updatedItems = (globalPromptsRes.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  assert.equal(updatedItems.find((item) => item.id === "global_system_prompt")?.title, "Global System Prompt");

  const omitSystemPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(omitSystemPromptRes.statusCode, 200, `update global prompts failed: ${omitSystemPromptRes.body}`);
  const omitSystemPromptItems = (omitSystemPromptRes.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  assert.equal(omitSystemPromptItems.filter((item) => item.id === "global_system_prompt").length, 1);
  assert.equal(omitSystemPromptItems.find((item) => item.id === "global_system_prompt")?.prompt, "CUSTOM_SYSTEM_BASE");

  const emptySystemPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "whatever", prompt: "   " }
      ]
    }
  });
  assert.equal(emptySystemPromptRes.statusCode, 400, `empty system prompt should be rejected: ${emptySystemPromptRes.body}`);

  const emptyPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "whatever", prompt: "CUSTOM_SYSTEM_BASE" },
        { id: "gp_empty", title: "Empty", prompt: "   " }
      ]
    }
  });
  assert.equal(emptyPromptRes.statusCode, 400, `empty prompt should be rejected: ${emptyPromptRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "AGENT_PROMPT",
          globalPromptIds: ["global_system_prompt", "gp_b", "gp_a"],
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const idxA = context.system.indexOf("PROMPT_A");
  const idxB = context.system.indexOf("PROMPT_B");
  const idxAgent = context.system.indexOf("AGENT_PROMPT");
  const idxCore = context.system.indexOf("CUSTOM_SYSTEM_BASE");
  assert.ok(idxA >= 0, "system should include PROMPT_A");
  assert.ok(idxB >= 0, "system should include PROMPT_B");
  assert.ok(idxAgent >= 0, "system should include AGENT_PROMPT");
  assert.ok(idxCore >= 0, "system should include global workflow prompt");
  assert.ok(idxCore < idxA, "global workflow prompt should be prepended before global prompts");
  assert.ok(idxA < idxB, "global prompts should follow global list order, not selected id order");
  assert.equal((context.system.match(/CUSTOM_SYSTEM_BASE/g) || []).length, 1, "system prompt base should only appear once");
  assert.ok(idxB < idxAgent, "agent prompt should be appended after global prompts");
});

test("agent prompt-context 同时存在 global/workspace/agent 时按既定顺序拼接", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "WORKSPACE_RULE", "utf-8");
  setSettingJson(fixture.db, "workspace_agents_instructions_v1", {
    workspaces: {
      [fixture.workspaceId]: {
        enabledSources: [{ sourceType: "workspace", enabledAt: Date.now() }],
        updatedAt: Date.now()
      }
    }
  }, Date.now());

  const globalPromptsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(globalPromptsRes.statusCode, 200, `update global prompts failed: ${globalPromptsRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "AGENT_PROMPT",
          globalPromptIds: ["gp_b", "gp_a"],
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const idxCore = context.system.indexOf("# 工作方式与流程(全局)");
  const idxA = context.system.indexOf("PROMPT_A");
  const idxB = context.system.indexOf("PROMPT_B");
  const idxOutput = context.system.indexOf("[output_format_instructions]");
  const idxRuntime = context.system.indexOf("[runtime_constraints]");
  const idxSystemBaseTag = context.system.indexOf("[system_base]");
  const idxATag = context.system.indexOf("[global_prompt] A");
  const idxBTag = context.system.indexOf("[global_prompt] B");
  const idxWorkspace = context.system.indexOf("[agents_instructions] AGENTS.md");
  const idxAgentTag = context.system.indexOf("[agent_prompt] default");
  const idxAgent = context.system.indexOf("AGENT_PROMPT");

  assert.equal(context.system.includes("## Global Prompt:"), false, "system should not include legacy global prompt headings");
  assert.equal(context.system.includes("## Workspace Instructions:"), false, "system should not include legacy workspace headings");
  assert.equal(context.system.includes("## Agent Prompt:"), false, "system should not include legacy agent headings");
  assert.equal(context.system.includes("## Runtime Constraints"), false, "system should not include legacy runtime heading");
  assert.ok(idxSystemBaseTag >= 0, "system should include system base section tag");
  assert.ok(idxATag >= 0, "system should include global prompt A section tag");
  assert.ok(idxBTag >= 0, "system should include global prompt B section tag");
  assert.ok(idxCore >= 0, "system should include global workflow prompt");
  assert.ok(idxA >= 0, "system should include PROMPT_A");
  assert.ok(idxB >= 0, "system should include PROMPT_B");
  assert.ok(idxWorkspace >= 0, "system should include workspace instructions section");
  assert.ok(idxOutput >= 0, "system should include output format instructions section");
  assert.equal(idxRuntime >= 0, false, "system should not include runtime constraints when runtime instruction is empty");
  assert.ok(context.system.includes("Output format requirements:"), "system should include output format instruction body");
  assert.ok(idxAgent >= 0, "system should include AGENT_PROMPT");

  assert.ok(idxSystemBaseTag < idxATag, "order: system base tag before global prompts");
  assert.ok(idxATag < idxBTag, "order: global prompt tags follow global list order");
  assert.ok(idxBTag < idxWorkspace, "order: global prompts before workspace instructions");
  assert.ok(idxWorkspace < idxAgentTag, "order: workspace instructions before agent prompt");
  assert.ok(idxAgentTag < idxOutput, "order: agent prompt before output format instructions");
  assert.equal(context.system.includes("[runtime_constraints]"), false, "system should not include runtime constraints section");
  assert.ok(idxCore < idxA, "order: system base body before global prompt body");
  assert.ok(idxA < idxB, "order: global prompt bodies follow global list order");
  assert.ok(idxB < context.system.indexOf("WORKSPACE_RULE"), "order: global prompt bodies before workspace instructions body");
  assert.ok(context.system.indexOf("WORKSPACE_RULE") < idxAgent, "order: workspace instructions body before agent prompt body");
});

test("agent prompt-context 在 workspace 根 AGENTS.md 缺失时忽略", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(context.system.includes("# 工作方式与流程(全局)"), "system should include global workflow prompt");
  assert.ok(context.system.includes("[system_base]"), "system should include system base section");
  assert.ok(context.system.includes("[agent_prompt] default"), "system should include agent section");
  assert.ok(context.system.includes("[output_format_instructions]"), "system should include output format instructions");
  assert.equal(context.system.includes("[runtime_constraints]"), false, "system should not include runtime constraints when runtime instruction is empty");
  assert.ok(
    context.system.includes("You are a helpful coding assistant."),
    "system should include agent prompt content"
  );
  assert.equal(
    context.system.includes("[workspace_instructions] AGENTS.md"),
    false,
    "system should ignore missing workspace AGENTS.md"
  );
});

test("agent startup seed 会修复脏的 global prompts settings", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-seed-repair-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  let app: FastifyInstance | null = null;
  try {
    setSettingJson(db, "agent_global_prompts_v1", {
      items: [
        null,
        { id: "global_system_prompt", title: "Broken", prompt: "   " },
        { id: "global_system_prompt", title: "Dup", prompt: "dup" },
        { id: "gp_empty", title: "Empty", prompt: "   " },
        { id: "gp_ok", title: "OK", prompt: "PROMPT_OK" }
      ]
    }, Date.now());

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
        agentWorkerConcurrency: 0,
        agentInternalToken: internalToken,
        agentWorkerResponseValidation: "strict",
        agentApiOrigin: "http://127.0.0.1:0",
        agentStartupRecoveryMode: "recover",
        agentPluginHostEnabled: false,
        agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock")
      });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/settings/agent/global-prompts" });
    assert.equal(res.statusCode, 200);
    const items = (res.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
    assert.equal(items.filter((item) => item.id === "global_system_prompt").length, 1);
    assert.equal(items.find((item) => item.id === "global_system_prompt")?.title, "Global System Prompt");
    assert.ok(String(items.find((item) => item.id === "global_system_prompt")?.prompt || "").trim().length > 0);
    assert.equal(items.some((item) => item.id === "gp_empty"), false);
    assert.equal(items.some((item) => item.id === "gp_ok" && item.prompt === "PROMPT_OK"), true);
  } finally {
    await app?.close().catch(() => undefined);
    db.close();
    await rmrf(dataDir);
  }
});

test("agent prompt-context 在 agent prompt 为空且无 workspace/global 时仅注入全局系统提示词", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "",
          tools: ["bash", "read", "write", "scratchpad"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(context.system.includes("# 工作方式与流程(全局)"), "system should include global workflow prompt");
  assert.ok(context.system.includes("[system_base]"), "system should include system base section");
  assert.ok(context.system.includes("[output_format_instructions]"), "system should include output format instructions");
  assert.equal(context.system.includes("[runtime_constraints]"), false, "system should not include runtime constraints when runtime instruction is empty");
  assert.equal(context.system.includes("## Global Prompt:"), false, "system should not include global prompt sections");
  assert.equal(context.system.includes("[global_prompt]"), false, "system should not include global prompt blocks when none selected");
  assert.equal(
    context.system.includes("## Workspace Instructions:"),
    false,
    "system should not include workspace instructions when missing"
  );
  assert.equal(context.system.includes("[workspace_instructions]"), false, "system should not include workspace instructions block when missing");
  assert.equal(context.system.includes("## Agent Prompt:"), false, "system should not include agent prompt section when empty");
  assert.equal(context.system.includes("[agent_prompt]"), false, "system should not include agent prompt block when empty");
});

test("agent prompt-context 对 workspace AGENTS.md 做 32KB 截断并追加标记", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();
  const agentsPath = path.join(fixture.workspacePath, "AGENTS.md");
  await fs.writeFile(agentsPath, `RULE\n${"A".repeat(40 * 1024)}`, "utf-8");
  setSettingJson(fixture.db, "workspace_agents_instructions_v1", {
    workspaces: {
      [fixture.workspaceId]: {
        enabledSources: [{ sourceType: "workspace", enabledAt: Date.now() }],
        updatedAt: Date.now()
      }
    }
  }, Date.now());

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(
    context.system.includes("[agents_instructions] AGENTS.md"),
    "system should include workspace section with relative path"
  );
  assert.ok(
    context.system.includes("[AGENTS.md truncated: first 32KB]"),
    "system should include truncation marker"
  );
  assert.ok(context.system.includes("[agent_prompt] default"), "system should include agent section when workspace section exists");
  assert.equal(context.system.includes("## Workspace Instructions:"), false, "system should not include legacy workspace heading when workspace section exists");
});

test("agent prompt-context 注入 skills 摘要并在同 run 缓存静态部分", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const builtinSkillDir = path.join(fixture.repoRoot, "skills", `it-builtin-${Date.now()}`);
  const wsSkillDir = path.join(fixture.workspacePath, "deploy-skill", "deploy");
  const wsBinarySkillDir = path.join(fixture.workspacePath, "deploy-skill", "nontext");
  const wsInvalidSkillDir = path.join(fixture.workspacePath, "deploy-skill", " invalid");
  const repoId = newSortableId("repo");
  const repoDirName = "repo-it";
  const repoPath = workspaceRepoDirPath(fixture.dataDir, path.basename(fixture.workspacePath), repoDirName);
  const repoSkillsRootDir = "ai-skills";
  const repoTopSkillDir = "ops";
  const repoSkillDir = path.join(repoPath, repoSkillsRootDir);
  try {
    await fs.mkdir(path.join(builtinSkillDir, "child"), { recursive: true });
    await fs.mkdir(wsSkillDir, { recursive: true });
    await fs.mkdir(wsInvalidSkillDir, { recursive: true });
    await fs.mkdir(path.join(repoSkillDir, repoTopSkillDir), { recursive: true });
    await fs.mkdir(wsBinarySkillDir, { recursive: true });
    await fs.mkdir(repoSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(builtinSkillDir, "SKILL.md"),
      "---\nname: Builtin Skill V1\n---\n\nbody",
      "utf8"
    );
    insertRepo(fixture.db, {
      id: repoId,
      url: `https://example.test/${repoId}.git`,
      credentialId: null,
      defaultBranch: "main",
      mirrorPath: path.join(fixture.dataDir, "repos", repoId, "mirror.git"),
      syncStatus: "idle",
      syncError: null,
      lastSyncAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    insertWorkspaceRepo(fixture.db, {
      workspaceId: fixture.workspaceId,
      repoId,
      dirName: repoDirName,
      path: repoPath,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    await fs.writeFile(path.join(builtinSkillDir, "child", "SKILL.md"), "---\nname: Child\ndescription: hidden\n---\n", "utf8");
    await fs.writeFile(
      path.join(wsSkillDir, "SKILL.md"),
      "---\nname: Workspace Skill V1\ndescription: ws-desc-v1\n---\n\nbody",
      "utf8"
    );
    await fs.writeFile(path.join(wsInvalidSkillDir, "SKILL.md"), "---\nname: Invalid workspace skill\n---\nbody", "utf8");
    await fs.writeFile(path.join(wsBinarySkillDir, "SKILL.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x00, 0x61]));
    await fs.writeFile(
      path.join(repoSkillDir, repoTopSkillDir, "SKILL.md"),
      "---\nname: Repo Skill V1\ndescription: repo-desc-v1\n---\n\nbody",
      "utf8"
    );
    setSettingJson(fixture.db, "workspace_external_skill_roots_v1", {
      workspaces: {
        [fixture.workspaceId]: {
          enabledRoots: [
            { sourceType: "workspace", rootDir: "deploy-skill", enabledAt: Date.now() },
            { sourceType: "repo", repoId, rootDir: repoSkillsRootDir, enabledAt: Date.now() }
          ],
          updatedAt: Date.now()
        }
      }
    }, Date.now());
    setSettingJson(fixture.db, "workspace_agents_instructions_v1", {
      workspaces: {
        [fixture.workspaceId]: {
          enabledSources: [{ sourceType: "workspace", enabledAt: Date.now() }],
          updatedAt: Date.now()
        }
      }
    }, Date.now());
    await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "RULE_V1", "utf8");

    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      uiLocale: "en-US",
      modelId: "gpt-5.2",
      status: "running",
      createdAt: Date.now()
    });

    const first = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId
    });
    assert.ok(first.system.includes("[skills]"), "skills section should be present");
    assert.ok(first.system.includes(`skillId: builtin/${path.basename(builtinSkillDir)}`), "builtin skill identifier should be injected");
    assert.ok(first.system.includes("name: Builtin Skill V1"));
    assert.ok(first.system.includes(`skillId: builtin/${path.basename(builtinSkillDir)}; name: Builtin Skill V1\n`), "empty description must not leave a trailing separator");
    assert.equal(first.system.includes(`skillId: builtin/${path.basename(builtinSkillDir)}; name: Builtin Skill V1; description:`), false, "empty description must be omitted");
    assert.ok(first.system.includes("skillId: workspace/deploy-skill/deploy"), "workspace skill identifier should be injected");
    assert.ok(first.system.includes("description: ws-desc-v1"));
    assert.ok(first.system.includes(`skillId: repo/${repoId}/${repoSkillsRootDir}/${repoTopSkillDir}`), "repo skill identifier should be injected");
    assert.ok(first.system.includes("description: repo-desc-v1"));
    assert.equal(first.system.includes(fixture.workspacePath), false, "system prompt should not expose workspace real path");
    assert.equal(first.system.includes(repoPath), false, "system prompt should not expose repo real path");
    assert.equal(first.system.includes(`builtin/${path.basename(builtinSkillDir)}/child`), false, "only top-level skills should be injected");
    assert.equal(first.system.includes("skillId: workspace/deploy-skill/nontext"), false, "non-text top-level skill should not be injected");
    assert.equal(first.system.includes("skillId: workspace/deploy-skill/ invalid"), false, "non-callable physical skill must be omitted from prompt summaries");
    assert.equal(first.tools.some((tool) => tool.name === "skill"), true, "skill tool should be available");
    assert.ok(first.system.includes("First read the root:"), "skills prompt should require a root read first");
    assert.ok(first.system.includes("flat (not tree-shaped) Skill files list"), "skills prompt should describe the flat list");
    assert.ok(first.system.includes("copy one complete path line verbatim into filePath"), "skills prompt should explain direct path reuse");
    assert.equal(first.system.includes("skill_id:"), false, "skills prompt must not expose snake_case parameter labels");
    assert.equal(first.system.includes("file_path"), false, "skills prompt must not expose snake_case parameter labels");

    await fs.writeFile(path.join(wsSkillDir, "SKILL.md"), "---\nname: Workspace Skill V2\ndescription: ws-desc-v2\n---\n", "utf8");
    await fs.writeFile(path.join(repoSkillDir, repoTopSkillDir, "SKILL.md"), "---\nname: Repo Skill V2\ndescription: repo-desc-v2\n---\n", "utf8");
    await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "RULE_V2", "utf8");
    await sleep(1100);

    const second = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId
    });
    assert.ok(second.system.includes("RULE_V1"), "same run should keep cached workspace AGENTS content");
    assert.equal(second.system.includes("RULE_V2"), false, "same run should not see updated workspace AGENTS");
    assert.ok(second.system.includes("ws-desc-v1"), "same run should keep cached skill summary");
    assert.equal(second.system.includes("ws-desc-v2"), false, "same run should not see updated skill summary");
    assert.ok(second.system.includes("repo-desc-v1"), "same run should keep cached repo skill summary");
    assert.equal(second.system.includes("repo-desc-v2"), false, "same run should not see updated repo skill summary");

    const runId2 = newSortableId("run");
    createRunRecord(fixture.db, {
      runId: runId2,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      uiLocale: "en-US",
      modelId: "gpt-5.2",
      status: "running",
      createdAt: Date.now()
    });
    const third = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: runId2 });
    assert.ok(third.system.includes("RULE_V2"), "new run should observe updated workspace AGENTS");
    assert.ok(third.system.includes("ws-desc-v2"), "new run should observe updated skill summary");
    assert.ok(third.system.includes("repo-desc-v2"), "new run should observe updated repo skill summary");
  } finally {
    await fs.rm(builtinSkillDir, { recursive: true, force: true });
  }
});

test("agent prompt-context 对 repo 根 symlink/路径失配安全跳过", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const ts = Date.now();

  const repoId = newSortableId("repo");
  const repoDirName = "repo-safe";
  const repoPath = path.join(fixture.workspacePath, repoDirName);
  await fs.mkdir(path.join(repoPath, "ai-skill", "ops"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "ai-skill", "ops", "SKILL.md"), "---\nname: Safe\ndescription: safe-desc\n---\n", "utf8");

  insertRepo(fixture.db, {
    id: repoId,
    url: `https://example.test/${repoId}.git`,
    credentialId: null,
    defaultBranch: "main",
    mirrorPath: path.join(fixture.dataDir, "repos", repoId, "mirror.git"),
    syncStatus: "idle",
    syncError: null,
    lastSyncAt: ts,
    createdAt: ts,
    updatedAt: ts
  });
  insertWorkspaceRepo(fixture.db, {
    workspaceId: fixture.workspaceId,
    repoId,
    dirName: repoDirName,
    path: repoPath,
    createdAt: ts,
    updatedAt: ts
  });

  setSettingJson(fixture.db, "workspace_external_skill_roots_v1", {
    workspaces: {
      [fixture.workspaceId]: {
        enabledRoots: [{ sourceType: "repo", repoId, rootDir: "ai-skill", enabledAt: ts }],
        updatedAt: ts
      }
    }
  }, ts);

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: ts
  });

  const first = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(first.system.includes("safe-desc"), "valid repo root should be injected");

  const symlinkPath = path.join(fixture.workspacePath, "repo-symlink");
  await fs.rename(repoPath, path.join(fixture.workspacePath, "repo-safe-target"));
  await fs.symlink(path.join(fixture.workspacePath, "repo-safe-target"), symlinkPath, "dir");
  fixture.db.prepare("update workspace_repos set path = ? where workspace_id = ? and repo_id = ?").run(symlinkPath, fixture.workspaceId, repoId);

  const runId2 = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: runId2,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const second = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: runId2 });
  assert.equal(second.system.includes("safe-desc"), false, "repo symlink/mismatch should be skipped");
  assert.equal(second.externalSkillRoots.length, 0, "external skill roots mapping should also skip invalid repo root");
});

test("subtask start 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE", async () => {
  const fixture = await createFixture();
  await configureAgentDefaults(fixture.app);
  setSettingJson(
    fixture.db,
    "workspace_agent_enablement_v1",
    {
      workspaces: {
        [fixture.workspaceId]: {
          mode: "subset",
          enabledAgentIds: [],
          updatedAt: Date.now()
        }
      }
    },
    Date.now()
  );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare subtask when no agents enabled" }
  });
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    uiLocale: null,
    status: "running",
    createdAt: Date.now()
  });
  const subtaskTool = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_no_agent_enabled",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "subtask", toolCallId: "call_subtask_no_agent_enabled", args: { description: "do task", prompt: "do task", agentId: "default", session: { mode: "fork" } } }
  });

  const startRes = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, parentSessionId: parentSession.id, parentRunId: parentRunId, parentToolItemId: subtaskTool.item.id, description: "do task", prompt: "do task", agentId: "default", session: { mode: "fork" } } });
  assert.equal(startRes.statusCode, 400);
  assert.equal((startRes.json() as { code?: string }).code, "AGENT_DISABLED_IN_WORKSPACE");
});

test("openai-compatible provider 可在 settings 与 profile 中保存透传", async () => {
  const fixture = await createFixture();

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `update providers failed: ${providersRes.body}`);

  const getProvidersRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/providers" });
  assert.equal(getProvidersRes.statusCode, 200, `get providers failed: ${getProvidersRes.body}`);
  const providersBody = getProvidersRes.json() as any;
  const provider = providersBody.providers.find((item: any) => item.id === "compat_openai");
  assert.equal(provider?.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider?.options?.apiMode, undefined);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "compat_openai", modelId: "deepseek-v3" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_provider_openai_compatible"
  });

  const singleCallProfileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/single-call-model-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(singleCallProfileRes.statusCode, 200, `get single-call model profile failed: ${singleCallProfileRes.body}`);
  const singleCallProfile = singleCallProfileRes.json() as any;
  assert.equal(singleCallProfile.provider?.id, "compat_openai");
  assert.equal(singleCallProfile.provider?.npm, "@ai-sdk/openai-compatible");
  assert.equal(singleCallProfile.provider?.options?.apiMode, undefined);
});

test("openai-compatible provider 支持按 OpenAI 风格拉取远程模型列表", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authHeader = "";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    authHeader = headers.get("authorization") ?? "";
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "qwen-max" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const providersRes = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/providers",
      payload: {
        default: { providerId: "compat_openai", modelId: "deepseek-chat" },
        providers: [
          {
            id: "compat_openai",
            name: "compat_openai",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "https://example.openai-compatible.invalid/v1",
              apiKey: "sk-compat"
            },
            models: []
          }
        ]
      }
    });
    assert.equal(providersRes.statusCode, 200, `update providers failed: ${providersRes.body}`);

    const modelsRes = await fixture.app.inject({
      method: "GET",
      url: "/api/settings/agent/providers/compat_openai/models"
    });
    assert.equal(modelsRes.statusCode, 200, `get provider models failed: ${modelsRes.body}`);
    const body = modelsRes.json() as any;
    assert.equal(body.providerId, "compat_openai");
    assert.equal(body.source, "remote");
    assert.deepEqual(body.items.map((item: any) => item.id), ["deepseek-chat", "qwen-max"]);
    assert.equal(requestUrl, "https://example.openai-compatible.invalid/v1/models");
    assert.equal(authHeader, "Bearer sk-compat");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
