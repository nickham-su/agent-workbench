import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { openDb } from "../../infra/db/db.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { insertRepo } from "../repos/repo.store.js";
import { insertWorkspace, insertWorkspaceRepo } from "./workspace.store.js";
import {
  detectWorkspaceExternalSkillRoots,
  updateWorkspaceExternalSkillRootsSettings
} from "./workspace.service.js";

const tempDirs: string[] = [];

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
