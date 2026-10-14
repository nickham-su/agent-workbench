import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { newSortableId } from "../utils/ids.js";
import { createRepoGitEnvLease, inspectRepoGitEnvLease, type RepoGitEnvLeaseMeta } from "../modules/git-env/git-env.lease.js";
import { runGitLeaseRecoveryCli } from "./git-lease-recovery.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = fileURLToPath(new URL("git-lease-recovery.ts", import.meta.url));
async function fixture(t: TestContext) {
  const parent = path.join(repoRoot, ".tmp-tests/0032-stage5/cli");
  await fs.mkdir(parent, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(parent, "data-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.now(), leaseId = newSortableId("lease");
  const owner = { workspaceId: "fixture-workspace", sessionId: "finished-session", runId: "completed-run", toolExecutionId: "finished-tool" };
  const meta: RepoGitEnvLeaseMeta = { ...owner, schemaVersion: 2, purpose: "git", leaseId, repo: "fixture-repo", repoId: "fixture-repo", kind: "none", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString(), timeoutMs: 120_000, stopState: "unconfirmed" };
  const directory = await createRepoGitEnvLease({ dataDir, meta });
  await fs.writeFile(path.join(dataDir, "db.sqlite"), "not-a-database-and-must-not-be-opened");
  const releaseArgs = ["release", "--data-dir", dataDir, "--lease-id", leaseId, "--expected-state", "unconfirmed", "--expected-owner", JSON.stringify(owner), "--window", "known_scope", "--evidence-ref", "fixture-exercise-1", "--known-pids", "2147483647", "--confirm-services-stopped", "--confirm-startup-disabled", "--confirm-exclusive-window", "--confirm-coverage"];
  return { dataDir, meta, directory, owner, releaseArgs };
}
async function run(args: string[], input = "", extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "0", AWB_AGENT_WORKER_ENABLED: "false", TSX_DISABLE_CACHE: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); assert(stdout.length < 32_768); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); assert(stderr.length < 32_768); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test("AC-RECOVERY-INSPECT/NO-RUNTIME: real default CLI lists only safe metadata, never touches secrets/database or starts fallback", async (t) => {
  const f = await fixture(t), sentinel = "fixture-secret-must-not-appear";
  await fs.writeFile(path.join(f.directory, "ssh-key"), sentinel, { mode: 0o600 });
  const result = await run([], "", { AWB_DATA_DIR: f.dataDir });
  assert.equal(result.code, 0, result.stderr);
  const inspected = JSON.parse(result.stdout.trim());
  assert.equal(inspected.leaseId, f.meta.leaseId); assert.deepEqual(inspected.owner, f.owner);
  assert.match(inspected.processScope, /Not stored/);
  for (const forbidden of [sentinel, f.dataDir, "ssh-key", "GIT_SSH_COMMAND", "db.sqlite", "repoId"]) assert(!result.stdout.includes(forbidden));
  assert.deepEqual(await fs.readdir(f.directory), ["meta.json", "ssh-key"]);
  assert.equal(await fs.readFile(path.join(f.dataDir, "db.sqlite"), "utf8"), "not-a-database-and-must-not-be-opened");
});

test("AC-RECOVERY-DIRECT/NO-RUNTIME: CLI calls only direct lease services; socket startup count is zero", async (t) => {
  const f = await fixture(t), opened: string[] = [], calls: string[] = [];
  const open = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return open(...args); });
  t.mock.method(net.Server.prototype, "listen", () => { throw new Error("no-network-startup-allowed"); });
  let output = "";
  const io = { input: Readable.from([`RELEASE ${f.meta.leaseId}\n`]), output: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }), error: new Writable({ write(_chunk, _encoding, done) { done(); } }) };
  const code = await runGitLeaseRecoveryCli(f.releaseArgs, { io, services: {
    list: async () => { calls.push("list"); return []; },
    inspect: async (params) => { calls.push("inspect"); return inspectRepoGitEnvLease(params); },
    release: async () => { calls.push("release"); return { ok: true }; },
  } });
  mock.mock.restore();
  assert.equal(code, 0); assert.deepEqual(calls, ["inspect", "release"]);
  for (const name of opened) assert(!/db\.sqlite|ssh-key|git-askpass-token|\.env|known_hosts/.test(name));
  assert.match(output, /cannot prove these facts/);
});

test("AC-RECOVERY-FINISHED/REPEAT: real CLI releases finished owner and repeats idempotently without creating runtime data", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = await run(f.releaseArgs, `RELEASE ${f.meta.leaseId}\n`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"ok":true/); assert.match(result.stdout, /"operatorAssertionsOnly":true/);
    assert(!result.stdout.includes(f.dataDir));
  }
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }), null);
  assert(!await fs.readdir(f.dataDir).then((names) => names.some((name) => ["workspaces", "plugins", "agent"].includes(name))));
});

for (const answer of ["", "yes\n", "RELEASE different-lease\n"]) test("AC-RECOVERY-STOP-EVIDENCE: absent/wrong interactive confirmation cannot release", async (t) => {
  const f = await fixture(t), result = await run(f.releaseArgs, answer);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /GIT_LEASE_MAINTENANCE_CONFIRMATION_REQUIRED/);
  assert(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }));
});

for (const mutation of ["expectation", "flag", "wildcard", "extra", "pid", "symlink"] as const) test(`AC-RECOVERY-EXPECTED/PERMISSION: CLI rejects ${mutation} and preserves lease`, async (t) => {
  const f = await fixture(t), args = [...f.releaseArgs];
  if (mutation === "expectation") args[args.indexOf("--expected-state") + 1] = "stopped";
  if (mutation === "flag") args.splice(args.indexOf("--confirm-coverage"), 1);
  if (mutation === "wildcard") args[args.indexOf("--lease-id") + 1] = "*";
  if (mutation === "extra") args.push("--all");
  if (mutation === "pid") args[args.indexOf("--known-pids") + 1] = String(process.pid);
  if (mutation === "symlink") {
    const link = path.join(path.dirname(f.dataDir), `${path.basename(f.dataDir)}-link`);
    await fs.symlink(f.dataDir, link); t.after(() => fs.unlink(link));
    args[args.indexOf("--data-dir") + 1] = link;
  }
  const result = await run(args, `RELEASE ${f.meta.leaseId}\n`);
  assert.equal(result.code, 1, result.stdout);
  assert(!result.stderr.includes(f.dataDir));
  assert(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }));
});

test("AC-RECOVERY-UNREADABLE: real CLI full-window confirmation handles corrupt meta without leaking content", async (t) => {
  const f = await fixture(t), args = [...f.releaseArgs];
  await fs.writeFile(path.join(f.directory, "meta.json"), "private-corrupt-content-not-to-print");
  args[args.indexOf("--expected-state") + 1] = "unreadable";
  args[args.indexOf("--expected-owner") + 1] = "null";
  let result = await run(args, `RELEASE ${f.meta.leaseId}\n`);
  assert.equal(result.code, 1); assert(!result.stdout.includes("private-corrupt-content"));
  args[args.indexOf("--window") + 1] = "reboot_before_services";
  result = await run(args, `RELEASE ${f.meta.leaseId}\n`);
  assert.equal(result.code, 0, result.stderr);
  assert(!result.stdout.includes("private-corrupt-content"));
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: f.meta.leaseId }), null);
});

test("AC-RECOVERY-MECHANICAL-LIMIT: CLI help distinguishes assertions and verified deployment windows", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  for (const phrase of ["NOT facts", "known_scope", "detached groups", "NOT started", "supervisor", "never use recursive rm"]) assert(result.stdout.includes(phrase));
});
