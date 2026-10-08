import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { openDb } from "../../infra/db/db.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import type { AppContext } from "../../app/context.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { encryptUtf8 } from "../../infra/crypto/secretBox.js";
import { insertCredential } from "../credentials/credentials.store.js";
import { insertWorkspace, updateWorkspaceTerminalCredentialId } from "../workspaces/workspace.store.js";
import { createTerminal, deleteTerminal, reconcilePendingTerminals, reconcileWorkspaceActiveTerminals, settleTerminalAfterSessionStopped, type TerminalRuntimeOperations } from "./terminal.service.js";
import { getTerminal, insertTerminal, listActiveTerminalsByWorkspace, listTerminalsByWorkspace, updateTerminalStatus } from "./terminal.store.js";
import {
  assertTerminalGitAuthTerminalId,
  cleanupTerminalGitAuthArtifacts,
  TerminalGitAuthCleanupPendingError,
  terminalAskpassPath,
  terminalAskpassTokenPath,
  terminalSshKeyPath,
  writeTerminalGitAuthArtifact,
} from "./terminal.gitAuth.js";
import {
  armTerminalAuthCleanupIntent,
  getTerminalAuthCleanupIntent,
  listTerminalAuthCleanupIntents,
  updateTerminalAuthCleanupIntent,
} from "./terminal-auth-cleanup-intent.store.js";

const tempDirs: string[] = [];

function createLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => createLogger() } as unknown as FastifyBaseLogger;
}

async function createFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-terminal-service-test-"));
  tempDirs.push(dataDir);
  const db = await openDb(dataDir);
  const workspaceId = `ws_terminal_${path.basename(dataDir)}`;
  const dirName = `workspace_${path.basename(dataDir)}`;
  const workspacePath = workspaceRoot(dataDir, dirName);
  await fs.mkdir(workspacePath, { recursive: true });
  const now = Date.now();
  insertWorkspace(db, { id: workspaceId, dirName, title: "terminal", path: workspacePath, terminalCredentialId: null, createdAt: now, updatedAt: now });
  const ctx = {
    db, repoRoot: process.cwd(), dataDir, fileMaxBytes: 1024 * 1024, version: "test", logLevel: "error", serveWeb: false, webDistDir: null,
    preview: { enabled: false, runtime: null }, credentialMasterKey: Buffer.alloc(32, 1), credentialMasterKeySource: "generated", credentialMasterKeyId: "test", credentialMasterKeyCreatedAt: now,
    authToken: null, authCookieSecure: false, agentWorkerEnabled: false, agentWorkerHost: "127.0.0.1", agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(dataDir, "worker.sock"), agentWorkerConcurrency: 1, agentInternalToken: "test", agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0", agentPluginHostEnabled: false, agentPluginHostSocketPath: path.join(dataDir, "plugin.sock"), agentPluginServicesEnabled: false,
  } satisfies AppContext;
  return { ctx, workspaceId };
}

function operations(overrides: Partial<TerminalRuntimeOperations> = {}): TerminalRuntimeOperations {
  return {
    hasSession: async () => "not_found",
    killSession: async () => {},
    newSession: async () => {},
    cleanupAuthArtifacts: async () => {},
    ...overrides,
  };
}

afterEach(async () => {
  for (const dataDir of tempDirs.splice(0)) await fs.rm(dataDir, { recursive: true, force: true });
});

test("Terminal 创建先持久化 creating，成功后只返回 active record", async () => {
  const fixture = await createFixture();
  try {
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    assert.equal(term.status, "active");
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "active");
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
    fixture.ctx.db.close();
  }
});

test("SSH live artifact 直接锚定 dataDir root；active 保留 recoverable locator", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, {
      id: "cred_auth_active", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "test-key" }), isDefault: false, createdAt: now, updatedAt: now,
    });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_auth_active", now);
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    assert.equal(term.status, "active");
    const intents = listTerminalAuthCleanupIntents(fixture.ctx.db, term.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.artifactKind, "ssh-key");
    assert.equal(intents[0]?.phase, "recoverable");
    assert.ok(intents[0]?.expectedDev !== null && intents[0]?.expectedIno !== null);
    assert.equal(path.dirname(terminalSshKeyPath(fixture.ctx.dataDir, term.id)), fixture.ctx.dataDir);
    await assert.doesNotReject(() => fs.access(terminalSshKeyPath(fixture.ctx.dataDir, term.id)));
  } finally { fixture.ctx.db.close(); }
});

test("artifact arm INSERT IGNORE 时不进入 writer，creating record 保留但不发布", async () => {
  const fixture = await createFixture();
  let writeCalled = false;
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_arm_ignore", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_arm_ignore", now);
    fixture.ctx.db.exec(`create trigger ignore_auth_latch_arm before insert on terminal_auth_cleanup_intents begin select raise(ignore); end;`);
    await assert.rejects(() => createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, writeAuthArtifactForTest: async () => { writeCalled = true; } }), /latch arm was not persisted/);
    assert.equal(writeCalled, false);
    assert.equal(listTerminalAuthCleanupIntents(fixture.ctx.db, listTerminalsByWorkspace(fixture.ctx.db, fixture.workspaceId)[0]!.id).length, 0);
  } finally { fixture.ctx.db.close(); }
});

test("SSH root live artifact 后 tmux 失败时安全清理并 closed", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_tmux_fail", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_tmux_fail", now);
    await assert.rejects(() => createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations({ newSession: async () => { throw new Error("tmux failed"); }, cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }) }), /tmux session was not created/);
    const term = listTerminalsByWorkspace(fixture.ctx.db, fixture.workspaceId)[0]!;
    assert.equal(term.status, "closed");
    assert.deepEqual(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id), []);
    await assert.rejects(() => fs.access(terminalSshKeyPath(fixture.ctx.dataDir, term.id)));
  } finally { fixture.ctx.db.close(); }
});

test("tmp 移动不影响 root live artifact 的 cleanup", async () => {
  const fixture = await createFixture();
  const tmp = path.join(fixture.ctx.dataDir, "tmp");
  const moved = path.join(fixture.ctx.dataDir, "moved-tmp");
  try {
    await fs.mkdir(tmp);
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_tmp_move", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_tmp_move", now);
    await assert.rejects(() => createTerminal(fixture.ctx, createLogger(), {
      workspaceId: fixture.workspaceId, shell: "sh",
      writeAuthArtifactForTest: async (input) => writeTerminalGitAuthArtifact({ ...input, afterArtifactCreatedForTest: async () => { await fs.rename(tmp, moved); await fs.mkdir(tmp); } }),
      runtimeOperations: operations({ newSession: async () => { throw new Error("tmux failed"); }, cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }),
    }), /tmux session was not created|cleanup pending/);
    const term = listTerminalsByWorkspace(fixture.ctx.db, fixture.workspaceId)[0]!;
    assert.equal(term.status, "closed");
    await assert.rejects(() => fs.access(terminalSshKeyPath(fixture.ctx.dataDir, term.id)));
  } finally { fixture.ctx.db.close(); }
});

test("intent store 拒绝无效 root anchor，并在 unresolved 更新时保留最后可信 anchor", async () => {
  const fixture = await createFixture();
  try {
    const terminalId = "term_root_anchor_store";
    const now = Date.now();
    insertTerminal(fixture.ctx.db, {
      id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId,
      status: "errored", createdAt: now, updatedAt: now,
    });
    assert.throws(() => armTerminalAuthCleanupIntent(fixture.ctx.db, {
      terminalId, artifactKind: "ssh-key", rootDev: -1, rootIno: 1, updatedAt: now,
    }), /root anchor is invalid/);
    assert.equal(listTerminalAuthCleanupIntents(fixture.ctx.db, terminalId).length, 0);

    const root = await fs.stat(fixture.ctx.dataDir);
    const artifactName = path.basename(terminalSshKeyPath(fixture.ctx.dataDir, terminalId));
    armTerminalAuthCleanupIntent(fixture.ctx.db, {
      terminalId, artifactKind: "ssh-key", artifactName, rootDev: root.dev, rootIno: root.ino, updatedAt: now,
    });
    updateTerminalAuthCleanupIntent(fixture.ctx.db, {
      terminalId, artifactKind: "ssh-key", phase: "unresolved", artifactName,
      diagnostic: "injected unresolved cleanup", updatedAt: now + 1,
    });
    const unresolved = getTerminalAuthCleanupIntent(fixture.ctx.db, terminalId, "ssh-key");
    assert.equal(unresolved?.rootDev, root.dev);
    assert.equal(unresolved?.rootIno, root.ino);
    assert.throws(() => updateTerminalAuthCleanupIntent(fixture.ctx.db, {
      terminalId, artifactKind: "ssh-key", phase: "recoverable", artifactName,
      rootDev: -1, rootIno: root.ino, diagnostic: "invalid", updatedAt: now + 2,
    }), /root anchor is invalid/);
    assert.equal(getTerminalAuthCleanupIntent(fixture.ctx.db, terminalId, "ssh-key")?.phase, "unresolved");
  } finally { fixture.ctx.db.close(); }
});

test("HTTPS askpass 与 token 分别持有 recoverable intent，删除时一并收敛", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_https", host: "example.test", kind: "https", label: null, username: "oauth2",
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "token" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_https", now);
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    assert.deepEqual(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id).map((row) => row.artifactKind), ["askpass", "askpass-token"]);
    await deleteTerminal(fixture.ctx, createLogger(), term.id, operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }));
    assert.equal(getTerminal(fixture.ctx.db, term.id), null);
    await assert.rejects(() => fs.access(terminalAskpassPath(fixture.ctx.dataDir, term.id)), /ENOENT/);
    await assert.rejects(() => fs.access(terminalAskpassTokenPath(fixture.ctx.dataDir, term.id)), /ENOENT/);
  } finally { fixture.ctx.db.close(); }
});

test("active terminal 的 tmux 已不存在且 cleanup pending 时转为 errored 并保留 intent", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_stale_active", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_stale_active", now);
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    const intents = listTerminalAuthCleanupIntents(fixture.ctx.db, term.id);

    await reconcileWorkspaceActiveTerminals(fixture.ctx, createLogger(), fixture.workspaceId, {
      hasSession: async () => "not_found",
      cleanupAuthArtifacts: async () => { throw new TerminalGitAuthCleanupPendingError("injected cleanup pending"); },
    });

    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "errored");
    assert.deepEqual(listActiveTerminalsByWorkspace(fixture.ctx.db, fixture.workspaceId), []);
    assert.deepEqual(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id), intents);
  } finally { fixture.ctx.db.close(); }
});

test("已确认 tmux 停止后的 cleanup pending 可供 WS 映射为 session not found", async () => {
  const fixture = await createFixture();
  try {
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    const settlement = await settleTerminalAfterSessionStopped(fixture.ctx, createLogger(), term.id, {
      cleanupAuthArtifacts: async () => { throw new TerminalGitAuthCleanupPendingError("injected cleanup pending"); },
    });

    assert.equal(settlement, "cleanup_pending");
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "errored");
  } finally { fixture.ctx.db.close(); }
});

test("用户删除在 tmux kill 成功但 cleanup pending 时逻辑成功并保留 errored intent", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    const killed: string[] = [];
    insertCredential(fixture.ctx.db, { id: "cred_delete_pending", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_delete_pending", now);
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    const intents = listTerminalAuthCleanupIntents(fixture.ctx.db, term.id);

    await assert.doesNotReject(() => deleteTerminal(fixture.ctx, createLogger(), term.id, operations({
      hasSession: async () => "exists",
      killSession: async ({ sessionName }) => { killed.push(sessionName); },
      cleanupAuthArtifacts: async () => { throw new TerminalGitAuthCleanupPendingError("injected cleanup pending"); },
    })));

    assert.deepEqual(killed, [term.sessionName]);
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "errored");
    assert.deepEqual(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id), intents);
    await assert.doesNotReject(() => fs.access(terminalSshKeyPath(fixture.ctx.dataDir, term.id)));
  } finally { fixture.ctx.db.close(); }
});

test("tmux probe 或 kill 失败时删除不谎称终端已关闭", async () => {
  const fixture = await createFixture();
  try {
    for (const runtimeOperations of [
      operations({ hasSession: async () => { throw new Error("tmux probe indeterminate"); } }),
      operations({ hasSession: async () => "exists", killSession: async () => { throw new Error("tmux kill failed"); } }),
    ]) {
      const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
      await assert.rejects(() => deleteTerminal(fixture.ctx, createLogger(), term.id, runtimeOperations), /tmux (probe indeterminate|kill failed)/);
      assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "active");
    }
  } finally { fixture.ctx.db.close(); }
});

test("root live unlink EIO 保留 intent，restart reconcile 后收敛", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_eio", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_eio", now);
    await assert.rejects(() => createTerminal(fixture.ctx, createLogger(), {
      workspaceId: fixture.workspaceId, shell: "sh",
      writeAuthArtifactForTest: async (input) => writeTerminalGitAuthArtifact({ ...input, removeRetiredForTest: () => false }),
      runtimeOperations: operations({
        newSession: async () => { throw new Error("tmux failed"); },
        cleanupAuthArtifacts: (dataDir, terminalId, intents) => cleanupTerminalGitAuthArtifacts(dataDir, terminalId, intents, { removeRetiredForTest: () => false }),
      }),
    }), /tmux session was not created|cleanup pending/);
    const term = listTerminalsByWorkspace(fixture.ctx.db, fixture.workspaceId)[0]!;
    assert.equal(term.status, "errored");
    assert.equal(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id)[0]?.phase, "recoverable");
    await reconcilePendingTerminals(fixture.ctx, createLogger(), operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }));
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "closed");
    assert.deepEqual(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id), []);
  } finally { fixture.ctx.db.close(); }
});

test("writer EEXIST 无 authority 时保留 hardlink witness，不写新 secret", async () => {
  const fixture = await createFixture();
  const terminalId = "term_eexist_witness";
  const live = terminalSshKeyPath(fixture.ctx.dataDir, terminalId);
  const witness = path.join(fixture.ctx.dataDir, "witness");
  try {
    await fs.writeFile(live, "victim");
    await fs.link(live, witness);
    const root = await fs.stat(fixture.ctx.dataDir);
    let callbackCalled = false;
    await assert.rejects(() => writeTerminalGitAuthArtifact({
      dataDir: fixture.ctx.dataDir, terminalId, kind: "ssh-key", content: "new-secret", mode: 0o600,
      rootDev: root.dev, rootIno: root.ino,
      markRecoverableCleanup: () => { callbackCalled = true; },
    }), TerminalGitAuthCleanupPendingError);
    assert.equal(callbackCalled, false);
    assert.equal(await fs.readFile(live, "utf8"), "victim");
    assert.equal(await fs.readFile(witness, "utf8"), "victim");
    assert.equal((await fs.stat(live)).ino, (await fs.stat(witness)).ino);
  } finally { fixture.ctx.db.close(); }
});

test("SSH root anchor 路径替换时逻辑删除成功但保留 errored intent；恢复原路径后可收敛", async () => {
  const fixture = await createFixture();
  const moved = `${fixture.ctx.dataDir}-moved`;
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_root_move", host: "example.test", kind: "ssh", label: null, username: null,
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "key" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_root_move", now);
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    updateTerminalStatus(fixture.ctx.db, term.id, "errored", now + 1);
    const movedSecret = terminalSshKeyPath(moved, term.id);
    await fs.rename(fixture.ctx.dataDir, moved);
    await fs.mkdir(fixture.ctx.dataDir);
    await reconcilePendingTerminals(fixture.ctx, createLogger(), operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }));
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "errored");
    await assert.doesNotReject(() => fs.access(movedSecret));
    await assert.doesNotReject(() => deleteTerminal(fixture.ctx, createLogger(), term.id, operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts })));
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "errored");
    assert.equal(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id).length, 1);
    await assert.doesNotReject(() => fs.access(movedSecret));
    await fs.rm(fixture.ctx.dataDir, { recursive: true, force: true });
    await fs.rename(moved, fixture.ctx.dataDir);
    await deleteTerminal(fixture.ctx, createLogger(), term.id, operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }));
    assert.equal(getTerminal(fixture.ctx.db, term.id), null);
  } finally {
    await fs.rm(moved, { recursive: true, force: true });
    fixture.ctx.db.close();
  }
});

test("HTTPS 两个 root anchor 在路径替换后共同阻断，恢复后可收敛", async () => {
  const fixture = await createFixture();
  const moved = `${fixture.ctx.dataDir}-moved`;
  try {
    const now = Date.now();
    insertCredential(fixture.ctx.db, { id: "cred_https_root_move", host: "example.test", kind: "https", label: null, username: "oauth2",
      secretEnc: encryptUtf8({ key: fixture.ctx.credentialMasterKey, plaintext: "token" }), isDefault: false, createdAt: now, updatedAt: now });
    updateWorkspaceTerminalCredentialId(fixture.ctx.db, fixture.workspaceId, "cred_https_root_move", now);
    const term = await createTerminal(fixture.ctx, createLogger(), { workspaceId: fixture.workspaceId, shell: "sh", runtimeOperations: operations() });
    assert.equal(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id).length, 2);
    updateTerminalStatus(fixture.ctx.db, term.id, "errored", now + 1);
    await fs.rename(fixture.ctx.dataDir, moved);
    await fs.mkdir(fixture.ctx.dataDir);
    await reconcilePendingTerminals(fixture.ctx, createLogger(), operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }));
    assert.equal(getTerminal(fixture.ctx.db, term.id)?.status, "errored");
    assert.equal(listTerminalAuthCleanupIntents(fixture.ctx.db, term.id).length, 2);
    await fs.rm(fixture.ctx.dataDir, { recursive: true, force: true });
    await fs.rename(moved, fixture.ctx.dataDir);
    await deleteTerminal(fixture.ctx, createLogger(), term.id, operations({ cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts }));
    assert.equal(getTerminal(fixture.ctx.db, term.id), null);
  } finally {
    await fs.rm(moved, { recursive: true, force: true });
    fixture.ctx.db.close();
  }
});

test("root live replacement 不删除 victim，保持 pending", async () => {
  const fixture = await createFixture();
  const terminalId = "term_root_replace";
  const now = Date.now();
  try {
    insertTerminal(fixture.ctx.db, { id: terminalId, workspaceId: fixture.workspaceId, sessionName: terminalId, status: "errored", createdAt: now, updatedAt: now });
    const name = terminalSshKeyPath(fixture.ctx.dataDir, terminalId).split("/").at(-1)!;
    const root = await fs.stat(fixture.ctx.dataDir);
    armTerminalAuthCleanupIntent(fixture.ctx.db, { terminalId, artifactKind: "ssh-key", artifactName: name, rootDev: root.dev, rootIno: root.ino, updatedAt: now });
    updateTerminalAuthCleanupIntent(fixture.ctx.db, { terminalId, artifactKind: "ssh-key", phase: "recoverable", artifactName: name, expectedDev: 1, expectedIno: 1, rootDev: root.dev, rootIno: root.ino, diagnostic: "test", updatedAt: now + 1 });
    await fs.writeFile(path.join(fixture.ctx.dataDir, name), "victim");
    await assert.rejects(() => cleanupTerminalGitAuthArtifacts(fixture.ctx.dataDir, terminalId, listTerminalAuthCleanupIntents(fixture.ctx.db, terminalId)), TerminalGitAuthCleanupPendingError);
    assert.equal(await fs.readFile(path.join(fixture.ctx.dataDir, name), "utf8"), "victim");
  } finally { fixture.ctx.db.close(); }
});

test("Terminal Git auth terminal ID 必须为非空 term_ 安全段", () => {
  for (const terminalId of ["term_", "../term_safe", "term_../unsafe", "term/a"]) {
    assert.throws(() => assertTerminalGitAuthTerminalId(terminalId), /invalid terminal ID/);
  }
  assert.equal(assertTerminalGitAuthTerminalId("term_safe-1"), "term_safe-1");
});

test("Terminal 默认 shell 仅在首次 probe 明确 not-found 后 fallback", async () => {
  const fixture = await createFixture();
  const commands: string[][] = [];
  try {
    const terminal = await createTerminal(fixture.ctx, createLogger(), {
      workspaceId: fixture.workspaceId,
      runtimeOperations: operations({
        newSession: async ({ command }) => {
          commands.push(command);
          if (commands.length === 1) throw new Error("bash unavailable");
        },
        hasSession: async () => "not_found",
      }),
    });
    assert.equal(terminal.status, "active");
    assert.equal(commands.length, 2);
    assert.equal(commands[1]?.at(-1), "sh");
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
    fixture.ctx.db.close();
  }
});

test("Terminal 默认 shell 在 new-session response-loss probe 为 exists 时绝不 fallback", async () => {
  const fixture = await createFixture();
  let calls = 0;
  try {
    await assert.rejects(() => createTerminal(fixture.ctx, createLogger(), {
      workspaceId: fixture.workspaceId,
      runtimeOperations: operations({
        newSession: async () => { calls += 1; throw new Error("response lost"); },
        hasSession: async () => "exists",
        killSession: async () => { throw new Error("kill pending"); },
      }),
    }), /cleanup pending/);
    assert.equal(calls, 1);
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
    fixture.ctx.db.close();
  }
});

test("Terminal new-session response-loss 发现已存在 session 时不把 orphan 标记为 closed", async () => {
  const fixture = await createFixture();
  let terminalId = "";
  const killed: string[] = [];
  try {
    await assert.rejects(
      () => createTerminal(fixture.ctx, createLogger(), {
        workspaceId: fixture.workspaceId,
        shell: "sh",
        runtimeOperations: operations({
          newSession: async ({ sessionName }) => {
            terminalId = sessionName.replace(/^term_/, "");
            throw new Error("response lost after tmux created session");
          },
          hasSession: async () => "exists",
          killSession: async () => { throw new Error("kill response lost"); },
        }),
      }),
      /cleanup pending/,
    );
    assert.ok(terminalId);
    assert.equal(getTerminal(fixture.ctx.db, terminalId)?.status, "errored");

    await reconcilePendingTerminals(fixture.ctx, createLogger(), operations({
      hasSession: async () => "exists",
      killSession: async ({ sessionName }) => { killed.push(sessionName); },
    }));
    assert.deepEqual(killed, [`term_${terminalId}`]);
    assert.equal(getTerminal(fixture.ctx.db, terminalId)?.status, "closed");
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
    fixture.ctx.db.close();
  }
});

test("Terminal active 收尾失败且补偿 kill 失败时保留 errored intent，reconcile 可收敛", async () => {
  const fixture = await createFixture();
  const killed: string[] = [];
  let terminalId = "";
  fixture.ctx.db.exec(`
    create trigger reject_terminal_activation
    before update of status on terminals
    when new.status = 'active'
    begin select raise(abort, 'forced activation failure'); end;
  `);
  try {
    await assert.rejects(
      () => createTerminal(fixture.ctx, createLogger(), {
        workspaceId: fixture.workspaceId,
        shell: "sh",
        runtimeOperations: operations({
          newSession: async ({ sessionName }) => { terminalId = sessionName.replace(/^term_/, ""); },
          killSession: async () => { throw new Error("forced kill failure"); },
        }),
      }),
      /cleanup pending/,
    );
    assert.ok(terminalId, "tmux session must have a durable terminal id before activation");
    assert.equal(getTerminal(fixture.ctx.db, terminalId)?.status, "errored");

    await reconcilePendingTerminals(fixture.ctx, createLogger(), operations({
      hasSession: async () => "exists",
      killSession: async ({ sessionName }) => { killed.push(sessionName); },
    }));
    assert.deepEqual(killed, [`term_${terminalId}`]);
    assert.equal(getTerminal(fixture.ctx.db, terminalId)?.status, "closed");
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
    fixture.ctx.db.close();
  }
});
