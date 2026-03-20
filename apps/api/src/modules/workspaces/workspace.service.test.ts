import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { openDb } from "../../infra/db/db.js";
import { repoMirrorPath, workspaceRoot } from "../../infra/fs/paths.js";
import { pathExists } from "../../infra/fs/fs.js";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { insertRepo } from "../repos/repo.store.js";
import { createAgentSession } from "../agent/agent.store.js";
import { listWorkspaceFiles } from "./workspace-files.service.js";
import { getWorkspace, insertWorkspace, insertWorkspaceRepo, listWorkspaces } from "./workspace.store.js";
import {
  createWorkspace,
  deleteWorkspace,
  detectWorkspaceExternalSkillRoots,
  detectWorkspaceAgentEnablement,
  getWorkspaceAgentEnablementSettings,
  updateWorkspaceAgentEnablementSettings,
  updateWorkspaceExternalSkillRootsSettings
} from "./workspace.service.js";
import { setSettingJson } from "../settings/settings.store.js";
import { registerGlobalSystemPromptTextProvider } from "../settings/settings.service.js";

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
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
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
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
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

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
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

  await assert.rejects(
    () => createWorkspace(fixture.ctx, logger, { repoIds: ["repo_bad"], title: "ws" }),
    (err) => err instanceof HttpError && err.statusCode === 409
  );

  assert.equal(listWorkspaces(fixture.ctx.db).length, 0);
  assert.equal(await pathExists(workspaceRoot(fixture.ctx.dataDir, "ws")), false);
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

  createAgentSession(fixture.ctx.db, { id: "sess_1", workspaceId: wsId, title: "t", kind: "primary", createdAt: now });
  await deleteWorkspace(fixture.ctx, logger, wsId);
  assert.equal(getWorkspace(fixture.ctx.db, wsId), null);
  const sessions = fixture.ctx.db.prepare(`select count(*) as c from agent_session where workspace_id = ?`).get(wsId) as { c: number };
  assert.equal(sessions.c, 0);
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
