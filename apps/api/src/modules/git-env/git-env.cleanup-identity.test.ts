import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { prepareRepoGitEnvLease } from "./git-env.repo-service.js";
import { assertNoRepoGitEnvLeaseHold, cleanupExpiredRepoGitEnvLeases, createRepoGitEnvLease, inspectRepoGitEnvLease, releaseRepoGitEnvLease } from "./git-env.lease.js";
import { cleanupExpiredGitEnvLeases } from "./git-env.janitor.js";
import { addFixtureCredential, assertCode, createGitLeaseFixture, leaseMeta, type GitLeaseFixture } from "./git-env.testkit.js";

type Ancestor = "data" | "tmp" | "git-env" | "v2" | "lease";

/** A real directory with byte-identical, valid owner metadata; never a symlink. */
async function replaceWithMetaCopy(f: GitLeaseFixture, leaseId: string, ancestor: Ancestor, rename: typeof fs.rename) {
  const logicalLease = path.join(f.dataDir, "tmp", "git-env", "v2", leaseId);
  const source = ancestor === "data" ? f.dataDir : ancestor === "tmp" ? path.join(f.dataDir, "tmp")
    : ancestor === "git-env" ? path.join(f.dataDir, "tmp", "git-env") : ancestor === "v2" ? path.dirname(logicalLease) : logicalLease;
  const held = ancestor === "data" ? `${f.dataDir}-h2-held` : path.join(f.dataDir, "h2-held");
  const replacement = ancestor === "data" ? `${f.dataDir}-h2-replacement` : path.join(f.dataDir, "h2-replacement");
  const relative = path.relative(source, logicalLease);
  const copiedMeta = await fs.readFile(path.join(logicalLease, "meta.json"), "utf-8");
  await fs.mkdir(replacement, { mode: 0o700 });
  await fs.mkdir(path.join(replacement, relative), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(replacement, relative, "meta.json"), copiedMeta, { mode: 0o600 });
  await fs.writeFile(path.join(replacement, relative, "unrelated.txt"), "fixture unrelated replacement", { mode: 0o600 });
  // Keep the synthetic CA available if the configured data root itself moves;
  // the builder must never fall back to reading a host certificate in this test.
  if (ancestor === "data") await fs.copyFile(path.join(f.dataDir, "test-system-ca.pem"), path.join(replacement, "test-system-ca.pem"));
  const replacementIdentity = await fs.stat(path.join(replacement, relative));
  await rename(source, held); await rename(replacement, source);
  let restored = false;
  return {
    heldLease: path.join(held, relative),
    async assertReplacementIntact() {
      const directory = path.join(restored ? replacement : source, relative);
      const stat = await fs.lstat(directory);
      assert(stat.isDirectory()); assert(!stat.isSymbolicLink());
      assert.equal(stat.dev, replacementIdentity.dev); assert.equal(stat.ino, replacementIdentity.ino);
      assert.deepEqual((await fs.readdir(directory)).sort(), ["meta.json", "unrelated.txt"]);
      assert.equal(await fs.readFile(path.join(directory, "meta.json"), "utf-8"), copiedMeta, "cleanup must not even change copied meta to stopped");
      assert.equal(await fs.readFile(path.join(directory, "unrelated.txt"), "utf-8"), "fixture unrelated replacement");
    },
    async restore() {
      if (restored) return;
      await rename(source, replacement); await rename(held, source); restored = true;
    },
    async dispose() {
      if (!restored) { await rename(source, replacement); await rename(held, source); restored = true; }
      // A replaced data root uses sibling fixture paths, still strictly inside
      // .tmp-tests/0032-stage2; ordinary replacements are removed by fixture disposal.
      if (ancestor === "data") await fs.rm(replacement, { recursive: true, force: true });
    },
  };
}

for (const kind of ["https", "ssh"] as const) for (const ancestor of ["data", "tmp", "git-env", "v2", "lease"] as const) {
  for (const phase of ["initial-meta", "initial-meta-error", "auth-open", "kind-meta", "handle-close"] as const) {
    test(`H2/CREATED-IDENTITY: ${kind}, real ${ancestor} replacement with copied meta at ${phase}`, async (t) => {
      const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f, { kind });
      f.db.prepare("update repos set credential_id=? where id=?").run(credentialId, f.repository.repo.id);
      const originalRename = fs.rename, originalOpen = fs.open;
      let leaseId = "", metaWrites = 0;
      let replacement: Awaited<ReturnType<typeof replaceWithMetaCopy>> | undefined;
      const replace = async () => { assert(leaseId); replacement = await replaceWithMetaCopy(f, leaseId, ancestor, originalRename); };
      const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await originalRename(...args);
        if (String(args[1]).endsWith("/meta.json")) {
          metaWrites++;
          if (metaWrites === 1) leaseId = path.basename(await fs.realpath(path.dirname(String(args[1]))));
          if (((phase === "initial-meta" || phase === "initial-meta-error") && metaWrites === 1) || (phase === "kind-meta" && metaWrites === 2)) {
            await replace();
            if (phase === "initial-meta-error") throw new Error("fixture initial publication response failure");
          }
        }
      });
      const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const name = path.basename(String(args[0]));
        if (phase === "auth-open" && !replacement && ["git-askpass-token", "ssh-key"].includes(name)) await replace();
        const file = await originalOpen(...args);
        if (phase === "handle-close" && typeof args[1] === "number" && (args[1] & fsConstants.O_DIRECTORY) !== 0 && name.startsWith("lease_")) {
          const originalClose = file.close.bind(file);
          t.mock.method(file, "close", async () => { if (!replacement) await replace(); await originalClose(); });
        }
        return file;
      });
      try {
        const response = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
        assert(!response.ok); assert.equal(response.errorCode, "GIT_ENV_PREPARE_FAILED"); assert(!Object.hasOwn(response, "env"));
        renameMock.mock.restore(); openMock.mock.restore();
        assert(replacement); await replacement.assertReplacementIntact();
        const originalMeta = JSON.parse(await fs.readFile(path.join(replacement.heldLease, "meta.json"), "utf-8"));
        assert.equal(originalMeta.stopState, "unconfirmed"); assert.equal(originalMeta.leaseId, leaseId);
        if (phase !== "handle-close") assert.deepEqual(await fs.readdir(replacement.heldLease), ["meta.json"]);
        // The copied metadata is independently valid but grants no prepare rollback
        // authority over this different inode, even though all owner fields match.
        const standIn = await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId }); assert(standIn?.meta); assert.equal(standIn.state, "unconfirmed");
        await replacement.restore();
        assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId }))?.state, "unconfirmed");
        const future = Date.parse(originalMeta.expiresAt) + 70 * 60_000;
        await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: future });
        await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id, nowMs: future }), assertCode("REPO_GIT_BUSY"));
        await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId, stopEvidence: "not_started" } });
        await replacement.assertReplacementIntact();
      } finally { renameMock.mock.restore(); openMock.mock.restore(); await replacement?.dispose(); }
    });
  }
}

for (const kind of ["https", "ssh"] as const) test(`H2/RELEASE-RACE: ${kind} prepare rollback waits for the lease lock and rechecks its original identity`, async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f, { kind });
  f.db.prepare("update repos set credential_id=? where id=?").run(credentialId, f.repository.repo.id);
  const originalRename = fs.rename, originalOpen = fs.open;
  let leaseId = "", unblock!: () => void, failed!: () => void;
  const proceed = new Promise<void>((resolve) => { unblock = resolve; });
  const authFailed = new Promise<void>((resolve) => { failed = resolve; });
  let blocker: Promise<void> | undefined, replacement: Awaited<ReturnType<typeof replaceWithMetaCopy>> | undefined;
  const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (!leaseId && String(args[1]).endsWith("/meta.json")) {
      leaseId = path.basename(await fs.realpath(path.dirname(String(args[1]))));
      let entered!: () => void; const locked = new Promise<void>((resolve) => { entered = resolve; });
      blocker = withRepoLock(`git-env:v2:${leaseId}`, async () => { entered(); await proceed; }); await locked;
    }
  });
  const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (["git-askpass-token", "ssh-key"].includes(path.basename(String(args[0])))) { failed(); throw new Error("fixture authentication construction failure"); }
    return originalOpen(...args);
  });
  const preparing = prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
  try {
    await authFailed; await setImmediate();
    replacement = await replaceWithMetaCopy(f, leaseId, "v2", originalRename);
    unblock(); await blocker;
    const response = await preparing; assert(!response.ok); assert.equal(response.errorCode, "GIT_ENV_PREPARE_FAILED");
    await replacement.assertReplacementIntact();
    assert.equal(JSON.parse(await fs.readFile(path.join(replacement.heldLease, "meta.json"), "utf-8")).stopState, "unconfirmed");
    renameMock.mock.restore(); openMock.mock.restore();
    await replacement.restore();
    await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("REPO_GIT_BUSY"));
    await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId, stopEvidence: "not_started" } });
    await replacement.assertReplacementIntact();
  } finally { unblock(); await blocker; await preparing; renameMock.mock.restore(); openMock.mock.restore(); await replacement?.dispose(); }
});

for (const actor of ["release", "janitor"] as const) test(`H2/EXISTING-DELETE-GUARD: ${actor} stops after its pinned identity check fails, without ID fallback`, async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f, { createdAt: new Date(Date.now() - 70 * 60_000).toISOString() });
  const directory = await createRepoGitEnvLease({ dataDir: f.dataDir, meta });
  await fs.writeFile(path.join(directory, "authentication.fixture"), "fixture auth artifact", { mode: 0o600 });
  if (actor === "janitor") await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ ...meta, stopState: "stopped" }));
  const originalRename = fs.rename, originalOpen = fs.open;
  let replacement: Awaited<ReturnType<typeof replaceWithMetaCopy>> | undefined;
  let failures = 0;
  const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (actor === "release" && !replacement && String(args[1]).endsWith("/meta.json")) replacement = await replaceWithMetaCopy(f, meta.leaseId, "v2", originalRename);
  });
  const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (actor === "janitor" && String(args[0]).endsWith("/meta.json")) {
      const originalRead = file.read.bind(file);
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof originalRead>) => {
        const result = await originalRead(...readArgs);
        if (!replacement) replacement = await replaceWithMetaCopy(f, meta.leaseId, "v2", originalRename);
        return result;
      });
    }
    return file;
  });
  try {
    if (actor === "release") await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" } }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
    else { await cleanupExpiredRepoGitEnvLeases({ dataDir: f.dataDir, onFailure: () => { failures++; } }); assert.equal(failures, 1); }
    assert(replacement); await replacement.assertReplacementIntact();
    assert.equal(await fs.readFile(path.join(replacement.heldLease, "authentication.fixture"), "utf-8"), "fixture auth artifact");
    assert.equal(JSON.parse(await fs.readFile(path.join(replacement.heldLease, "meta.json"), "utf-8")).stopState, "stopped");
  } finally { renameMock.mock.restore(); openMock.mock.restore(); await replacement?.dispose(); }
});

for (const kind of ["https", "ssh"] as const) test(`H2/OPEN-RACE: ${kind} replacement after the locked snapshot check is rejected by reopened inode comparison`, async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f, { kind });
  f.db.prepare("update repos set credential_id=? where id=?").run(credentialId, f.repository.repo.id);
  const originalOpen = fs.open, originalRename = fs.rename;
  let dataOpens = 0, leaseId = "";
  let replacement: Awaited<ReturnType<typeof replaceWithMetaCopy>> | undefined;
  const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (!leaseId && String(args[1]).endsWith("/meta.json")) leaseId = path.basename(await fs.realpath(path.dirname(String(args[1]))));
  });
  const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (["git-askpass-token", "ssh-key"].includes(path.basename(String(args[0])))) throw new Error("fixture builder failure");
    if (String(args[0]) === f.dataDir && typeof args[1] === "number" && (args[1] & fsConstants.O_DIRECTORY) !== 0) {
      // First: repository admission. Second: creation. Third: rollback's reopen,
      // after its locked expected-identity check has already passed.
      dataOpens++;
      if (dataOpens === 3) replacement = await replaceWithMetaCopy(f, leaseId, "v2", originalRename);
    }
    return originalOpen(...args);
  });
  try {
    const response = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
    assert(!response.ok); assert.equal(response.errorCode, "GIT_ENV_PREPARE_FAILED");
    assert.equal(dataOpens, 3); assert(replacement); await replacement.assertReplacementIntact();
    assert.equal(JSON.parse(await fs.readFile(path.join(replacement.heldLease, "meta.json"), "utf-8")).stopState, "unconfirmed");
    renameMock.mock.restore(); openMock.mock.restore();
    await replacement.restore();
    await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("REPO_GIT_BUSY"));
    await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId, stopEvidence: "not_started" } });
    await replacement.assertReplacementIntact();
  } finally { renameMock.mock.restore(); openMock.mock.restore(); await replacement?.dispose(); }
});

for (const kind of ["https", "ssh"] as const) test(`H2/NORMAL-ROLLBACK: ${kind} partial builder failure still immediately removes the original lease`, async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f, { kind });
  f.db.prepare("update repos set credential_id=? where id=?").run(credentialId, f.repository.repo.id);
  const originalOpen = fs.open; let injected = false;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const name = path.basename(String(args[0]));
    if (kind === "https" && name === "git-askpass.sh") { injected = true; throw new Error("fixture script creation failure"); }
    const file = await originalOpen(...args);
    if (kind === "ssh" && name === "ssh-key") {
      const originalWrite = file.writeFile.bind(file);
      t.mock.method(file, "writeFile", async (...writeArgs: Parameters<typeof originalWrite>) => {
        await originalWrite(...writeArgs); injected = true; throw new Error("fixture key publication failure");
      });
    }
    return file;
  });
  try {
    const response = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
    assert(injected); assert(!response.ok); assert.equal(response.errorCode, "GIT_ENV_PREPARE_FAILED"); assert(!Object.hasOwn(response, "env"));
  } finally { mock.mock.restore(); }
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "tmp", "git-env", "v2")), []);
  await assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id });
});
