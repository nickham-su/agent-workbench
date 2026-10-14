import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { newSortableId } from "../../utils/ids.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { assertCode } from "./git-env.testkit.js";
import { createRepoGitEnvLease, inspectRepoGitEnvLease, releaseRepoGitEnvLeaseForMaintenance, cleanupExpiredRepoGitEnvLeases, assertNoRepoGitEnvLeaseHold, type RepoGitEnvLeaseMeta } from "./git-env.lease.js";
import { assertRepoGitEnvMaintenanceRequest, assertKnownMaintenanceProcessesAbsent, type RepoGitEnvMaintenanceRequest } from "./git-env.recovery-policy.js";

const root = fileURLToPath(new URL("../../../../../.tmp-tests/0032-stage5/recovery", import.meta.url));
const absent = () => { throw Object.assign(new Error("fixture-not-present"), { code: "ESRCH" }); };
const owner = { workspaceId: "fixture-workspace", sessionId: "finished-session", runId: "completed-run", toolExecutionId: "completed-tool" };
async function fixture(t: TestContext) {
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, "lease-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.now(), leaseId = newSortableId("lease");
  const meta: RepoGitEnvLeaseMeta = { ...owner, schemaVersion: 2, purpose: "git", leaseId, repo: "fixture-repo", repoId: "fixture-repo-id", kind: "none", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(), timeoutMs: 120_000, stopState: "unconfirmed" };
  const directory = await createRepoGitEnvLease({ dataDir, meta });
  const request: RepoGitEnvMaintenanceRequest = { leaseId, expectedOwner: owner, expectedState: "unconfirmed", window: "known_scope", evidenceRef: "fixture-window-1", servicesStopped: true, startupDisabled: true, exclusiveWindow: true, coverageVerified: true, knownPids: [2_147_483_647], knownPgids: [], confirmedLeaseId: leaseId };
  return { dataDir, meta, directory, request };
}

test("AC-RECOVERY-DIRECT/FINISHED/VERIFY/REPEAT: local release needs no DB or live run and removes only one lease", async (t) => {
  const f = await fixture(t), other = { ...f.meta, leaseId: newSortableId("lease") };
  await createRepoGitEnvLease({ dataDir: f.dataDir, meta: other });
  assert.deepEqual(await releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent }), { ok: true });
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }), null);
  assert(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: other.leaseId }));
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: owner.workspaceId }), assertCode("REPO_GIT_BUSY"));
  assert.deepEqual(await releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent }), { ok: true });
  await assert.rejects(fs.access(path.join(f.dataDir, "db.sqlite")), { code: "ENOENT" });
  assert(!await fs.readdir(f.dataDir).then((names) => names.includes("workspaces")));
});

for (const field of ["servicesStopped", "startupDisabled", "exclusiveWindow", "coverageVerified", "window", "evidenceRef", "confirmedLeaseId"] as const) {
  test(`AC-RECOVERY-STOP-EVIDENCE/MISSING-EVIDENCE: missing ${field} refuses before deletion`, async (t) => {
    const f = await fixture(t), request = { ...f.request } as Record<string, unknown>;
    delete request[field];
    await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request, probe: absent }), assertCode("GIT_LEASE_MAINTENANCE_INVALID"));
    assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }))?.state, "unconfirmed");
  });
}
for (const change of [
  { expectedOwner: { ...owner, runId: "foreign" } }, { expectedState: "stopped" },
  { leaseId: "*" }, { leaseId: "../v2" }, { leaseId: ["a", "b"] }, { confirmedLeaseId: "lease_invalid" },
  { expectedOwner: null }, { expectedState: "unreadable" }, { pgid: 22 },
]) test("AC-RECOVERY-EXPECTED: owner/state/selector/extra fields never bypass exact expectations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: { ...f.request, ...change }, probe: absent }));
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }))?.state, "unconfirmed");
});

for (const window of ["managed_environment_stopped", "reboot_before_services"] as const) {
  test(`AC-RECOVERY-UNREADABLE: ${window} only accepts exact unreadable/null and does not invent meta`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, "meta.json"), "fixture-corrupt-metadata");
    const request = { ...f.request, window, expectedState: "unreadable" as const, expectedOwner: null, knownPids: [] };
    await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: { ...request, window: "known_scope" }, probe: absent }), assertCode("GIT_LEASE_MAINTENANCE_EVIDENCE_REQUIRED"));
    const writes: string[] = [], original = fs.rename;
    const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { writes.push(String(args[1])); return original(...args); });
    assert.deepEqual(await releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request, probe: absent }), { ok: true });
    mock.mock.restore();
    assert.equal(writes.length, 0, "must not synthesize owner or stopped metadata for unreadable lease");
    await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
  });
}

test("AC-RECOVERY-MECHANICAL-LIMIT: complete numeric absence is not enough without operator coverage", async (t) => {
  const f = await fixture(t);
  for (const request of [{ ...f.request, coverageVerified: false }, { ...f.request, knownPids: [] }, { ...f.request, window: "worker_exited" }]) {
    await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request, probe: absent }));
  }
  assert(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }));
});

for (const code of [undefined, "EPERM", "EIO", "ENOSYS"]) test(`AC-RECOVERY-QUIESCENCE: known PID/group ${code ?? "present"} is refused, no signals other than zero`, async (t) => {
  const f = await fixture(t), calls: Array<[number, number]> = [];
  const probe = (pid: number, signal: 0) => { calls.push([pid, signal]); if (code) throw Object.assign(new Error("private-path-not-for-log"), { code }); return true; };
  const request = { ...f.request, knownPids: [], knownPgids: [99] };
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request, probe }), assertCode(code ? "GIT_LEASE_MAINTENANCE_PROCESS_UNKNOWN" : "GIT_LEASE_MAINTENANCE_PROCESS_PRESENT"));
  assert.deepEqual(calls, [[-99, 0]]);
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }))?.state, "unconfirmed");
});

for (const value of [0, 1, -3, 2_147_483_648, 1.2, "20", ...[Array.from({ length: 65 }, (_, i) => i + 2)]]) {
  test("AC-RECOVERY-QUIESCENCE: numeric scopes are integer, positive, bounded and limited", async (t) => {
    const f = await fixture(t);
    assert.throws(() => assertRepoGitEnvMaintenanceRequest({ ...f.request, knownPids: Array.isArray(value) ? value : [value] }));
  });
}

test("AC-RECOVERY-QUIESCENCE: real current PID rejects and impossible numeric PID is only an observation", async (t) => {
  const f = await fixture(t);
  assert.throws(() => assertKnownMaintenanceProcessesAbsent({ ...f.request, knownPids: [process.pid] }), assertCode("GIT_LEASE_MAINTENANCE_PROCESS_PRESENT"));
  assertKnownMaintenanceProcessesAbsent(f.request);
});

for (const failure of ["write", "delete", "unreadable-delete"] as const) test(`AC-RECOVERY-RELEASE-FAIL: ${failure} preserves the correct hold/monotonic state`, async (t) => {
  const f = await fixture(t);
  if (failure === "unreadable-delete") await fs.writeFile(path.join(f.directory, "meta.json"), "broken");
  const operation = failure === "write" ? "rename" : "unlink";
  const original = fs[operation];
  const mock = t.mock.method(fs, operation, async (...args: unknown[]) => {
    if ((failure === "write" && String(args[1]).endsWith("/meta.json")) || (failure !== "write" && String(args[0]).endsWith("/meta.json"))) throw Object.assign(new Error("fixture-I/O"), { code: "EIO" });
    return (original as (...args: unknown[]) => Promise<unknown>)(...args);
  });
  const request = failure === "unreadable-delete" ? { ...f.request, window: "reboot_before_services", expectedOwner: null, expectedState: "unreadable" } : f.request;
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request, probe: absent }));
  mock.mock.restore();
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }))?.state, failure === "write" ? "unconfirmed" : failure === "delete" ? "stopped" : "unreadable");
  await cleanupExpiredRepoGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.parse(f.meta.expiresAt) + 1 });
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }) === null, failure === "delete");
});

for (const component of ["data", "tmp", "git-env", "v2", "lease"]) test(`AC-RECOVERY-PERMISSION: refuses symbolic ${component} without reading or removing replacement`, async (t) => {
  const f = await fixture(t);
  const selected = component === "data" ? f.dataDir : component === "lease" ? f.directory : path.join(f.dataDir, ...["tmp", "git-env", "v2"].slice(0, ["tmp", "git-env", "v2"].indexOf(component) + 1));
  const moved = `${selected}-moved`;
  await fs.rename(selected, moved);
  t.after(async () => { await fs.unlink(selected).catch(() => undefined); await fs.rename(moved, selected).catch(() => undefined); });
  await fs.symlink(moved, selected);
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  assert.equal((await fs.lstat(selected)).isSymbolicLink(), true);
  await fs.access(path.join(component === "lease" ? moved : path.join(moved, path.relative(selected, f.directory)), "meta.json"));
});

test("AC-RECOVERY-PERMISSION: wrong root/lease permissions and foreign owner fail closed", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.dataDir, 0o777);
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await fs.chmod(f.dataDir, 0o700); await fs.chmod(f.directory, 0o755);
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  await fs.chmod(f.directory, 0o700);
  const original = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args), stat = file.stat.bind(file);
    if (String(args[0]) === f.dataDir) file.stat = (async () => {
      const value = await stat();
      value.uid = (process.getuid?.() ?? 0) + 1;
      return value;
    }) as typeof file.stat;
    return file;
  });
  await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
  mock.mock.restore();
});

test("AC-RECOVERY-DIRECT: waits for existing per-lease lock and re-reads expectations inside it", async (t) => {
  const f = await fixture(t);
  let unlock!: () => void, entered!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  const first = withRepoLock(`git-env:v2:${f.meta.leaseId}`, async () => { entered(); await new Promise<void>((resolve) => { unlock = resolve; }); });
  await locked;
  const release = releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request: f.request, probe: absent });
  await fs.writeFile(path.join(f.directory, "meta.json"), JSON.stringify({ ...f.meta, stopState: "stopped" }));
  unlock(); await first;
  await assert.rejects(release, assertCode("GIT_LEASE_MAINTENANCE_EXPECTATION_MISMATCH"));
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }))?.state, "stopped");
});

for (const ancestor of ["tmp", "git-env", "v2", "lease"] as const) {
  for (const phase of ["stopped-write", "delete-unlink", "unreadable-unlink"] as const) {
    test(`AC-RECOVERY-ROOT/PERMISSION: replace ${ancestor} at ${phase}; same owner/ID stand-in is never deleted`, async (t) => {
      const f = await fixture(t), originalRename = fs.rename, originalUnlink = fs.unlink;
      const logical = ancestor === "tmp" ? path.join(f.dataDir, "tmp") : ancestor === "git-env" ? path.join(f.dataDir, "tmp/git-env") : ancestor === "v2" ? path.dirname(f.directory) : f.directory;
      const held = path.join(f.dataDir, "original-pinned-tree");
      const relative = path.relative(logical, f.directory), standIn = path.join(logical, relative);
      let swapped = false;
      if (phase === "unreadable-unlink") await fs.writeFile(path.join(f.directory, "meta.json"), "fixture-unreadable");
      const swap = async () => {
        await originalRename(logical, held);
        await fs.mkdir(standIn, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(standIn, "meta.json"), JSON.stringify({ ...f.meta, stopState: "stopped" }), { mode: 0o600 });
        await fs.writeFile(path.join(standIn, "unrelated.txt"), "fixture stand-in must survive", { mode: 0o600 });
        swapped = true;
      };
      const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await originalRename(...args);
        if (!swapped && phase === "stopped-write" && String(args[1]).endsWith("/meta.json")) await swap();
      });
      const unlinkMock = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
        if (!swapped && phase !== "stopped-write") await swap();
        return originalUnlink(...args);
      });
      const request = phase === "unreadable-unlink"
        ? { ...f.request, expectedState: "unreadable", expectedOwner: null, window: "managed_environment_stopped", knownPids: [] }
        : f.request;
      await assert.rejects(releaseRepoGitEnvLeaseForMaintenance({ dataDir: f.dataDir, request, probe: absent }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
      renameMock.mock.restore(); unlinkMock.mock.restore(); assert(swapped);
      assert.deepEqual((await fs.readdir(standIn)).sort(), ["meta.json", "unrelated.txt"]);
      assert.equal(await fs.readFile(path.join(standIn, "unrelated.txt"), "utf8"), "fixture stand-in must survive");
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(standIn, "meta.json"), "utf8")), { ...f.meta, stopState: "stopped" });
      await fs.access(path.join(held, relative));
      if (phase === "stopped-write") assert.equal(JSON.parse(await fs.readFile(path.join(held, relative, "meta.json"), "utf8")).stopState, "stopped");
    });
  }
}
