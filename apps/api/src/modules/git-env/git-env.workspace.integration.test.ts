import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import Fastify from "fastify";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import { createTestRepository } from "../agent/testkit/agent-testkit.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { registerWorkspaceRuntime, unregisterWorkspaceRuntime } from "../agent/lifecycle/workspace-runtime-registry.js";
import { SessionRuntimeHandoffCoordinator } from "../agent/lifecycle/session-runtime-handoff-coordinator.js";
import { recoverAfterAgentRuntimeReady } from "../agent/agent-runtime-ready.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import { registerWorkspacesModule } from "../workspaces/workspaces.module.js";
import { deleteWorkspace, detachRepoFromWorkspace, resumePendingWorkspaceDeletions } from "../workspaces/workspace.service.js";
import { getWorkspace, getWorkspaceRepoByDirName } from "../workspaces/workspace.store.js";
import { upsertWorkspaceDeletionIntent } from "../workspaces/workspace-deletion.store.js";
import { registerGitEnvModule } from "./git-env.module.js";
import { createRepoGitEnvLease, inspectRepoGitEnvLease, listRepoGitEnvLeaseIds, releaseRepoGitEnvLease } from "./git-env.lease.js";
import { prepareRepoGitEnvLease } from "./git-env.repo-service.js";
import { assertCode, createGitLeaseFixture, leaseMeta } from "./git-env.testkit.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function runtimeRegistration() {
  const runtime: AgentRuntimePort = {
    enqueueRun: () => { throw new Error("Deletion must not enqueue business work"); },
    cancelSession: () => undefined,
    cancelSessionAndWait: async () => true,
  };
  return { runtime, handoffCoordinator: new SessionRuntimeHandoffCoordinator(), settleWorkspaceRunsForDeletion: () => [] as string[] };
}

test("AC-CONCURRENCY-DETACH/TARGET: active A protects A but does not prevent detaching B; release allows A", async (t) => {
  const f = await createGitLeaseFixture(t), app = Fastify({ logger: false });
  const other = await createTestRepository(f, { workspace: f.workspace, dirName: "other" });
  const prepared = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
  assert(prepared.ok);
  await assert.rejects(detachRepoFromWorkspace(f.ctx, app.log, f.workspace.id, f.repository.repo.id), assertCode("REPO_GIT_BUSY"));
  assert(getWorkspaceRepoByDirName(f.db, f.workspace.id, f.request.repo));
  assert((await fs.stat(f.repository.workspaceRepo.path)).isDirectory());
  await detachRepoFromWorkspace(f.ctx, app.log, f.workspace.id, other.repo.id);
  assert.equal(getWorkspaceRepoByDirName(f.db, f.workspace.id, "other"), null);
  await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: prepared.leaseId, stopEvidence: "not_started" } });
  await detachRepoFromWorkspace(f.ctx, app.log, f.workspace.id, f.repository.repo.id);
  assert.equal(getWorkspaceRepoByDirName(f.db, f.workspace.id, f.request.repo), null);
  await assert.rejects(fs.stat(f.repository.workspaceRepo.path), { code: "ENOENT" });
  await app.close();
});

for (const first of ["prepare", "detach"] as const) test(`AC-CONCURRENCY-DETACH: ${first} wins the Workspace gate`, async (t) => {
  const f = await createGitLeaseFixture(t), app = Fastify({ logger: false });
  const entered = deferred(), proceed = deferred();
  let intercepted = false;
  if (first === "prepare") {
    const original = fs.rename;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (!intercepted && String(args[0]).includes(".meta-")) { intercepted = true; entered.resolve(); await proceed.promise; }
      return original(...args);
    });
    const preparing = prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
    await entered.promise;
    const detaching = detachRepoFromWorkspace(f.ctx, app.log, f.workspace.id, f.repository.repo.id);
    // Install rejection handling before allowing the first operation to finish.
    const refused = assert.rejects(detaching, assertCode("REPO_GIT_BUSY"));
    await setImmediate(); proceed.resolve();
    assert((await preparing).ok); await refused;
    assert(getWorkspaceRepoByDirName(f.db, f.workspace.id, f.request.repo));
    assert((await fs.stat(f.repository.workspaceRepo.path)).isDirectory());
  } else {
    const original = fs.rm;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (!intercepted && String(args[0]) === f.repository.workspaceRepo.path) { intercepted = true; entered.resolve(); await proceed.promise; }
      return original(...args);
    });
    const detaching = detachRepoFromWorkspace(f.ctx, app.log, f.workspace.id, f.repository.repo.id);
    await entered.promise;
    const preparing = prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
    await setImmediate(); proceed.resolve(); await detaching;
    const result = await preparing; assert(!result.ok); assert.equal(result.errorCode, "REPO_NOT_AVAILABLE");
  }
  await app.close();
});

for (const corrupt of [false, true]) test(`AC-CONCURRENCY-DELETE/LEASE-BAD-META: idle session and terminal Run do not authorize deletion; corrupt=${corrupt}`, async (t) => {
  // The existing secure recursive deletion rejects non-ASCII/space entries;
  // keep this test focused on lease protection rather than that older constraint.
  const f = await createGitLeaseFixture(t, { repoName: "fixture-repo" }), app = Fastify({ logger: false });
  const prepared = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(prepared.ok);
  if (corrupt) await fs.writeFile(path.join(f.dataDir, "tmp", "git-env", "v2", prepared.leaseId, "meta.json"), "{}");
  f.db.prepare("update agent_run set status='completed', execution_phase='terminal', terminal_result_code='run_completed' where run_id=?").run(f.owner.runId);
  f.db.prepare("update session_run_state set status='idle', active_run_id=null where session_id=?").run(f.owner.sessionId);
  const registration = runtimeRegistration(); registerWorkspaceRuntime(registration);
  try {
    await assert.rejects(deleteWorkspace(f.ctx, app.log, f.workspace.id), assertCode(corrupt ? "GIT_LEASE_STATE_UNAVAILABLE" : "REPO_GIT_BUSY"));
    assert(getWorkspace(f.db, f.workspace.id)); assert(getWorkspaceRepoByDirName(f.db, f.workspace.id, f.request.repo));
    assert(f.db.prepare("select workspace_id from workspace_deletion where workspace_id=?").get(f.workspace.id));
    assert((await fs.stat(f.workspace.path)).isDirectory()); assert(workspaceDeletingFence.isDeleting(f.workspace.id));
    if (!corrupt) {
      await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: prepared.leaseId, stopEvidence: "managed_group_absent" } });
      await deleteWorkspace(f.ctx, app.log, f.workspace.id);
      assert.equal(getWorkspace(f.db, f.workspace.id), null);
    }
  } finally { unregisterWorkspaceRuntime(registration); workspaceDeletingFence.end(f.workspace.id); await app.close(); }
});

for (const managed of [false, true]) for (const corrupt of [false, true]) test(`AC-LEASE-STARTUP/WORKER-DISABLED: two API lifecycles preserve pending deletion, managed-ready=${managed}, bad-meta=${corrupt}`, async (t) => {
  const f = await createGitLeaseFixture(t, { repoName: "fixture-repo" });
  let firstApp: Awaited<ReturnType<typeof createApp>> | undefined;
  let secondApp: Awaited<ReturnType<typeof createApp>> | undefined;
  let secondDb: Awaited<ReturnType<typeof openDb>> | undefined;
  let registration: ReturnType<typeof runtimeRegistration> | undefined;
  const meta = leaseMeta(f, { createdAt: new Date(Date.now() - 70 * 60_000).toISOString() });
  try {
    firstApp = await createApp(f.ctx); await firstApp.ready();
    const leasePath = await createRepoGitEnvLease({ dataDir: f.dataDir, meta });
    assert(leasePath); if (corrupt) await fs.writeFile(path.join(leasePath, "meta.json"), "{}");
    upsertWorkspaceDeletionIntent(f.db, { workspaceId: f.workspace.id, dirName: f.workspace.dirName, now: Date.now() });
    await firstApp.close(); firstApp = undefined; f.db.close(); workspaceDeletingFence.end(f.workspace.id);
    secondDb = await openDb(f.dataDir);
    const ctx = { ...f.ctx, db: secondDb, agentWorkerEnabled: managed };
    if (!managed) { secondApp = await createApp(ctx); await secondApp.ready(); }
    else {
      // Real modules and durable hydrate, followed by the existing managed-ready
      // barrier with an isolated runtime port; no real Worker process is spawned.
      secondApp = Fastify({ logger: false });
      await registerGitEnvModule(secondApp, ctx); await registerWorkspacesModule(secondApp, ctx); await secondApp.ready();
      assert(workspaceDeletingFence.isDeleting(f.workspace.id));
      registration = runtimeRegistration(); registerWorkspaceRuntime(registration);
      await recoverAfterAgentRuntimeReady({ runtime: registration.runtime, generation: 1,
        resumeWorkspaceDeletions: () => resumePendingWorkspaceDeletions(ctx, secondApp!.log),
        recoverRuns: async () => { assert(getWorkspace(secondDb!, f.workspace.id), "Deletion guard must run before recovery"); },
        reconcileTerminals: async () => undefined, logger: secondApp.log });
    }
    assert(getWorkspace(secondDb, f.workspace.id)); assert(getWorkspaceRepoByDirName(secondDb, f.workspace.id, f.request.repo));
    assert((await fs.stat(f.workspace.path)).isDirectory()); assert(workspaceDeletingFence.isDeleting(f.workspace.id));
    const pending = secondDb.prepare("select last_error_code as code from workspace_deletion where workspace_id=?").get(f.workspace.id) as { code: string };
    assert.equal(pending.code, corrupt ? "GIT_LEASE_STATE_UNAVAILABLE" : "REPO_GIT_BUSY");
    assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, corrupt ? "unreadable" : "unconfirmed");
    if (!corrupt) {
      await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" } });
      await deleteWorkspace(ctx, secondApp.log, f.workspace.id); assert.equal(getWorkspace(secondDb, f.workspace.id), null);
    }
  } finally {
    if (registration) unregisterWorkspaceRuntime(registration);
    await secondApp?.close(); await firstApp?.close(); secondDb?.close(); workspaceDeletingFence.end(f.workspace.id);
  }
});

for (const first of ["prepare", "delete"] as const) test(`AC-CONCURRENCY-DELETE: ${first} wins admission before physical removal`, async (t) => {
  const f = await createGitLeaseFixture(t, { repoName: "fixture-repo" }), app = Fastify({ logger: false });
  const entered = deferred(), proceed = deferred();
  const registration = runtimeRegistration();
  if (first === "delete") registration.runtime.cancelSessionAndWait = async () => { entered.resolve(); await proceed.promise; return true; };
  registerWorkspaceRuntime(registration);
  try {
    if (first === "prepare") {
      const original = fs.rename; let intercepted = false;
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (!intercepted && String(args[0]).includes(".meta-")) { intercepted = true; entered.resolve(); await proceed.promise; }
        return original(...args);
      });
      const preparing = prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); await entered.promise;
      const refused = assert.rejects(deleteWorkspace(f.ctx, app.log, f.workspace.id), assertCode("REPO_GIT_BUSY"));
      await setImmediate(); assert.equal(workspaceDeletingFence.isDeleting(f.workspace.id), false);
      proceed.resolve(); const prepared = await preparing; assert(prepared.ok); await refused;
      assert(getWorkspaceRepoByDirName(f.db, f.workspace.id, f.request.repo)); assert((await fs.stat(f.workspace.path)).isDirectory());
      await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: prepared.leaseId, stopEvidence: "not_started" } });
      await deleteWorkspace(f.ctx, app.log, f.workspace.id);
    } else {
      const deleting = deleteWorkspace(f.ctx, app.log, f.workspace.id); await entered.promise;
      const prepared = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
      assert(!prepared.ok); assert.equal(prepared.errorCode, "WORKSPACE_DELETING");
      assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
      proceed.resolve(); await deleting;
    }
    assert.equal(getWorkspace(f.db, f.workspace.id), null);
  } finally { proceed.resolve(); unregisterWorkspaceRuntime(registration); workspaceDeletingFence.end(f.workspace.id); await app.close(); }
});

test("AC-LEASE-SCAN-FAIL: detach preserves both directory and registration when v2 enumeration fails", async (t) => {
  const f = await createGitLeaseFixture(t), app = Fastify({ logger: false });
  const prepared = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(prepared.ok);
  const original = fs.readdir;
  const mock = t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const target = String(args[0]);
    if (target.startsWith("/proc/self/fd/") || target.startsWith("/dev/fd/")) throw Object.assign(new Error("fixture scan denied"), { code: "EACCES" });
    return original(...args);
  });
  await assert.rejects(detachRepoFromWorkspace(f.ctx, app.log, f.workspace.id, f.repository.repo.id), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  mock.mock.restore();
  assert(getWorkspaceRepoByDirName(f.db, f.workspace.id, f.request.repo)); assert((await fs.stat(f.repository.workspaceRepo.path)).isDirectory());
  await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: prepared.leaseId, stopEvidence: "not_started" } });
  await app.close();
});
