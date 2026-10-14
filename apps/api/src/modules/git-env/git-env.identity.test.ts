import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareRepoGitEnvLease } from "./git-env.repo-service.js";
import { assertNoRepoGitEnvLeaseHold, inspectRepoGitEnvLease, listRepoGitEnvLeaseIds, releaseRepoGitEnvLease } from "./git-env.lease.js";
import { cleanupExpiredGitEnvLeases } from "./git-env.janitor.js";
import { addFixtureCredential, assertCode, createGitLeaseFixture } from "./git-env.testkit.js";

// All targets, stand-ins and synthetic credentials are inside this test fixture.
// The replacement remains private and contains the same lease ID, reproducing H1.
for (const kind of ["https", "ssh"] as const) {
  for (const ancestor of ["tmp", "git-env", "v2"] as const) {
    for (const phase of ["initial-meta", "auth-open", "kind-meta", "handle-close"] as const) {
      test(`H1/AC-LEASE-ROOT: ${kind}, replace ${ancestor} at ${phase}; no redirected write or delivery`, async (t) => {
        const f = await createGitLeaseFixture(t);
        const credentialId = addFixtureCredential(f, { kind });
        f.db.prepare("update repos set credential_id=? where id=?").run(credentialId, f.repository.repo.id);
        const v2 = path.join(f.dataDir, "tmp", "git-env", "v2");
        const ancestorPath = ancestor === "tmp" ? path.join(f.dataDir, "tmp") : ancestor === "git-env" ? path.dirname(v2) : v2;
        const heldAncestor = path.join(f.dataDir, "original-ancestor");
        const replacement = path.join(f.dataDir, "replacement-ancestor");
        const originalRename = fs.rename, originalOpen = fs.open;
        let leaseId = "", relativeLeasePath = "", originalIdentity: Stats | undefined;
        let metaWrites = 0, authWrites = 0, swapped = false;
        const directoryHandles: fs.FileHandle[] = [];

        const replaceAncestor = async () => {
          assert(leaseId); assert(originalIdentity);
          relativeLeasePath = path.relative(ancestorPath, path.join(v2, leaseId));
          const standIn = path.join(replacement, relativeLeasePath);
          await fs.mkdir(standIn, { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(standIn, "unrelated.txt"), "fixture replacement marker", { mode: 0o600 });
          await originalRename(ancestorPath, heldAncestor);
          await fs.symlink(replacement, ancestorPath);
          swapped = true;
        };
        const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
          await originalRename(...args);
          if (String(args[1]).endsWith("/meta.json")) {
            metaWrites++;
            if (metaWrites === 1) {
              const physicalLease = await fs.realpath(path.dirname(String(args[1])));
              leaseId = path.basename(physicalLease); originalIdentity = await fs.stat(physicalLease);
            }
            if ((phase === "initial-meta" && metaWrites === 1) || (phase === "kind-meta" && metaWrites === 2)) await replaceAncestor();
          }
        });
        const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          const name = path.basename(String(args[0]));
          const authFile = ["git-askpass-token", "git-askpass.sh", "ssh-key"].includes(name);
          if (authFile) {
            if (phase === "auth-open" && !swapped) await replaceAncestor();
            const identity = await fs.stat(path.dirname(String(args[0])));
            assert(originalIdentity); assert.equal(identity.dev, originalIdentity.dev); assert.equal(identity.ino, originalIdentity.ino);
            authWrites++;
          }
          const file = await originalOpen(...args);
          if (typeof args[1] === "number" && (args[1] & fsConstants.O_DIRECTORY) !== 0) {
            directoryHandles.push(file);
            if (phase === "handle-close" && name.startsWith("lease_")) {
              const originalClose = file.close.bind(file);
              t.mock.method(file, "close", async () => { if (!swapped) await replaceAncestor(); await originalClose(); });
            }
          }
          return file;
        });
        try {
          const response = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
          assert(!response.ok); assert.equal(response.errorCode, "GIT_ENV_PREPARE_FAILED");
          assert(!Object.hasOwn(response, "env")); assert(!Object.hasOwn(response, "sensitiveFilePaths"));
          assert(!JSON.stringify(response).includes("fixture-secret-marker")); assert(!JSON.stringify(response).includes(f.dataDir));
        } finally { renameMock.mock.restore(); openMock.mock.restore(); }
        assert(swapped); assert(directoryHandles.length > 0); assert(directoryHandles.every((handle) => handle.fd === -1), "all preparation directory handles must be closed");
        assert.equal(authWrites, phase === "initial-meta" ? 0 : kind === "https" ? 2 : 1);
        const heldLease = path.join(heldAncestor, relativeLeasePath), standIn = path.join(replacement, relativeLeasePath);
        const expectedHeldFiles = phase === "handle-close"
          ? kind === "https" ? ["git-askpass-token", "git-askpass.sh", "meta.json"] : ["meta.json", "ssh-key"]
          : ["meta.json"];
        assert.deepEqual((await fs.readdir(heldLease)).sort(), expectedHeldFiles, "before teardown credentials are recovered through the pinned handle; after teardown the original lease stays held");
        const meta = JSON.parse(await fs.readFile(path.join(heldLease, "meta.json"), "utf-8"));
        assert.equal(meta.stopState, "unconfirmed"); assert.equal(meta.leaseId, leaseId);
        assert.deepEqual(await fs.readdir(standIn), ["unrelated.txt"], "no token, askpass, key or metadata reached the replacement");
        await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
        const request = { ...f.owner, leaseId, stopEvidence: "not_started" as const };
        await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
        assert.equal(await fs.readFile(path.join(standIn, "unrelated.txt"), "utf-8"), "fixture replacement marker");

        // Restoring the trusted namespace exposes the same held lease, never a
        // stopped/re-created lease. Neither elapsed TTL nor janitor releases it.
        await fs.unlink(ancestorPath); await originalRename(heldAncestor, ancestorPath);
        assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId }))?.state, "unconfirmed");
        const future = Date.parse(meta.expiresAt) + 70 * 60_000;
        await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: future });
        await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id, nowMs: future }), assertCode("REPO_GIT_BUSY"));
        await releaseRepoGitEnvLease({ dataDir: f.dataDir, request });
        assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId }), null);
        assert.deepEqual(await fs.readdir(standIn), ["unrelated.txt"], "later legitimate release does not touch replacement data");
      });
    }
  }
}

test("H1/RESOURCE-LIFETIME: terminal transition during directory teardown is rechecked before environment delivery", async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f);
  const originalOpen = fs.open; let cancelled = false;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (typeof args[1] === "number" && (args[1] & fsConstants.O_DIRECTORY) !== 0 && path.basename(String(args[0])).startsWith("lease_")) {
      const originalClose = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        if (!cancelled) {
          cancelled = true;
          f.db.prepare("update agent_run set status='cancelled', execution_phase='terminal', terminal_result_code='run_cancelled' where run_id=?").run(f.owner.runId);
          f.db.prepare("update session_run_state set status='idle', active_run_id=null where session_id=?").run(f.owner.sessionId);
        }
        await originalClose();
      });
    }
    return file;
  });
  try {
    const response = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
    assert(cancelled); assert(!response.ok); assert.equal(response.errorCode, "RUN_NOT_EXECUTABLE"); assert(!Object.hasOwn(response, "env"));
  } finally { mock.mock.restore(); }
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});
