import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { newSortableId } from "../../utils/ids.js";
import { createRepoGitEnvLease, inspectRepoGitEnvLease, type RepoGitEnvLeaseMeta } from "./git-env.lease.js";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../../../../../", import.meta.url));
const root = path.join(project, ".tmp-tests/0032-stage5-review/metadata");
const leaseModule = new URL("./git-env.lease.ts", import.meta.url).href;
const janitorModule = new URL("./git-env.janitor.ts", import.meta.url).href;
const cliModule = new URL("../../maintenance/git-lease-recovery.ts", import.meta.url).href;
async function fixture(t: TestContext) {
  assert.equal(process.platform, "linux", "This regression requires the supported Linux platform and real mkfifo");
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, "meta-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.now();
  const meta: RepoGitEnvLeaseMeta = { schemaVersion: 2, purpose: "git", leaseId: newSortableId("lease"), workspaceId: "fixture-workspace", sessionId: "finished-session", runId: "finished-run", toolExecutionId: "finished-tool", repo: "fixture-repo", repoId: "fixture-repo", kind: "none", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(), timeoutMs: 120_000, stopState: "unconfirmed" };
  const directory = await createRepoGitEnvLease({ dataDir, meta });
  const other = { ...meta, leaseId: newSortableId("lease"), workspaceId: "another-workspace" };
  await createRepoGitEnvLease({ dataDir, meta: other });
  const metaFile = path.join(directory, "meta.json");
  await fs.unlink(metaFile);
  await exec("mkfifo", ["-m", "600", metaFile], { cwd: project, timeout: 5000 });
  assert((await fs.lstat(metaFile)).isFIFO()); // No writer is ever opened.
  const request = { leaseId: meta.leaseId, expectedState: "unreadable", expectedOwner: null, window: "managed_environment_stopped", evidenceRef: "isolated-mechanical-fixture", servicesStopped: true, startupDisabled: true, exclusiveWindow: true, coverageVerified: true, knownPids: [], knownPgids: [], confirmedLeaseId: meta.leaseId };
  return { dataDir, directory, metaFile, meta, other, request };
}
async function bounded(f: Awaited<ReturnType<typeof fixture>>, body: string) {
  // A broken blocking open must fail the test, not strand the test runner's
  // libuv pool. Only the isolated child is killed on a regression timeout.
  const script = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    import * as lease from ${JSON.stringify(leaseModule)};
    const f = ${JSON.stringify(f)};
    const code = (wanted) => (error) => error?.code === wanted;
    ${body}`;
  const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: project, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "0" }, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  assert.equal(result.stderr, "");
}

for (const route of ["inspect", "normal-release", "batch-inspect", "workspace-guard", "janitor", "maintenance-without-evidence"] as const) {
  test(`M1/AC-LEASE-BAD-META/RECOVERY-INSPECT: writerless Linux FIFO is bounded through ${route} and remains protected`, async (t) => {
    const f = await fixture(t);
    const bodies = {
      inspect: `assert.equal((await lease.inspectRepoGitEnvLease({dataDir:f.dataDir,leaseId:f.meta.leaseId})).state,'unreadable');`,
      "normal-release": `await assert.rejects(lease.releaseRepoGitEnvLease({dataDir:f.dataDir,request:{workspaceId:f.meta.workspaceId,sessionId:f.meta.sessionId,runId:f.meta.runId,toolExecutionId:f.meta.toolExecutionId,leaseId:f.meta.leaseId,stopEvidence:'not_started'}}),code('GIT_LEASE_STATE_UNAVAILABLE'));`,
      "batch-inspect": `import {runGitLeaseRecoveryCli} from ${JSON.stringify(cliModule)}; import {Readable,Writable} from 'node:stream';
        let output='',error=''; const io={input:Readable.from([]),output:new Writable({write(c,e,done){output+=c;done();}}),error:new Writable({write(c,e,done){error+=c;done();}})};
        assert.equal(await runGitLeaseRecoveryCli(['inspect','--data-dir',f.dataDir],{io}),0);assert.equal(error,'');
        const rows=output.trim().split('\\n').map(x=>JSON.parse(x));assert.equal(rows.length,2);
        assert.equal(rows.find(x=>x.leaseId===f.meta.leaseId).state,'unreadable');assert.equal(rows.find(x=>x.leaseId===f.other.leaseId).state,'unconfirmed');`,
      "workspace-guard": `await assert.rejects(lease.assertNoRepoGitEnvLeaseHold({dataDir:f.dataDir,workspaceId:f.meta.workspaceId}),code('GIT_LEASE_STATE_UNAVAILABLE'));`,
      janitor: `import {cleanupExpiredGitEnvLeases} from ${JSON.stringify(janitorModule)};await cleanupExpiredGitEnvLeases({dataDir:f.dataDir,nowMs:Date.now()+24*60*60_000});`,
      "maintenance-without-evidence": `for(const request of [{...f.request,window:undefined},{...f.request,window:'known_scope',knownPids:[2147483647]},{...f.request,coverageVerified:false},{...f.request,servicesStopped:false}]) {
        await assert.rejects(lease.releaseRepoGitEnvLeaseForMaintenance({dataDir:f.dataDir,request}),(error)=>['GIT_LEASE_MAINTENANCE_INVALID','GIT_LEASE_MAINTENANCE_EVIDENCE_REQUIRED'].includes(error?.code));}
        // Full declarations do not weaken the shared flat-regular-artifact delete
        // guard: a FIFO itself stays protected. Regular corrupt meta is covered below.
        await assert.rejects(lease.releaseRepoGitEnvLeaseForMaintenance({dataDir:f.dataDir,request:f.request}),code('GIT_LEASE_STATE_UNAVAILABLE'));`,
    };
    await bounded(f, `${bodies[route]} assert((await fs.lstat(f.metaFile)).isFIFO()); assert.equal((await lease.inspectRepoGitEnvLease({dataDir:f.dataDir,leaseId:f.other.leaseId})).state,'unconfirmed');`);
  });
}

for (const mutation of ["fifo", "directory", "symlink", "hardlink", "oversized", "permissions", "stat-EIO", "read-EIO"] as const) {
  test(`M1/AC-LEASE-BAD-META/ROOT: ${mutation} rejects metadata and closes every acquired fd`, async (t) => {
    const f = await fixture(t);
    if (mutation !== "fifo") {
      await fs.unlink(f.metaFile);
      if (mutation === "directory") await fs.mkdir(f.metaFile, { mode: 0o700 });
      else if (mutation === "symlink") {
        const target = path.join(f.dataDir, "fixture-target");
        await fs.writeFile(target, "fixture target must not be read", { mode: 0o600 });
        await fs.symlink(target, f.metaFile);
      } else {
        await fs.writeFile(f.metaFile, mutation === "oversized" ? "x".repeat(64 * 1024 + 1) : JSON.stringify(f.meta), { mode: mutation === "permissions" ? 0o644 : 0o600 });
        if (mutation === "permissions") await fs.chmod(f.metaFile, 0o644);
        if (mutation === "hardlink") await fs.link(f.metaFile, path.join(f.dataDir, "fixture-hardlink"));
      }
    }
    const open = fs.open, handles: fs.FileHandle[] = [];
    let metaAttempts = 0, nonblocking = false;
    const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const isMeta = String(args[0]).endsWith("/meta.json");
      if (isMeta) {
        metaAttempts++; nonblocking = typeof args[1] === "number" && (args[1] & constants.O_NONBLOCK) !== 0;
        // Refuse before entering a blocking syscall if flags regress. The real
        // kernel behavior is independently exercised in bounded child tests.
        if (!nonblocking) throw new Error("fixture refuses a potentially blocking open");
      }
      const handle = await open(...args); handles.push(handle);
      const eio = () => { throw Object.assign(new Error("fixture metadata I/O failure"), { code: "EIO" }); };
      if (isMeta && mutation === "stat-EIO") handle.stat = (async () => eio()) as typeof handle.stat;
      if (isMeta && mutation === "read-EIO") handle.read = (async () => eio()) as typeof handle.read;
      return handle;
    });
    const result = await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId });
    mock.mock.restore();
    assert.equal(result?.state, "unreadable"); assert.equal(metaAttempts, 1); assert(nonblocking);
    assert(handles.length >= 5); assert(handles.every((handle) => handle.fd === -1), "all metadata and directory handles close on rejection/EIO");
    await fs.lstat(f.metaFile);
  });
}

for (const window of ["managed_environment_stopped", "reboot_before_services"] as const) {
  test(`M1/AC-RECOVERY-UNREADABLE: explicit ${window} still releases regular corrupt metadata, never a blanket unreadable prohibition`, async (t) => {
    const f = await fixture(t);
    await fs.unlink(f.metaFile); await fs.writeFile(f.metaFile, "fixture corrupt regular metadata", { mode: 0o600 });
    await bounded(f, `assert.deepEqual(await lease.releaseRepoGitEnvLeaseForMaintenance({dataDir:f.dataDir,request:{...f.request,window:${JSON.stringify(window)}}}),{ok:true});
      await assert.rejects(fs.access(f.directory),code('ENOENT'));assert.equal((await lease.inspectRepoGitEnvLease({dataDir:f.dataDir,leaseId:f.other.leaseId})).state,'unconfirmed');`);
  });
}
