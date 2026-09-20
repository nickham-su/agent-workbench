import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { openDb } from "../../infra/db/db.js";
import { repoMirrorPath, workspaceRoot } from "../../infra/fs/paths.js";
import { pathExists } from "../../infra/fs/fs.js";
import { agentAttachmentFilePath, agentAttachmentsRoot, agentAttachmentWorkspaceDir } from "../agent/attachments/agent-attachment-paths.js";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { insertRepo } from "../repos/repo.store.js";
import {
  createWorkspaceFile,
  deleteWorkspacePath,
  listWorkspaceFiles,
  mkdirWorkspacePath,
  renameWorkspacePath,
  writeWorkspaceFileText,
} from "./workspace-files.service.js";
import { getWorkspace, insertWorkspace, insertWorkspaceRepo, listWorkspaces } from "./workspace.store.js";
import {
  createWorkspace,
  deleteWorkspace,
  detectWorkspaceExternalSkillRoots,
  detectWorkspaceAgentEnablement,
  getWorkspaceAgentEnablementSettings,
  listWorkspaceTopLevelSkills,
  updateWorkspaceAgentEnablementSettings,
  updateWorkspaceExternalSkillRootsSettings
} from "./workspace.service.js";
import { setSettingJson } from "../settings/settings.store.js";
import { registerGlobalSystemPromptTextProvider } from "../settings/settings.service.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { registerWorkspaceRuntime, unregisterWorkspaceRuntime } from "../agent/lifecycle/workspace-runtime-registry.js";
import { RunLifecycleApplication } from "../agent/lifecycle/run-lifecycle-application.js";
import { SqliteRunLifecyclePersistence } from "../agent/lifecycle/sqlite-run-lifecycle-persistence.js";
import { SessionRuntimeHandoffCoordinator } from "../agent/lifecycle/session-runtime-handoff-coordinator.js";
import { insertTerminal } from "../terminals/terminal.store.js";
import { terminalAskpassPath, terminalAskpassTokenPath, terminalSshKeyPath } from "../terminals/terminal.gitAuth.js";
import { armTerminalAuthCleanupIntent, updateTerminalAuthCleanupIntent } from "../terminals/terminal-auth-cleanup-intent.store.js";

const tempDirs: string[] = [];
const AGENT_SETTINGS_KEY = "agent_agents_v1";

function createLogger() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => createLogger()
  } as unknown as FastifyBaseLogger;
}

async function createFixture() {
  registerGlobalSystemPromptTextProvider(() => "test global system prompt");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-ws-service-test-"));
  tempDirs.push(dataDir);
  const db = await openDb(dataDir);
  const workspaceId = "ws_test";
  const workspaceDirName = "workspace_test";
  const workspacePath = workspaceRoot(dataDir, workspaceDirName);
  await fs.mkdir(workspacePath, { recursive: true });
  const now = Date.now();
  insertWorkspace(db, {
    id: workspaceId,
    dirName: workspaceDirName,
    title: "workspace",
    path: workspacePath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now
  });

  const ctx = {
    db,
    repoRoot: process.cwd(),
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
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
    agentInternalToken: "token",
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"),
    agentPluginServicesEnabled: false
  } satisfies AppContext;

  return { ctx, workspaceId, workspacePath, workspaceDirName };
}

async function createEmptyFixture() {
  registerGlobalSystemPromptTextProvider(() => "test global system prompt");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-ws-service-test-"));
  tempDirs.push(dataDir);
  const db = await openDb(dataDir);

  const ctx = {
    db,
    repoRoot: process.cwd(),
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
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
    agentInternalToken: "token",
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"),
    agentPluginServicesEnabled: false
  } satisfies AppContext;

  return { ctx, dataDir };
}

async function addWorkspaceRepo(params: {
  ctx: AppContext;
  workspaceId: string;
  repoId: string;
  repoDirName: string;
  repoPath: string;
}) {
  const now = Date.now();
  insertRepo(params.ctx.db, {
    id: params.repoId,
    url: `https://example.test/${params.repoId}.git`,
    credentialId: null,
    defaultBranch: "main",
    mirrorPath: path.join(params.ctx.dataDir, "repos", params.repoId, "mirror.git"),
    syncStatus: "idle",
    syncError: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now
  });
  insertWorkspaceRepo(params.ctx.db, {
    workspaceId: params.workspaceId,
    repoId: params.repoId,
    dirName: params.repoDirName,
    path: params.repoPath,
    createdAt: now,
    updatedAt: now
  });
}

async function createRecoverableTerminalAuthArtifact(params: {
  ctx: AppContext;
  terminalId: string;
  artifactKind: "ssh-key" | "askpass" | "askpass-token";
  artifactPath: string;
  content: string;
  updatedAt: number;
}) {
  const artifactName = path.basename(params.artifactPath);
  const root = await fs.stat(params.ctx.dataDir);
  armTerminalAuthCleanupIntent(params.ctx.db, {
    terminalId: params.terminalId,
    artifactKind: params.artifactKind,
    artifactName,
    rootDev: root.dev,
    rootIno: root.ino,
    updatedAt: params.updatedAt,
  });
  await fs.writeFile(params.artifactPath, params.content, { mode: params.artifactKind === "askpass" ? 0o700 : 0o600 });
  const stat = await fs.stat(params.artifactPath);
  updateTerminalAuthCleanupIntent(params.ctx.db, {
    terminalId: params.terminalId, artifactKind: params.artifactKind, phase: "recoverable", artifactName,
    expectedDev: stat.dev, expectedIno: stat.ino, rootDev: root.dev, rootIno: root.ino,
    diagnostic: "test root live artifact", updatedAt: params.updatedAt + 1,
  });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("workspace delete 与同 Session handoff 串行，cancel 不会被晚到 enqueue 越过", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const { db } = fixture.ctx;
  db.prepare("insert into agent_session (id,workspace_id,title,kind,created_at,updated_at) values ('race-session', ?, 'Running', 'primary', ?, ?)").run(fixture.workspaceId, now, now);
  db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('race-run', ?, 'race-session', null, 'agent', 'provider', 'model', 'running', ?, ?)").run(fixture.workspaceId, now, now);
  db.prepare("insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at) values (?, 'race-session', 'running', 'race-run', '', 0, null, null, '[]', '[]', ?)").run(fixture.workspaceId, now);
  const coordinator = new SessionRuntimeHandoffCoordinator();
  let releaseEnqueue!: () => void;
  const enqueueGate = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
  const events: string[] = [];
  const enqueuing = coordinator.runExclusive("race-session", async () => {
    events.push("enqueue-start");
    await enqueueGate;
    events.push("enqueue-end");
  });
  const runtime = {
    enqueueRun() {},
    async cancelSessionAndWait() { events.push("cancel"); return true; },
  };
  const registration = {
    runtime,
    handoffCoordinator: coordinator,
    settleWorkspaceRunsForDeletion() {
      events.push("settle");
      return ["race-session"];
    },
  };
  registerWorkspaceRuntime(registration);
  try {
    const deleting = deleteWorkspace(fixture.ctx, logger, fixture.workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, ["enqueue-start"], "删除必须等待已在 handoff 中的 enqueue");
    releaseEnqueue();
    await enqueuing;
    await deleting;
    assert.deepEqual(events, ["enqueue-start", "enqueue-end", "settle", "cancel"]);
  } finally {
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace external skills: 仅允许一级目录且目录名包含 skill", async () => {
  const logger = createLogger();
  const fixture = await createFixture();
  const repoPath = path.join(fixture.workspacePath, "repo-a");
  await fs.mkdir(path.join(repoPath, "ai-skill"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "nested", "inner-skill"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
  await addWorkspaceRepo({
    ctx: fixture.ctx,
    workspaceId: fixture.workspaceId,
    repoId: "repo_a",
    repoDirName: "repo-a",
    repoPath
  });

  await fs.mkdir(path.join(fixture.workspacePath, "workspace-skill"), { recursive: true });

  const detected = await detectWorkspaceExternalSkillRoots(fixture.ctx, logger, fixture.workspaceId);
  assert.deepEqual(detected.items.map((it) => `${it.sourceType}/${it.rootDir}`), ["workspace/workspace-skill", "repo/ai-skill"]);

  const updated = await updateWorkspaceExternalSkillRootsSettings(
    fixture.ctx,
    logger,
    fixture.workspaceId,
    { enabledRoots: [{ sourceType: "workspace", rootDir: "workspace-skill" }, { sourceType: "repo", repoId: "repo_a", rootDir: "ai-skill" }] }
  );
  assert.equal(updated.enabledRoots.length, 2);
  assert.equal(updated.enabledRoots[0]?.sourceType, "workspace");
  assert.equal(updated.enabledRoots[0]?.rootDir, "workspace-skill");
  assert.equal(updated.enabledRoots[1]?.sourceType, "repo");
  assert.equal(updated.enabledRoots[1]?.rootDir, "ai-skill");
});

test("workspace external skills: 非法 rootDir 会被拒绝", async () => {
  const logger = createLogger();
  const fixture = await createFixture();
  const repoPath = path.join(fixture.workspacePath, "repo-b");
  await fs.mkdir(path.join(repoPath, "ai-skill"), { recursive: true });
  await addWorkspaceRepo({
    ctx: fixture.ctx,
    workspaceId: fixture.workspaceId,
    repoId: "repo_b",
    repoDirName: "repo-b",
    repoPath
  });

  await assert.rejects(
    () =>
      updateWorkspaceExternalSkillRootsSettings(
        fixture.ctx,
        logger,
        fixture.workspaceId,
        { enabledRoots: [{ sourceType: "repo", repoId: "repo_b", rootDir: "nested/inner-skill" }] }
      ),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.code === "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID"
  );
});

test("workspace external skills: symlink repo 根/候选目录与失效目录应安全跳过", async () => {
  const logger = createLogger();
  const fixture = await createFixture();

  const repoPath = path.join(fixture.workspacePath, "repo-c");
  await fs.mkdir(path.join(repoPath, "ai-skill"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "linked-target"), { recursive: true });
  await fs.symlink(path.join(repoPath, "linked-target"), path.join(repoPath, "link-skill"), "dir");
  await addWorkspaceRepo({
    ctx: fixture.ctx,
    workspaceId: fixture.workspaceId,
    repoId: "repo_c",
    repoDirName: "repo-c",
    repoPath
  });

  const repoSymlinkPath = path.join(fixture.workspacePath, "repo-symlink");
  await fs.symlink(repoPath, repoSymlinkPath, "dir");
  await addWorkspaceRepo({
    ctx: fixture.ctx,
    workspaceId: fixture.workspaceId,
    repoId: "repo_symlink",
    repoDirName: "repo-symlink",
    repoPath: repoSymlinkPath
  });

  const missingRepoPath = path.join(fixture.workspacePath, "repo-missing");
  await addWorkspaceRepo({
    ctx: fixture.ctx,
    workspaceId: fixture.workspaceId,
    repoId: "repo_missing",
    repoDirName: "repo-missing",
    repoPath: missingRepoPath
  });

  const detected = await detectWorkspaceExternalSkillRoots(fixture.ctx, logger, fixture.workspaceId);
  assert.deepEqual(detected.items.map((it) => `${it.sourceType}/${it.repoId || "-"}/${it.rootDir}`), ["repo/repo_c/ai-skill"]);
});

test("workspace external skills: count 语义与可读口径（直系文件不计数、count=0仍展示、非文本不计数）", async () => {
  const logger = createLogger();
  const fixture = await createFixture();
  const rootDir = "workspace-skill";
  const rootPath = path.join(fixture.workspacePath, rootDir);
  await fs.mkdir(rootPath, { recursive: true });
  await fs.writeFile(path.join(rootPath, "SKILL.md"), "---\nname: root-only\n---\n", "utf8");

  const nonTextDir = path.join(rootPath, "binary-node");
  await fs.mkdir(nonTextDir, { recursive: true });
  await fs.writeFile(path.join(nonTextDir, "SKILL.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x00, 0x61]));

  const detected = await detectWorkspaceExternalSkillRoots(fixture.ctx, logger, fixture.workspaceId);
  const item = detected.items.find((it) => it.sourceType === "workspace" && it.rootDir === rootDir);
  assert.ok(item, "candidate should still be listed when directory exists");
  assert.equal(item?.topLevelSkillCount, 0, "root direct file or non-text top-level node should not be counted");

  const updated = await updateWorkspaceExternalSkillRootsSettings(fixture.ctx, logger, fixture.workspaceId, { enabledRoots: [{ sourceType: "workspace", rootDir }] });
  assert.equal(updated.enabledRoots.length, 1, "count=0 candidate should still be enable-able");
});

test("workspace top-level skills 仅返回可生成 V2 stable identifier 的物理技能", async () => {
  const warnings: Array<{ fields: unknown; message: unknown }> = [];
  const logger = {
    ...createLogger(),
    warn: (fields: unknown, message: unknown) => warnings.push({ fields, message })
  } as unknown as FastifyBaseLogger;
  const fixture = await createFixture();
  const rootDir = "workspace-skill";
  const rootPath = path.join(fixture.workspacePath, rootDir);
  await fs.mkdir(path.join(rootPath, "valid"), { recursive: true });
  await fs.mkdir(path.join(rootPath, " invalid"), { recursive: true });
  await fs.writeFile(path.join(rootPath, "valid", "SKILL.md"), "---\nname: Valid\n---\nbody", "utf8");
  await fs.writeFile(path.join(rootPath, " invalid", "SKILL.md"), "---\nname: Invalid\n---\nbody", "utf8");

  const detected = await detectWorkspaceExternalSkillRoots(fixture.ctx, logger, fixture.workspaceId);
  const candidate = detected.items.find((item) => item.sourceType === "workspace" && item.rootDir === rootDir);
  assert.equal(candidate?.topLevelSkillCount, 2, "physical count retains the existing discovery rule");
  await updateWorkspaceExternalSkillRootsSettings(
    fixture.ctx,
    logger,
    fixture.workspaceId,
    { enabledRoots: [{ sourceType: "workspace", rootDir }] }
  );

  const result = await listWorkspaceTopLevelSkills(fixture.ctx, logger, fixture.workspaceId);
  const workspaceItems = result.items.filter((item) => item.sourceType === "workspace" && item.rootDir === rootDir);
  assert.deepEqual(workspaceItems.map((item) => item.id), [`workspace/${rootDir}/valid`]);
  assert.equal(workspaceItems[0]?.description, "");
  assert.deepEqual(warnings, [{
    fields: { sourceType: "workspace", rootDir },
    message: "skip top-level skill with non-callable identifier"
  }]);
  const serializedWarnings = JSON.stringify(warnings);
  assert.equal(serializedWarnings.includes(rootPath), false, "warning must not expose physical root path");
  assert.equal(serializedWarnings.includes(" invalid"), false, "warning must not expose invalid entry name");
});

test("workspace agent enablement: 默认 all，全部视为启用", async () => {
  const fixture = await createFixture();
  const now = Date.now();
  setSettingJson(fixture.ctx.db, AGENT_SETTINGS_KEY, {
    agents: [
      { id: "agent_a", name: "Agent A", scope: "user", prompt: "" },
      { id: "agent_b", name: "Agent B", scope: "both", prompt: "" }
    ]
  }, now);

  const settings = await getWorkspaceAgentEnablementSettings(fixture.ctx, fixture.workspaceId);
  assert.equal(settings.mode, "all");

  const detected = await detectWorkspaceAgentEnablement(fixture.ctx, fixture.workspaceId);
  assert.equal(detected.items.length, 2);
  assert.equal(detected.items.every((it) => it.enabled), true);
});

test("workspace agent enablement: subset 仅保留存在的 agent 并生效过滤", async () => {
  const fixture = await createFixture();
  const now = Date.now();
  setSettingJson(fixture.ctx.db, AGENT_SETTINGS_KEY, {
    agents: [
      { id: "agent_a", name: "Agent A", scope: "user", prompt: "" },
      { id: "agent_b", name: "Agent B", scope: "both", prompt: "" }
    ]
  }, now);

  const updated = await updateWorkspaceAgentEnablementSettings(fixture.ctx, fixture.workspaceId, {
    mode: "subset",
    enabledAgentIds: ["agent_b", "agent_missing", "agent_b"]
  });
  assert.equal(updated.mode, "subset");
  assert.deepEqual(updated.enabledAgentIds, ["agent_b"]);

  const detected = await detectWorkspaceAgentEnablement(fixture.ctx, fixture.workspaceId);
  assert.deepEqual(
    detected.items.map((it) => ({ id: it.id, enabled: it.enabled })),
    [
      { id: "agent_a", enabled: false },
      { id: "agent_b", enabled: true }
    ]
  );
});

test("workspace agent enablement: subset 空数组表示全不选", async () => {
  const fixture = await createFixture();
  const now = Date.now();
  setSettingJson(fixture.ctx.db, AGENT_SETTINGS_KEY, {
    agents: [{ id: "agent_a", name: "Agent A", scope: "user", prompt: "" }]
  }, now);

  const updated = await updateWorkspaceAgentEnablementSettings(fixture.ctx, fixture.workspaceId, {
    mode: "subset",
    enabledAgentIds: []
  });
  assert.equal(updated.mode, "subset");
  assert.deepEqual(updated.enabledAgentIds, []);

  const detected = await detectWorkspaceAgentEnablement(fixture.ctx, fixture.workspaceId);
  assert.deepEqual(detected.items.map((it) => it.enabled), [false]);
});

test("workspace create: 成功时目录名应为 w_ 随机串且 path 与 dirName 一致", async () => {
  const logger = createLogger();
  const fixture = await createEmptyFixture();

  const ws = await createWorkspace(fixture.ctx, logger, { repoIds: [], title: "workspace title" });
  assert.match(ws.dirName, /^w_[A-Za-z0-9_-]+$/);
  assert.equal(ws.path, workspaceRoot(fixture.ctx.dataDir, ws.dirName));
  assert.equal(await pathExists(ws.path), true);
  assert.equal(ws.title, "workspace title");
});

test("workspace create: git 初始化失败应回滚 DB 与目录", async () => {
  const logger = createLogger();
  const fixture = await createEmptyFixture();
  const now = Date.now();
  // 使用本地不存在的 file:// 作为 origin，确保失败稳定且不依赖网络/DNS。
  const missingOriginAbs = path.join(fixture.ctx.dataDir, "no-such-origin.git");
  insertRepo(fixture.ctx.db, {
    id: "repo_bad",
    url: `file://${missingOriginAbs}`,
    credentialId: null,
    defaultBranch: "main",
    mirrorPath: repoMirrorPath(fixture.ctx.dataDir, "repo_bad"),
    syncStatus: "idle",
    syncError: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now
  });

  const workspaceRootEntriesBefore = await fs.readdir(path.join(fixture.ctx.dataDir, "workspaces")).catch(() => [] as string[]);

  await assert.rejects(
    () => createWorkspace(fixture.ctx, logger, { repoIds: ["repo_bad"], title: "ws" }),
    (err) => err instanceof HttpError && err.statusCode === 409
  );

  assert.equal(listWorkspaces(fixture.ctx.db).length, 0);
  const workspaceRootEntriesAfter = await fs.readdir(path.join(fixture.ctx.dataDir, "workspaces")).catch(() => [] as string[]);
  assert.deepEqual(workspaceRootEntriesAfter.sort(), workspaceRootEntriesBefore.sort());
});

test("workspace delete: 应清理 agent_session 外键引用，避免删一半", async () => {
  const logger = createLogger();
  const fixture = await createEmptyFixture();
  const wsId = "ws_delete_test";
  const wsDirName = "ws_delete_test";
  const wsPath = workspaceRoot(fixture.ctx.dataDir, wsDirName);
  await fs.mkdir(wsPath, { recursive: true });
  const now = Date.now();
  insertWorkspace(fixture.ctx.db, {
    id: wsId,
    dirName: wsDirName,
    title: "ws",
    path: wsPath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now
  });

  fixture.ctx.db.prepare("insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run("sess_1", wsId, "t", "primary", now, now);
  fixture.ctx.db.prepare("insert into agent_attachment (id, workspace_id, storage_key, filename, media_type, byte_size, created_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("att_delete", wsId, "att_delete", "image.png", "image/png", 8, now);
  const db = fixture.ctx.db;
  db.prepare(`insert into agent_message (id, workspace_id, previous_message_id, replaces_message_id, depth, type, status, origin_session_id, origin_run_id, updated_revision, created_at, updated_at)
    values ('message_a', ?, null, null, 0, 'assistant', 'completed', 'sess_1', null, 1, ?, ?)`)
    .run(wsId, now, now);
  db.prepare(`insert into agent_message (id, workspace_id, previous_message_id, replaces_message_id, depth, type, status, origin_session_id, origin_run_id, updated_revision, created_at, updated_at)
    values ('message_b', ?, 'message_a', 'message_a', 1, 'assistant', 'completed', 'sess_1', null, 2, ?, ?)`)
    .run(wsId, now, now);
  db.prepare(`insert into agent_run (run_id, workspace_id, session_id, trigger_message_id, agent_id, provider_id, model_id, status,
    execution_phase, terminal_result_code, created_at, updated_at)
    values ('run_delete', ?, 'sess_1', 'message_a', 'agent', 'provider', 'model', 'completed',
    'terminal', 'run_completed', ?, ?)`)
    .run(wsId, now, now);
  db.prepare(`insert into agent_client_request (workspace_id, session_id, client_request_id, message_id, run_id, created_at)
    values (?, 'sess_1', 'request_delete', 'message_a', 'run_delete', ?)`)
    .run(wsId, now);
  db.prepare(`update agent_session set head_message_id = 'message_b', context_root_message_id = 'message_a', revision = 2 where id = 'sess_1'`).run();
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('text_part', 'message_a', 0, 'text', 'archived content', 1, ?, ?)`)
    .run(now, now);
  db.prepare(`insert into agent_message_part (id, message_id, position, type, attachment_id, media_type, filename, updated_revision, created_at, updated_at)
    values ('image_part', 'message_a', 1, 'image', 'att_delete', 'image/png', 'image.png', 1, ?, ?)`)
    .run(now, now);
  db.prepare(`insert into agent_message_part (id, message_id, position, type, tool_name, tool_input_json, updated_revision, created_at, updated_at)
    values ('call_part', 'message_b', 0, 'tool_call', 'bash', '{}', 2, ?, ?)`)
    .run(now, now);
  db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, status, result_preview, updated_revision, created_at, updated_at)
    values ('execution_a', 'call_part', 'sess_1', 'completed', 'done', 2, ?, ?)`)
    .run(now, now);
  db.prepare(`insert into session_run_state (workspace_id, session_id, status, active_assistant_message_id, non_terminal_message_ids_json, non_terminal_tool_execution_ids_json, updated_at)
    values (?, 'sess_1', 'idle', null, '[]', '[]', ?)`)
    .run(wsId, now);
  db.prepare("insert into agent_archived_text_fts (rowid, text, message_depth, part_position) values (501, 'archived content', 0, 0)").run();
  db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values ('text_part', 501, ?)").run(now);
  const attachmentPath = agentAttachmentFilePath(fixture.ctx.dataDir, wsId, "att_delete");
  await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
  await fs.writeFile(attachmentPath, "attachment");
  const registration = { runtime: { async cancelSessionAndWait() { return true; } }, handoffCoordinator: new SessionRuntimeHandoffCoordinator(), settleWorkspaceRunsForDeletion: () => [] };
  registerWorkspaceRuntime(registration);
  try {
    await deleteWorkspace(fixture.ctx, logger, wsId);
    assert.equal(getWorkspace(fixture.ctx.db, wsId), null);
    const sessions = fixture.ctx.db.prepare(`select count(*) as c from agent_session where workspace_id = ?`).get(wsId) as { c: number };
    assert.equal(sessions.c, 0);
    const attachments = fixture.ctx.db.prepare(`select count(*) as c from agent_attachment where workspace_id = ?`).get(wsId) as { c: number };
    assert.equal(attachments.c, 0);
    for (const table of ["agent_message", "agent_message_part", "agent_tool_execution", "session_run_state", "agent_client_request", "agent_run", "agent_text_part_fts_map"]) {
      const row = fixture.ctx.db.prepare(`select count(*) as c from ${table}`).get() as { c: number };
      assert.equal(row.c, 0, `${table} should be removed with its workspace`);
    }
    const ftsCount = fixture.ctx.db.prepare("select count(*) as c from agent_archived_text_fts").get() as { c: number };
    assert.equal(ftsCount.c, 0);
    await assert.rejects(() => fs.access(agentAttachmentWorkspaceDir(fixture.ctx.dataDir, wsId)));
  } finally {
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace delete: 仅清理目标 Workspace 的 Agent 图与 FTS 数据", async () => {
  const fixture = await createEmptyFixture();
  const logger = createLogger();
  const now = Date.now();
  const db = fixture.ctx.db;

  for (const workspaceId of ["ws-delete-a", "ws-delete-b"]) {
    const dirName = workspaceId;
    const workspacePath = workspaceRoot(fixture.ctx.dataDir, dirName);
    await fs.mkdir(workspacePath, { recursive: true });
    insertWorkspace(db, {
      id: workspaceId,
      dirName,
      title: workspaceId,
      path: workspacePath,
      terminalCredentialId: null,
      createdAt: now,
      updatedAt: now
    });
    db.prepare("insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values (?, ?, ?, 'primary', ?, ?)")
      .run(`session-${workspaceId}`, workspaceId, "Session", now, now);
    db.prepare(`insert into agent_message (id, workspace_id, depth, type, status, updated_revision, created_at, updated_at)
      values (?, ?, 0, 'assistant', 'completed', 1, ?, ?)`)
      .run(`message-${workspaceId}`, workspaceId, now, now);
    db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
      values (?, ?, 0, 'text', ?, 1, ?, ?)`)
      .run(`part-${workspaceId}`, `message-${workspaceId}`, `archive ${workspaceId === "ws-delete-a" ? "workspacea" : "workspaceb"}`, now, now);
    db.prepare("insert into agent_archived_text_fts (rowid, text, message_depth, part_position) values (?, ?, 0, 0)")
      .run(workspaceId === "ws-delete-a" ? 601 : 602, `archive ${workspaceId === "ws-delete-a" ? "workspacea" : "workspaceb"}`);
    db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values (?, ?, ?)")
      .run(`part-${workspaceId}`, workspaceId === "ws-delete-a" ? 601 : 602, now);
  }

  const registration = { runtime: { async cancelSessionAndWait() { return true; } }, handoffCoordinator: new SessionRuntimeHandoffCoordinator(), settleWorkspaceRunsForDeletion: () => [] };
  registerWorkspaceRuntime(registration);
  try {
    await deleteWorkspace(fixture.ctx, logger, "ws-delete-a");
    assert.equal(getWorkspace(db, "ws-delete-a"), null);
    assert.equal((db.prepare("select count(*) as c from agent_message where workspace_id = 'ws-delete-a'").get() as { c: number }).c, 0);
    assert.equal((db.prepare("select count(*) as c from agent_message_part where id = 'part-ws-delete-a'").get() as { c: number }).c, 0);
    assert.equal((db.prepare("select count(*) as c from agent_text_part_fts_map where part_id = 'part-ws-delete-a'").get() as { c: number }).c, 0);
    assert.equal((db.prepare("select count(*) as c from agent_archived_text_fts where rowid = 601").get() as { c: number }).c, 0);
    assert.equal((db.prepare("select count(*) as c from agent_message where workspace_id = 'ws-delete-b'").get() as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_message_part where id = 'part-ws-delete-b'").get() as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_text_part_fts_map where part_id = 'part-ws-delete-b'").get() as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_archived_text_fts where agent_archived_text_fts match 'workspaceb'").get() as { c: number }).c, 1);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace delete: Agent 清理失败时整个删除事务回滚", async () => {
  const fixture = await createEmptyFixture();
  const logger = createLogger();
  const workspaceId = "ws-delete-rollback";
  const workspacePath = workspaceRoot(fixture.ctx.dataDir, workspaceId);
  const now = Date.now();
  await fs.mkdir(workspacePath, { recursive: true });
  insertWorkspace(fixture.ctx.db, {
    id: workspaceId,
    dirName: workspaceId,
    title: "rollback",
    path: workspacePath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now
  });
  const db = fixture.ctx.db;
  db.prepare("insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values ('session-rollback', ?, 'Session', 'primary', ?, ?)")
    .run(workspaceId, now, now);
  db.prepare(`insert into agent_message (id, workspace_id, depth, type, status, updated_revision, created_at, updated_at)
    values ('message-rollback', ?, 0, 'assistant', 'completed', 1, ?, ?)`)
    .run(workspaceId, now, now);
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('part-rollback', 'message-rollback', 0, 'text', 'rollback content', 1, ?, ?)`)
    .run(now, now);
  db.prepare("insert into agent_archived_text_fts (rowid, text, message_depth, part_position) values (701, 'rollback content', 0, 0)").run();
  db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values ('part-rollback', 701, ?)").run(now);
  db.exec(`
    create trigger reject_workspace_agent_message_delete
    before delete on agent_message
    when old.workspace_id = 'ws-delete-rollback'
    begin
      select raise(abort, 'injected agent cleanup failure');
    end;
  `);

  const registration = { runtime: { async cancelSessionAndWait() { return true; } }, handoffCoordinator: new SessionRuntimeHandoffCoordinator(), settleWorkspaceRunsForDeletion: () => [] };
  registerWorkspaceRuntime(registration);
  try {
    await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, workspaceId), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETION_PENDING");
    assert.notEqual(getWorkspace(db, workspaceId), null);
    assert.notEqual(db.prepare("select workspace_id from workspace_deletion where workspace_id = ?").get(workspaceId), undefined);
    assert.equal((db.prepare("select count(*) as c from agent_session where workspace_id = ?").get(workspaceId) as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_message where workspace_id = ?").get(workspaceId) as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_message_part where id = 'part-rollback'").get() as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_text_part_fts_map where part_id = 'part-rollback'").get() as { c: number }).c, 1);
    assert.equal((db.prepare("select count(*) as c from agent_archived_text_fts where rowid = 701").get() as { c: number }).c, 1);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace delete: attachment 目录清理遇不安全路径会保留 tombstone 与 Workspace", async () => {
  const warnings: string[] = [];
  const logger = {
    ...createLogger(),
    warn: (_fields: unknown, message: string) => warnings.push(message)
  } as unknown as FastifyBaseLogger;
  const fixture = await createEmptyFixture();
  const wsId = "ws_delete_attachment_warning";
  const wsDirName = "ws_delete_attachment_warning";
  const wsPath = workspaceRoot(fixture.ctx.dataDir, wsDirName);
  await fs.mkdir(wsPath, { recursive: true });
  const now = Date.now();
  insertWorkspace(fixture.ctx.db, {
    id: wsId,
    dirName: wsDirName,
    title: "ws",
    path: wsPath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now
  });
  const attachmentRoot = agentAttachmentsRoot(fixture.ctx.dataDir);
  const byWorkspaceDir = path.join(attachmentRoot, "by_workspace");
  const outside = path.join(fixture.ctx.dataDir, "outside-attachments");
  await fs.mkdir(attachmentRoot, { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, byWorkspaceDir);

  await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, wsId), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETION_PENDING");

  assert.notEqual(getWorkspace(fixture.ctx.db, wsId), null);
  assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id = ?").get(wsId), undefined);
  assert.deepEqual(warnings, []);
  await assert.doesNotReject(() => fs.access(outside));
});

test("workspace delete DB-first cancel 后等待 runtime drain，期间不持 SQLite 写锁", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const { db } = fixture.ctx;
  db.prepare(`insert into agent_session (id,workspace_id,title,kind,created_at,updated_at)
    values ('delete-running-session', ?, 'Running', 'primary', ?, ?)`).run(fixture.workspaceId, now, now);
  db.prepare(`insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at)
    values ('delete-running-run', ?, 'delete-running-session', null, 'agent', 'provider', 'model', 'running', ?, ?)`).run(fixture.workspaceId, now, now);
  db.prepare(`insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at)
    values (?, 'delete-running-session', 'running', 'delete-running-run', '', 0, null, null, '[]', '[]', ?)`).run(fixture.workspaceId, now);

  const completedEvents: string[] = [];
  const lifecycle = new RunLifecycleApplication({
    persistence: new SqliteRunLifecyclePersistence(db),
    clock: { nowMs: () => now + 1 },
    ids: { newId: () => "evt-delete" },
    promptStaticCacheInvalidator: { clear() {} },
    runCompletedEventPublisher: { publishRunCompleted(event) { completedEvents.push(event.runId); } },
    logger,
    runtimeHandoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    workspaceRunContextReader: { get() { return null; } },
    runStateReader: { get(sessionId) {
      return { workspaceId: fixture.workspaceId, sessionId, status: "idle", activeRunId: null, runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: now };
    } },
    activeSubtaskChildQuery: { listByParentRun() { return []; } },
    triggerInputReader: { getUserText() { return null; } },
    isContextAppendConflict() { return false; },
  });
  let resolveCancel!: () => void;
  const cancelGate = new Promise<void>((resolve) => { resolveCancel = resolve; });
  let notifyCancellation!: () => void;
  const cancellationStarted = new Promise<void>((resolve) => { notifyCancellation = resolve; });
  const runtime = {
    enqueueRun() {},
    cancelSession(sessionId: string) {
      assert.equal(sessionId, "delete-running-session");
      const state = db.prepare("select status, active_run_id as activeRunId from session_run_state where workspace_id = ? and session_id = ?").get(fixture.workspaceId, sessionId) as { status: string; activeRunId: string | null };
      assert.deepEqual(state, { status: "idle", activeRunId: null });
    },
    async cancelSessionAndWait({ sessionId }: { sessionId: string; timeoutMs: number }) {
      assert.equal(sessionId, "delete-running-session");
      const run = db.prepare(`select status, execution_phase as executionPhase,
        terminal_result_code as terminalResultCode
        from agent_run where run_id = 'delete-running-run'`).get() as {
          status: string; executionPhase: string; terminalResultCode: string | null;
        };
      assert.deepEqual(run, {
        status: "cancelled", executionPhase: "terminal", terminalResultCode: "run_cancelled",
      });
      const state = db.prepare("select status, active_run_id as activeRunId from session_run_state where workspace_id = ? and session_id = ?").get(fixture.workspaceId, sessionId);
      assert.deepEqual(state, { status: "idle", activeRunId: null });
      notifyCancellation();
      await cancelGate;
      return true;
    }
  };
  const registration = {
    runtime,
    handoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    settleWorkspaceRunsForDeletion(workspaceId: string) {
      assert.equal(workspaceId, fixture.workspaceId);
      return lifecycle.settleWorkspaceRunsForDeletion(workspaceId);
    },
  };
  registerWorkspaceRuntime(registration);
  try {
    const deleting = deleteWorkspace(fixture.ctx, logger, fixture.workspaceId);
    await cancellationStarted;
    const otherWorkspacePath = workspaceRoot(fixture.ctx.dataDir, "workspace_other");
    await fs.mkdir(otherWorkspacePath, { recursive: true });
    insertWorkspace(db, {
      id: "ws-other", dirName: "workspace_other", title: "other", path: otherWorkspacePath,
      terminalCredentialId: null, createdAt: now, updatedAt: now,
    });
    assert.notEqual(getWorkspace(db, fixture.workspaceId), null, "runtime 未 drain 前不得物理删除");
    resolveCancel();
    await deleting;
    assert.equal(getWorkspace(db, fixture.workspaceId), null);
    assert.notEqual(getWorkspace(db, "ws-other"), null, "等待不应阻塞其他 Workspace 的 DB 写入");
    assert.deepEqual(completedEvents, ["delete-running-run"]);
  } finally {
    lifecycle.dispose();
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace delete 收敛部分失败时不 drain，重试会 drain 已终态和新收敛的全部 Session", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const { db } = fixture.ctx;
  for (const [sessionId, runId] of [["delete-a-session", "delete-a-run"], ["delete-b-session", "delete-b-run"]] as const) {
    db.prepare(`insert into agent_session (id,workspace_id,title,kind,created_at,updated_at)
      values (?, ?, ?, 'primary', ?, ?)`).run(sessionId, fixture.workspaceId, sessionId, now, now);
    db.prepare(`insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at)
      values (?, ?, ?, null, 'agent', 'provider', 'model', 'running', ?, ?)`).run(runId, fixture.workspaceId, sessionId, now, now);
    db.prepare(`insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at)
      values (?, ?, 'running', ?, '', 0, null, null, '[]', '[]', ?)`).run(fixture.workspaceId, sessionId, runId, now);
  }

  const events: string[] = [];
  const cacheClears: string[] = [];
  const sqlitePersistence = new SqliteRunLifecyclePersistence(db);
  let failSecondConvergence = true;
  const persistence = new Proxy(sqlitePersistence, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "convergeRunTerminal") {
        return (input: { runId: string }) => {
          if (failSecondConvergence && input.runId === "delete-b-run") throw new Error("injected convergence failure");
          return target.convergeRunTerminal(input as any);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lifecycle = new RunLifecycleApplication({
    persistence: persistence as any,
    clock: { nowMs: () => now + 1 },
    ids: { newId: () => "evt-delete" },
    promptStaticCacheInvalidator: { clear(runId) { cacheClears.push(runId); } },
    runCompletedEventPublisher: { publishRunCompleted(event) { events.push(event.runId); } },
    logger,
    runtimeHandoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    workspaceRunContextReader: { get() { return null; } },
    runStateReader: { get(sessionId) {
      return { workspaceId: fixture.workspaceId, sessionId, status: "idle", activeRunId: null, runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: now };
    } },
    activeSubtaskChildQuery: { listByParentRun() { return []; } },
    triggerInputReader: { getUserText() { return null; } },
    isContextAppendConflict() { return false; },
  });
  const drained: string[] = [];
  const registration = {
    runtime: { enqueueRun() {}, async cancelSessionAndWait({ sessionId }: { sessionId: string }) { drained.push(sessionId); return true; } },
    handoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    settleWorkspaceRunsForDeletion: (workspaceId: string) => lifecycle.settleWorkspaceRunsForDeletion(workspaceId),
  };
  registerWorkspaceRuntime(registration);
  try {
    await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId), /Workspace deletion remains pending/);
    assert.deepEqual(drained, [], "任一 DB convergence 失败前不得开始 runtime drain");
    assert.deepEqual(events, ["delete-a-run"]);
    assert.deepEqual(cacheClears, ["delete-a-run"]);

    failSecondConvergence = false;
    await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId);
    assert.deepEqual(drained, ["delete-a-session", "delete-b-session"]);
    assert.deepEqual(events, ["delete-a-run", "delete-b-run"], "已终态 Run replay 不得重复事件");
    assert.deepEqual(cacheClears, ["delete-a-run", "delete-b-run"]);
  } finally {
    lifecycle.dispose();
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace delete drain 失败后 runtime 缺失仍 fail closed，重新注册后才物理删除", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const { db } = fixture.ctx;
  db.prepare("insert into agent_session (id,workspace_id,title,kind,created_at,updated_at) values ('timeout-session', ?, 'Running', 'primary', ?, ?)").run(fixture.workspaceId, now, now);
  db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('timeout-run', ?, 'timeout-session', null, 'agent', 'provider', 'model', 'running', ?, ?)").run(fixture.workspaceId, now, now);
  db.prepare("insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at) values (?, 'timeout-session', 'running', 'timeout-run', '', 0, null, null, '[]', '[]', ?)").run(fixture.workspaceId, now);

  const lifecycle = new RunLifecycleApplication({
    persistence: new SqliteRunLifecyclePersistence(db),
    clock: { nowMs: () => now + 1 },
    ids: { newId: () => "evt-timeout" },
    promptStaticCacheInvalidator: { clear() {} },
    runCompletedEventPublisher: { publishRunCompleted() {} },
    logger,
    runtimeHandoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    workspaceRunContextReader: { get() { return null; } },
    runStateReader: { get(sessionId) {
      return { workspaceId: fixture.workspaceId, sessionId, status: "idle", activeRunId: null, runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: now };
    } },
    activeSubtaskChildQuery: { listByParentRun() { return []; } },
    triggerInputReader: { getUserText() { return null; } },
    isContextAppendConflict() { return false; },
  });
  let workerIdle = false;
  const runtime = { enqueueRun() {}, async cancelSessionAndWait() { return workerIdle; } };
  const registration = {
    runtime,
    handoffCoordinator: new SessionRuntimeHandoffCoordinator(),
    settleWorkspaceRunsForDeletion: (workspaceId: string) => lifecycle.settleWorkspaceRunsForDeletion(workspaceId),
  };
  registerWorkspaceRuntime(registration);
  try {
    await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_AGENT_WORKER_DRAIN_TIMEOUT");
    assert.notEqual(getWorkspace(db, fixture.workspaceId), null);
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    assert.notEqual(db.prepare("select workspace_id from workspace_deletion where workspace_id = ?").get(fixture.workspaceId), undefined);
    assert.deepEqual(db.prepare("select status, execution_phase as executionPhase from agent_run where run_id = 'timeout-run'").get(), { status: "cancelled", executionPhase: "terminal" });
    assert.deepEqual(db.prepare("select status, active_run_id as activeRunId from session_run_state where workspace_id = ? and session_id = 'timeout-session'").get(fixture.workspaceId), { status: "idle", activeRunId: null });

    unregisterWorkspaceRuntime(registration);
    await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_AGENT_WORKER_UNAVAILABLE");
    assert.notEqual(getWorkspace(db, fixture.workspaceId), null, "未确认 runtime drain 时不得删除 Workspace");
    assert.notEqual(db.prepare("select workspace_id from workspace_deletion where workspace_id = ?").get(fixture.workspaceId), undefined);
    assert.equal((db.prepare("select count(*) as count from agent_session where workspace_id = ?").get(fixture.workspaceId) as { count: number }).count, 1);
    assert.equal((db.prepare("select count(*) as count from agent_run where workspace_id = ?").get(fixture.workspaceId) as { count: number }).count, 1);

    workerIdle = true;
    registerWorkspaceRuntime(registration);
    await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId);
    assert.equal(getWorkspace(db, fixture.workspaceId), null, "重试成功才物理删除并释放 fence");
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), false);
  } finally {
    unregisterWorkspaceRuntime(registration);
    lifecycle.dispose();
  }
});

test("workspace delete 在 worker 不可达时不物理删除", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  fixture.ctx.db.prepare("insert into agent_session (id,workspace_id,title,kind,created_at,updated_at) values ('unavailable-session', ?, 'Running', 'primary', ?, ?)").run(fixture.workspaceId, now, now);
  fixture.ctx.db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('unavailable-run', ?, 'unavailable-session', null, 'agent', 'provider', 'model', 'running', ?, ?)").run(fixture.workspaceId, now, now);
  fixture.ctx.db.prepare("insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at) values (?, 'unavailable-session', 'running', 'unavailable-run', '', 0, null, null, '[]', '[]', ?)").run(fixture.workspaceId, now);
  const runtime = { enqueueRun() {}, async cancelSessionAndWait() { throw new Error("unreachable"); } };
  const registration = { runtime, handoffCoordinator: new SessionRuntimeHandoffCoordinator(), settleWorkspaceRunsForDeletion: () => ["unavailable-session"] };
  registerWorkspaceRuntime(registration);
  try {
    await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_AGENT_WORKER_UNAVAILABLE");
    assert.notEqual(getWorkspace(fixture.ctx.db, fixture.workspaceId), null);
  } finally {
    unregisterWorkspaceRuntime(registration);
  }
});

test("workspace delete 对 tmux 未知错误保留 tombstone/fence，部分 kill 后重试才统一删除记录", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  insertTerminal(fixture.ctx.db, { id: "term_first", workspaceId: fixture.workspaceId, sessionName: "term_first", status: "active", createdAt: now, updatedAt: now });
  insertTerminal(fixture.ctx.db, { id: "term_second", workspaceId: fixture.workspaceId, sessionName: "term_second", status: "active", createdAt: now, updatedAt: now });
  const killed: string[] = [];
  try {
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async ({ sessionName }) => sessionName === "term_second" ? Promise.reject(new Error("tmux timeout")) : "exists",
        killSession: async ({ sessionName }) => { killed.push(sessionName); },
      }),
      (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_KILL_FAILED",
    );
    assert.deepEqual(killed, ["term_first"]);
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    assert.equal((fixture.ctx.db.prepare("select count(*) as count from terminals where workspace_id=?").get(fixture.workspaceId) as { count: number }).count, 2);
    assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id=?").get(fixture.workspaceId), undefined);

    await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
      hasSession: async () => "not_found",
      killSession: async () => { throw new Error("must not kill absent session"); },
    });
    assert.equal(getWorkspace(fixture.ctx.db, fixture.workspaceId), null);
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), false);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("workspace delete 在删除 terminal records 前清理所有状态的 Git auth artifacts", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const terminals = [
    { id: "term_active", status: "active" as const },
    { id: "term_creating", status: "creating" as const },
    { id: "term_errored", status: "errored" as const },
    { id: "term_closed", status: "closed" as const },
  ];
  for (const term of terminals) {
    insertTerminal(fixture.ctx.db, { ...term, workspaceId: fixture.workspaceId, sessionName: term.id, createdAt: now, updatedAt: now });
    for (const [artifactKind, artifactPath] of [
      ["ssh-key", terminalSshKeyPath(fixture.ctx.dataDir, term.id)],
      ["askpass", terminalAskpassPath(fixture.ctx.dataDir, term.id)],
      ["askpass-token", terminalAskpassTokenPath(fixture.ctx.dataDir, term.id)],
    ] as const) await createRecoverableTerminalAuthArtifact({
      ctx: fixture.ctx, terminalId: term.id, artifactKind, artifactPath, content: term.id, updatedAt: now,
    });
  }
  await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
    hasSession: async () => "not_found",
    killSession: async () => { throw new Error("must not kill absent session"); },
  });
  for (const term of terminals) {
    await assert.rejects(() => fs.access(terminalSshKeyPath(fixture.ctx.dataDir, term.id)));
    await assert.rejects(() => fs.access(terminalAskpassPath(fixture.ctx.dataDir, term.id)));
    await assert.rejects(() => fs.access(terminalAskpassTokenPath(fixture.ctx.dataDir, term.id)));
  }
  assert.equal((fixture.ctx.db.prepare("select count(*) as count from terminals where workspace_id=?").get(fixture.workspaceId) as { count: number }).count, 0);
});

test("workspace delete 对没有 authority intent 的 root live 文件 fail-closed", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const terminalId = "term_no_authority";
  const sshKey = terminalSshKeyPath(fixture.ctx.dataDir, terminalId);
  try {
    insertTerminal(fixture.ctx.db, { id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId, status: "errored", createdAt: now, updatedAt: now });
    await fs.writeFile(sshKey, "victim");
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async () => "not_found",
        killSession: async () => undefined,
      }),
      (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_AUTH_CLEANUP_FAILED",
    );
    await assert.doesNotReject(() => fs.access(sshKey));
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
  } finally { workspaceDeletingFence.end(fixture.workspaceId); }
});

test("workspace delete 在 dataDir root anchor 路径替换时保留 tombstone，恢复后收敛", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const terminalId = "term_workspace_root_move";
  const moved = `${fixture.ctx.dataDir}-moved`;
  try {
    insertTerminal(fixture.ctx.db, { id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId, status: "errored", createdAt: now, updatedAt: now });
    await createRecoverableTerminalAuthArtifact({
      ctx: fixture.ctx, terminalId, artifactKind: "ssh-key", artifactPath: terminalSshKeyPath(fixture.ctx.dataDir, terminalId), content: "secret", updatedAt: now,
    });
    await fs.rename(fixture.ctx.dataDir, moved);
    await fs.mkdir(fixture.ctx.dataDir);
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, { hasSession: async () => "not_found", killSession: async () => undefined }),
      (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_AUTH_CLEANUP_FAILED",
    );
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    await assert.doesNotReject(() => fs.access(terminalSshKeyPath(moved, terminalId)));
    await fs.rm(fixture.ctx.dataDir, { recursive: true, force: true });
    await fs.rename(moved, fixture.ctx.dataDir);
    await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, { hasSession: async () => "not_found", killSession: async () => undefined });
    assert.equal(getWorkspace(fixture.ctx.db, fixture.workspaceId), null);
  } finally {
    await fs.rm(moved, { recursive: true, force: true });
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("workspace delete auth cleanup 失败时保留 records、tombstone 与 fence，重试可收敛", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  insertTerminal(fixture.ctx.db, { id: "term_auth", workspaceId: fixture.workspaceId, sessionName: "term_auth", status: "errored", createdAt: now, updatedAt: now });
  const sshKey = terminalSshKeyPath(fixture.ctx.dataDir, "term_auth");
  await fs.mkdir(path.dirname(sshKey), { recursive: true });
  await createRecoverableTerminalAuthArtifact({
    ctx: fixture.ctx, terminalId: "term_auth", artifactKind: "ssh-key", artifactPath: sshKey, content: "private-key", updatedAt: now,
  });
  try {
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async () => "not_found",
        killSession: async () => undefined,
        cleanupAuthArtifacts: async () => { throw new Error("disk failure"); },
      }),
      (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_AUTH_CLEANUP_FAILED",
    );
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id=?").get(fixture.workspaceId), undefined);
    assert.equal((fixture.ctx.db.prepare("select count(*) as count from terminals where workspace_id=?").get(fixture.workspaceId) as { count: number }).count, 1);
    await assert.doesNotReject(() => fs.access(sshKey));

    await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
      hasSession: async () => "not_found",
      killSession: async () => undefined,
    });
    assert.equal(getWorkspace(fixture.ctx.db, fixture.workspaceId), null);
    await assert.rejects(() => fs.access(sshKey));
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("workspace delete 遇到 auth cleanup locator unresolved 时保留 record、tombstone 与 fence", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  let cleanupCalls = 0;
  insertTerminal(fixture.ctx.db, { id: "term_auth_unresolved", workspaceId: fixture.workspaceId, sessionName: "term_auth_unresolved", status: "errored", createdAt: now, updatedAt: now });
  const root = await fs.stat(fixture.ctx.dataDir);
  armTerminalAuthCleanupIntent(fixture.ctx.db, { terminalId: "term_auth_unresolved", rootDev: root.dev, rootIno: root.ino, updatedAt: now });
  updateTerminalAuthCleanupIntent(fixture.ctx.db, {
    terminalId: "term_auth_unresolved",
    phase: "unresolved",
    artifactName: "term-ssh-key-term_auth_unresolved",
    diagnostic: "auth cleanup locator unresolved: injected migration EIO",
    updatedAt: now + 1,
  });
  try {
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async () => "not_found",
        killSession: async () => undefined,
        cleanupAuthArtifacts: async () => { cleanupCalls += 1; },
      }),
      (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_AUTH_CLEANUP_FAILED",
    );
    assert.equal(cleanupCalls, 0, "unresolved locator 必须在 cleanup callback 前 fail-closed");
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal((fixture.ctx.db.prepare("select count(*) as count from terminals where workspace_id=?").get(fixture.workspaceId) as { count: number }).count, 1);
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id=?").get(fixture.workspaceId), undefined);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

for (const phase of ["armed", "unresolved"] as const) {
  test(`workspace delete 遇到 auth cleanup ${phase} 时跨重试保持 record、tombstone 与 fence`, async () => {
    const fixture = await createFixture();
    const logger = createLogger();
    const now = Date.now();
    let cleanupCalls = 0;
    const terminalId = `term_auth_${phase}`;
    insertTerminal(fixture.ctx.db, { id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId, status: "errored", createdAt: now, updatedAt: now });
    const root = await fs.stat(fixture.ctx.dataDir);
    armTerminalAuthCleanupIntent(fixture.ctx.db, { terminalId, rootDev: root.dev, rootIno: root.ino, updatedAt: now });
    if (phase === "unresolved") {
      updateTerminalAuthCleanupIntent(fixture.ctx.db, { terminalId, phase, artifactName: "unknown", diagnostic: "auth cleanup locator unresolved", updatedAt: now + 1 });
    }
    try {
      await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async () => "not_found",
        killSession: async () => undefined,
        cleanupAuthArtifacts: async () => { cleanupCalls += 1; },
      }), (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_AUTH_CLEANUP_FAILED");
      assert.equal(cleanupCalls, 0);
      assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
      assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
      assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id=?").get(fixture.workspaceId), undefined);
    } finally {
      workspaceDeletingFence.end(fixture.workspaceId);
    }
  });
}

test("workspace delete 对 recoverable auth intent 先清理并在最终事务删除记录", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const terminalId = "term_auth_recoverable";
  let cleanupCalls = 0;
  insertTerminal(fixture.ctx.db, { id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId, status: "errored", createdAt: now, updatedAt: now });
  const root = await fs.stat(fixture.ctx.dataDir);
  const artifactName = path.basename(terminalSshKeyPath(fixture.ctx.dataDir, terminalId));
  armTerminalAuthCleanupIntent(fixture.ctx.db, {
    terminalId, artifactKind: "ssh-key", artifactName, rootDev: root.dev, rootIno: root.ino, updatedAt: now,
  });
  updateTerminalAuthCleanupIntent(fixture.ctx.db, {
    terminalId, artifactKind: "ssh-key", phase: "recoverable", artifactName, rootDev: root.dev, rootIno: root.ino,
    diagnostic: "auth cleanup recoverable in dataDir root slot", updatedAt: now + 1,
  });
  try {
    await deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
      hasSession: async () => "not_found",
      killSession: async () => undefined,
      cleanupAuthArtifacts: async () => { cleanupCalls += 1; },
    });
    assert.equal(cleanupCalls, 1);
    assert.equal(getWorkspace(fixture.ctx.db, fixture.workspaceId), null);
    assert.equal((fixture.ctx.db.prepare("select count(*) as count from terminal_auth_cleanup_intents where terminal_id = ?").get(terminalId) as { count: number }).count, 0);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("workspace delete 的 recoverable clear DELETE IGNORE 时保留 records、tombstone 与 fence", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  const now = Date.now();
  const terminalId = "term_auth_recoverable_clear_ignore";
  insertTerminal(fixture.ctx.db, { id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId, status: "errored", createdAt: now, updatedAt: now });
  const root = await fs.stat(fixture.ctx.dataDir);
  const artifactName = path.basename(terminalSshKeyPath(fixture.ctx.dataDir, terminalId));
  armTerminalAuthCleanupIntent(fixture.ctx.db, {
    terminalId, artifactKind: "ssh-key", artifactName, rootDev: root.dev, rootIno: root.ino, updatedAt: now,
  });
  updateTerminalAuthCleanupIntent(fixture.ctx.db, {
    terminalId, artifactKind: "ssh-key", phase: "recoverable", artifactName, rootDev: root.dev, rootIno: root.ino,
    diagnostic: "recoverable", updatedAt: now + 1,
  });
  fixture.ctx.db.exec(`create trigger ignore_auth_latch_clear before delete on terminal_auth_cleanup_intents
    begin select raise(ignore); end;`);
  try {
    await assert.rejects(() => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
      hasSession: async () => "not_found",
      killSession: async () => undefined,
      cleanupAuthArtifacts: async () => undefined,
    }), /deletion remains pending/);
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal((fixture.ctx.db.prepare("select count(*) as count from terminals where id = ?").get(terminalId) as { count: number }).count, 1);
    assert.equal(getWorkspace(fixture.ctx.db, fixture.workspaceId)?.id, fixture.workspaceId);
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id = ?").get(fixture.workspaceId), undefined);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("workspace delete 在 replacement marker 仍存在时保留 tombstone 与 fence", async () => {
  const fixture = await createFixture();
  const logger = createLogger();
  try {
    await fs.mkdir(path.join(fixture.ctx.dataDir, ".workspace-delete-quarantine"), { recursive: true });
    await fs.writeFile(path.join(fixture.ctx.dataDir, ".workspace-delete-quarantine", ".delete-replacement-pending-victim"), "victim");
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async () => "not_found",
        killSession: async () => undefined,
      }),
      (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_FILE_CLEANUP_REPLACEMENT_PENDING",
    );
    assert.ok(getWorkspace(fixture.ctx.db, fixture.workspaceId));
    assert.equal(workspaceDeletingFence.isDeleting(fixture.workspaceId), true);
    assert.notEqual(fixture.ctx.db.prepare("select workspace_id from workspace_deletion where workspace_id=?").get(fixture.workspaceId), undefined);
    await assert.rejects(
      () => deleteWorkspace(fixture.ctx, logger, fixture.workspaceId, {
        hasSession: async () => "not_found",
        killSession: async () => undefined,
      }),
      (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_FILE_CLEANUP_REPLACEMENT_PENDING",
    );
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("restored tombstone 拒绝 workspace-files 的所有生产写入口", async () => {
  const fixture = await createFixture();
  workspaceDeletingFence.restore(fixture.workspaceId);
  const assertDeleting = async (fn: () => Promise<unknown>) => {
    await assert.rejects(fn, (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING");
  };
  try {
    await assertDeleting(() => writeWorkspaceFileText(fixture.ctx, fixture.workspaceId, { path: "a.txt", content: "x", force: true }));
    await assertDeleting(() => createWorkspaceFile(fixture.ctx, fixture.workspaceId, { path: "b.txt", content: "x" }));
    await assertDeleting(() => mkdirWorkspacePath(fixture.ctx, fixture.workspaceId, { path: "dir" }));
    await assertDeleting(() => renameWorkspacePath(fixture.ctx, fixture.workspaceId, { from: "a.txt", to: "c.txt" }));
    await assertDeleting(() => deleteWorkspacePath(fixture.ctx, fixture.workspaceId, { path: "a.txt", recursive: false }));
    await assert.rejects(() => fs.access(path.join(fixture.workspacePath, "a.txt")));
    await assert.rejects(() => fs.access(path.join(fixture.workspacePath, "b.txt")));
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("files/list: workspace 目录缺失应返回 410", async () => {
  const fixture = await createEmptyFixture();
  const wsId = "ws_missing_dir";
  const wsDirName = "ws_missing_dir";
  const wsPath = workspaceRoot(fixture.ctx.dataDir, wsDirName);
  const now = Date.now();
  // 注意：不创建目录，模拟目录已被删除但 DB 仍存在
  insertWorkspace(fixture.ctx.db, {
    id: wsId,
    dirName: wsDirName,
    title: "ws",
    path: wsPath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now
  });

  await assert.rejects(
    () => listWorkspaceFiles(fixture.ctx, wsId, { dir: "" }),
    (err) => err instanceof HttpError && err.statusCode === 410 && err.code === "WORKSPACE_DIR_MISSING"
  );
});

test("files/list: 子目录不存在应返回 404", async () => {
  const fixture = await createEmptyFixture();
  const wsId = "ws_subdir_missing";
  const wsDirName = "ws_subdir_missing";
  const wsPath = workspaceRoot(fixture.ctx.dataDir, wsDirName);
  await fs.mkdir(wsPath, { recursive: true });
  const now = Date.now();
  insertWorkspace(fixture.ctx.db, {
    id: wsId,
    dirName: wsDirName,
    title: "ws",
    path: wsPath,
    terminalCredentialId: null,
    createdAt: now,
    updatedAt: now
  });

  await assert.rejects(
    () => listWorkspaceFiles(fixture.ctx, wsId, { dir: "missing" }),
    (err) => err instanceof HttpError && err.statusCode === 404
  );
});
