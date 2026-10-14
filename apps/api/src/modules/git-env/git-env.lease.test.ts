import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { createRepoGitEnvLease, inspectRepoGitEnvLease, releaseRepoGitEnvLease, assertNoRepoGitEnvLeaseHold, repoGitEnvLeaseRoot, cleanupExpiredRepoGitEnvLeases, listRepoGitEnvLeaseIds } from "./git-env.lease.js";
import { cleanupExpiredGitEnvLeases, startGitEnvJanitor, gitEnvLeaseRoot } from "./git-env.janitor.js";
import { createGitLeaseFixture, leaseMeta, assertCode } from "./git-env.testkit.js";
import { newSortableId } from "../../utils/ids.js";

for (const timeoutMs of [1000, 120_000, 3_600_000]) test(`AC-LEASE-TTL/PERMISSIONS/DEFAULT-HOLD: ${timeoutMs}ms none lease is protected beyond TTL`, async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f, { timeoutMs });
  const dir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta });
  assert(dir);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, "meta.json"))).mode & 0o777, 0o600);
  const inspected = await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId });
  assert.deepEqual(inspected?.meta, meta);
  assert.equal(Date.parse(meta.expiresAt) - Date.parse(meta.createdAt), timeoutMs === 3_600_000 ? 65 * 60_000 : 15 * 60_000);
  const future = Date.parse(meta.expiresAt) + 10 * 60_000;
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: future });
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id, nowMs: future }), assertCode("REPO_GIT_BUSY"));
  await fs.access(dir);
  const raw = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
  for (const forbidden of ["args", "env", "secret", "pid", "pgid", "holdReason", "workerInstance"]) assert(!Object.hasOwn(JSON.parse(raw), forbidden));
});

test("AC-LEASE-OWNER/AFTER-RUN/IDEMPOTENT: owner only, independent of live Run and repository", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f);
  await createRepoGitEnvLease({ dataDir: f.dataDir, meta });
  const request = { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" as const };
  await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...request, sessionId: "foreign" } }), assertCode("LEASE_OWNER_MISMATCH"));
  f.db.prepare("update agent_run set status='completed', execution_phase='terminal', terminal_result_code='run_completed' where run_id=?").run(f.owner.runId);
  f.db.prepare("delete from workspace_repos where workspace_id=?").run(f.workspace.id);
  assert.deepEqual(await releaseRepoGitEnvLease({ dataDir: f.dataDir, request }), { ok: true });
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }), null);
  assert.deepEqual(await releaseRepoGitEnvLease({ dataDir: f.dataDir, request }), { ok: true });
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

for (const invalidId of ["", ".", "..", "v2", "../v2", "a/b", "a\\b", "/root"]) test(`AC-LEASE-ROOT: reject invalid id ${JSON.stringify(invalidId)}`, async (t) => {
  const f = await createGitLeaseFixture(t);
  await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: invalidId, stopEvidence: "not_started" } }), assertCode("LEASE_RELEASE_INVALID"));
});

for (const badMeta of [null, "{bad-json", { stopState: "stop_failed" }, { extra: true }]) test("AC-LEASE-BAD-META/UNKNOWN-WORKSPACE/STATE-SCHEMA: unknown v2 protects every Workspace and never expires", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f);
  const dir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta }); assert(dir);
  const file = path.join(dir, "meta.json");
  if (badMeta === null) await fs.unlink(file);
  else await fs.writeFile(file, typeof badMeta === "string" ? badMeta : JSON.stringify({ ...meta, ...badMeta }));
  const future = Date.parse(meta.expiresAt) + 24 * 60 * 60_000;
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: future });
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "unreadable");
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: "unrelated", nowMs: future }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "not_started" } }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await fs.access(dir);
});

test("AC-LEASE-V2-CONTAINER/LEGACY-LEASE: v1 old expiry and 30-minute fallback do not sweep v2 or shared SSH/CA", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f);
  const heldDir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta }); assert(heldDir);
  const now = Date.parse(meta.expiresAt) + 10 * 60_000;
  const oldRoot = gitEnvLeaseRoot(f.dataDir), expired = path.join(oldRoot, newSortableId("lease")), corrupt = path.join(oldRoot, newSortableId("lease")), fresh = path.join(oldRoot, newSortableId("lease"));
  await Promise.all([expired, corrupt, fresh].map((dir) => fs.mkdir(dir, { mode: 0o700 })));
  await fs.writeFile(path.join(expired, "meta.json"), JSON.stringify({ schemaVersion: 1, expiresAt: new Date(now - 1).toISOString() }));
  await fs.utimes(corrupt, new Date(now - 31 * 60_000), new Date(now - 31 * 60_000));
  await fs.utimes(fresh, new Date(now - 29 * 60_000), new Date(now - 29 * 60_000));
  await fs.utimes(repoGitEnvLeaseRoot(f.dataDir), new Date(0), new Date(0));
  await Promise.all(["ssh", "certs"].map((name) => fs.mkdir(path.join(f.dataDir, name), { recursive: true })));
  await fs.writeFile(path.join(f.dataDir, "ssh", "known_hosts"), "fixture");
  await fs.writeFile(path.join(f.dataDir, "certs", "ca.pem"), "fixture");
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: now });
  for (const dir of [expired, corrupt]) await assert.rejects(fs.access(dir));
  for (const dir of [fresh, heldDir, path.join(f.dataDir, "ssh", "known_hosts"), path.join(f.dataDir, "certs", "ca.pem")]) await fs.access(dir);
});

test("AC-LEASE-STOP-WRITE-FAIL: atomic stopped write failure never removes protection or credentials", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f), dir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta }); assert(dir);
  const marker = path.join(dir, "ssh-key"); await fs.writeFile(marker, "fixture");
  const original = fs.rename;
  const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith("/meta.json")) throw new Error("fixture-private-path-must-not-escape");
    return original(...args);
  });
  try {
    await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" } }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  } finally { mock.mock.restore(); }
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "unconfirmed");
  await fs.access(marker);
});

test("AC-LEASE-CLEANUP-FAIL/STOP-MONOTONIC: rmdir failure retains stopped, expiry janitor re-reads and recovers", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f), dir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta }); assert(dir);
  const original = fs.rmdir;
  const mock = t.mock.method(fs, "rmdir", async (...args: Parameters<typeof fs.rmdir>) => {
    if (String(args[0]).endsWith(meta.leaseId)) throw new Error("fixture delete failure");
    return original(...args);
  });
  try {
    await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" } }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  } finally { mock.mock.restore(); }
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "stopped");
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.parse(meta.expiresAt) - 1 });
  await fs.access(dir);
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.parse(meta.expiresAt) + 1 });
  await assert.rejects(fs.access(dir));
});

test("AC-LEASE-SERIAL-RELEASE/JANITOR-RACE: concurrent release and janitor share a short per-lease gate and never revive", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f), dir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta }); assert(dir);
  const request = { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" as const };
  let letWriteProceed!: () => void, observedWrite!: () => void;
  const observed = new Promise<void>((resolve) => { observedWrite = resolve; });
  const barrier = new Promise<void>((resolve) => { letWriteProceed = resolve; });
  const original = fs.rename; let writes = 0;
  const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith("/meta.json")) { writes++; observedWrite(); await barrier; }
    return original(...args);
  });
  try {
    const first = releaseRepoGitEnvLease({ dataDir: f.dataDir, request });
    await observed;
    const second = releaseRepoGitEnvLease({ dataDir: f.dataDir, request });
    const janitor = cleanupExpiredRepoGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.parse(meta.expiresAt) + 1 });
    letWriteProceed();
    await Promise.all([first, second, janitor]);
    assert.equal(writes, 1);
    await assert.rejects(fs.access(dir));
    await releaseRepoGitEnvLease({ dataDir: f.dataDir, request });
    await assert.rejects(fs.access(dir));
  } finally { letWriteProceed(); mock.mock.restore(); }
});

test("AC-LEASE-JANITOR-RACE: janitor queued first re-reads after another stopped release, other leases stay independent", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f);
  await createRepoGitEnvLease({ dataDir: f.dataDir, meta });
  let unlock!: () => void, locked!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const barrier = new Promise<void>((resolve) => { unlock = resolve; });
  const holding = withRepoLock(`git-env:v2:${meta.leaseId}`, async () => { locked(); await barrier; });
  await entered;
  const janitor = cleanupExpiredRepoGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.parse(meta.expiresAt) + 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const release = releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "managed_group_absent" } });
  const other = leaseMeta(f); await createRepoGitEnvLease({ dataDir: f.dataDir, meta: other });
  await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: other.leaseId, stopEvidence: "not_started" } });
  unlock(); await Promise.all([holding, janitor, release]);
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }), null);
});

for (const target of ["v2", "lease", "meta"]) test(`AC-LEASE-ROOT/SCAN-FAIL: ${target} symlink is never followed`, async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f), dir = await createRepoGitEnvLease({ dataDir: f.dataDir, meta }); assert(dir);
  const outside = path.join(f.dataDir, "outside-fixture"); await fs.mkdir(outside); const marker = path.join(outside, "marker"); await fs.writeFile(marker, "fixture");
  const slot = target === "v2" ? repoGitEnvLeaseRoot(f.dataDir) : target === "lease" ? dir : path.join(dir, "meta.json");
  await fs.rename(slot, `${slot}-saved`);
  await fs.symlink(target === "meta" ? marker : outside, slot);
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await assert.rejects(releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: meta.leaseId, stopEvidence: "not_started" } }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.now() + 99 * 60_000 });
  await fs.access(marker); assert((await fs.lstat(slot)).isSymbolicLink());
});

test("AC-LEASE-SCAN-FAIL/PERMISSIONS: unreadable scan and writable/private roots fail closed", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f); await createRepoGitEnvLease({ dataDir: f.dataDir, meta });
  const root = repoGitEnvLeaseRoot(f.dataDir);
  await fs.chmod(root, 0o777);
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await fs.chmod(root, 0o700);
  const original = fs.readdir;
  const mock = t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => { if (String(args[0]).startsWith("/proc/self/fd/")) throw new Error("fixture read failure"); return original(...args); });
  try { await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("GIT_LEASE_STATE_UNAVAILABLE")); }
  finally { mock.mock.restore(); }
});

test("AC-LEASE-TTL: janitor onReady sweep and five-minute default timer are registered", async (t) => {
  const f = await createGitLeaseFixture(t), hooks = new Map<string, () => void | Promise<void>>();
  let interval: number | undefined;
  const original = globalThis.setInterval;
  const mock = t.mock.method(globalThis, "setInterval", ((handler: (...args: unknown[]) => void, timeout?: number) => { interval = timeout; return original(handler, 1_000_000); }) as typeof setInterval);
  try {
    startGitEnvJanitor({ app: { addHook: (name, cb) => { hooks.set(name, cb); } }, dataDir: f.dataDir });
    await hooks.get("onReady")!(); assert.equal(interval, 5 * 60_000);
    await hooks.get("onClose")!();
  } finally { await hooks.get("onClose")?.(); mock.mock.restore(); }
});
