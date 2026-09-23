import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { analyticsGitInstallationSecretPath, dbPath, repoMirrorPath } from "../../infra/fs/paths.js";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { scanManagedGitRepos } from "./analytics-git.js";
import { rebuildCollectedRollup } from "./analytics-rollups.js";
import { queryDashboard } from "./analytics-dashboard-query.js";
import { acceptAnalyticsSignal } from "./signal-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
let activeGitStubControlPath: string | null = null;
const STUB_OBJECT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function setup(prefix: string, enableGit = true) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const analytics = await openAnalyticsDb(dataDir, 1);
  if (enableGit)
    assert.equal(acceptAnalyticsSignal(analytics, {
      kind: "expected_slots_config", sentAt: 0, requestId: "test-enable-git", sourceConfigVersion: 1, effectiveAt: 0,
      enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "git"],
      slots: [
        { domain: "execution", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
        { domain: "model", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
      ],
    }, 0).accepted, true);
  const business = new Database(dbPath(dataDir));
  business.exec(`CREATE TABLE repos (
      id TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, default_branch TEXT, mirror_path TEXT NOT NULL DEFAULT '',
      sync_status TEXT NOT NULL DEFAULT 'idle', sync_error TEXT, last_sync_at INTEGER
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, dir_name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', path TEXT NOT NULL,
      terminal_credential_id TEXT, last_used_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE workspace_repos (
      workspace_id TEXT NOT NULL, repo_id TEXT NOT NULL, dir_name TEXT NOT NULL, path TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workspace_id, repo_id)
    );
    CREATE INDEX idx_workspace_repos_repo_id ON workspace_repos(repo_id);`);
  const gitStub = path.join(dataDir, "git-reader");
  const gitStubControl = path.join(dataDir, "git-reader-control.json");
  await writeFile(gitStubControl, JSON.stringify({ mode: "ok", originOutput: "", tagOutput: "" }));
  activeGitStubControlPath = gitStubControl;
  await writeFile(gitStub, `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
const control = JSON.parse(fs.readFileSync(${JSON.stringify(gitStubControl)}, "utf8"));
if (control.mode === "timeout") setTimeout(() => {}, 60_000);
else if (control.mode === "fail") process.exit(1);
else process.stdout.write(control.originOutput);
`);
  await chmod(gitStub, 0o700);
  const fdReader = path.join(dataDir, "fd-reader");
  await writeFile(fdReader, `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs"); const path = process.getBuiltinModule("node:path");
const gitDir = process.argv.find((arg) => arg.startsWith("--git-dir=/proc/self/fd/"));
if (!gitDir) process.exit(2);
const objectDir = process.env.GIT_OBJECT_DIRECTORY;
if (objectDir !== "/proc/self/fd/4") process.exit(3);
if (process.env.GIT_NO_LAZY_FETCH !== "1" || process.env.GIT_NO_REPLACE_OBJECTS !== "1") process.exit(4);
if (["GIT_COMMON_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_KEY_0"].some((key) => key in process.env)) process.exit(5);
const head = fs.readFileSync(path.join(objectDir, "analytics-mode"), "utf8").trim();
if (head === "fail") process.exit(1);
const sha = fs.readFileSync(0, "utf8").trim().split("\\n")[0];
if (!/^[0-9a-f]{40,64}$/i.test(sha || "")) process.exit(6);
const emit = () => process.stdout.write("\\x1e" + sha + "\\x1f" + seconds + "\\x1f\\n1\\t2\\t\\n");
const seconds = head === "safe" ? "1" : "2";
if (head === "slow") setTimeout(emit, 45);
else emit();
`);
  await chmod(fdReader, 0o700);
  return { dataDir, analytics, business, gitStub, gitStubControl, fdReader };
}

async function makeBareMirror(dataDir: string, repoId: string, head = "ref: refs/heads/main\n") {
  const mirror = repoMirrorPath(dataDir, repoId);
  await mkdir(path.join(mirror, "objects", "info"), { recursive: true });
  await mkdir(path.join(mirror, "refs", "remotes", "origin"), { recursive: true });
  // The scanner needs only a controlled bare-mirror directory; the executable
  // is a non-Git reader stub so this test performs no Git write operation.
  await writeFile(path.join(mirror, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(mirror, "refs", "remotes", "origin", "main"), `${STUB_OBJECT_ID}\n`);
  await writeFile(path.join(mirror, "objects", "analytics-mode"), head.trim() || "safe");
}

async function makeStubWorkspaceGitDir(gitDir: string, mode = "safe") {
  await mkdir(path.join(gitDir, "objects", "info"), { recursive: true });
  await mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(gitDir, "refs", "heads", "main"), `${STUB_OBJECT_ID}\n`);
  await writeFile(path.join(gitDir, "objects", "analytics-mode"), mode);
}

function addRepo(business: Database.Database, id: string, status: "idle" | "syncing" | "failed" = "idle") {
  business.prepare("INSERT INTO repos(id,sync_status) VALUES (?,?)").run(id, status);
}

function logRecord(commitToken: string, committedAt: number, parentTokens = "", stats = "1\t2\t\n") {
  return `\x1e${commitToken}\x1f${Math.floor(committedAt / 1000)}\x1f${parentTokens}\n${stats}`;
}

async function withGitOutput<T>(mode: "ok" | "fail" | "timeout", originOutput: string, run: () => Promise<T>) {
  assert.ok(activeGitStubControlPath);
  const controlPath = activeGitStubControlPath;
  await writeFile(controlPath, JSON.stringify({ mode, originOutput, tagOutput: logRecord(randomBytes(20).toString("hex"), 1) }));
  try {
    return await run();
  } finally {
    await writeFile(controlPath, JSON.stringify({ mode: "ok", originOutput: "", tagOutput: "" }));
  }
}

async function git(args: string[], cwd?: string) {
  await execFileAsync("git", args, {
    cwd,
    timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

async function gitText(args: string[], cwd?: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}

async function commitFixture(repository: string, message: string, file: string) {
  await writeFile(path.join(repository, file), `${message}\n`);
  await git(["add", file], repository);
  await git(["commit", "--no-gpg-sign", "-m", message], repository);
}

async function createRealGitSource(
  dataDir: string,
  repoId: string,
  objectFormat?: "sha256",
) {
  const source = path.join(dataDir, "fixture-source");
  const mirror = repoMirrorPath(dataDir, repoId);
  await mkdir(source, { recursive: true });
  await git(objectFormat ? ["init", `--object-format=${objectFormat}`] : ["init"], source);
  await git(["config", "user.email", "analytics-test@example.invalid"], source);
  await git(["config", "user.name", "Analytics Test"], source);
  await commitFixture(source, "mirror-private-base", "base.txt");
  await mkdir(path.dirname(mirror), { recursive: true });
  await git(objectFormat ? ["init", "--bare", `--object-format=${objectFormat}`, mirror] : ["init", "--bare", mirror]);
  await git([`--git-dir=${mirror}`, "remote", "add", "origin", source]);
  await git([
    `--git-dir=${mirror}`,
    "fetch",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  return { source, mirror };
}

async function attachRealWorkspace(
  business: Database.Database,
  dataDir: string,
  source: string,
  repoId: string,
  workspaceId: string,
) {
  const workspaceDir = `workspace-${workspaceId}`;
  const repoDir = "repo";
  const repository = path.join(dataDir, "workspaces", workspaceDir, repoDir);
  await mkdir(path.dirname(repository), { recursive: true });
  await git(["clone", source, repository]);
  await git(["config", "user.email", "analytics-test@example.invalid"], repository);
  await git(["config", "user.name", "Analytics Test"], repository);
  // The path columns are deliberately hostile: Analytics must use dir_name.
  business.prepare("INSERT INTO workspaces(id,dir_name,path) VALUES(?,?,?)")
    .run(workspaceId, workspaceDir, path.join(dataDir, "outside-workspace"));
  business.prepare("INSERT INTO workspace_repos(workspace_id,repo_id,dir_name,path) VALUES(?,?,?,?)")
    .run(workspaceId, repoId, repoDir, path.join(dataDir, "outside-repo"));
  return repository;
}

function currentMembership(db: Database.Database, repoId: string) {
  return (db.prepare(`SELECT m.commit_identity FROM analytics_git_membership m
    JOIN analytics_git_repo_state r ON r.repo_id=m.repo_id AND r.current_scan_id=m.scan_id
    WHERE m.repo_id=? ORDER BY m.commit_identity`).all(repoId) as Array<{ commit_identity: string }>)
    .map((row) => row.commit_identity);
}

test("empty baseline does not authorize Git scanning", async (t) => {
  const ctx = await setup("awb-git-empty-baseline-", false);
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  addRepo(ctx.business, "repo");
  await makeBareMirror(ctx.dataDir, "repo");
  assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1, gitCommand: ctx.gitStub }), { attempted: 0, succeeded: 0 });
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS count FROM analytics_git_scan").get() as { count: number }).count, 0);
});

test("Analytics-root symlink makes the Git secret unavailable and fails scan without external writes", async (t) => {
  const ctx = await setup("awb-git-secret-symlink-");
  const outside = await mkdtemp(path.join(os.tmpdir(), "awb-git-secret-outside-"));
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await Promise.all([rm(ctx.dataDir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  addRepo(ctx.business, "repo");
  await rename(path.join(ctx.dataDir, "analytics"), path.join(ctx.dataDir, "analytics-held"));
  await symlink(outside, path.join(ctx.dataDir, "analytics"));
  assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1, gitCommand: ctx.gitStub }), { attempted: 0, succeeded: 0 });
  assert.deepEqual(await readdir(outside), []);
  assert.equal((ctx.analytics.prepare("SELECT last_error_code FROM analytics_domain_state WHERE domain='git'").get() as { last_error_code: string | null }).last_error_code, "GIT_SECRET_UNAVAILABLE");
});

test("scanner reads only idle controlled mirrors, retains facts, and atomically replaces current membership", async (t) => {
  const ctx = await setup("awb-git-scanner-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  const now = 500 * DAY_MS;
  addRepo(ctx.business, "idle-repo");
  addRepo(ctx.business, "syncing-repo", "syncing");
  await makeBareMirror(ctx.dataDir, "idle-repo");
  await makeBareMirror(ctx.dataDir, "syncing-repo");
  const firstToken = randomBytes(20).toString("hex");
  const olderToken = randomBytes(20).toString("hex");
  await withGitOutput("ok", logRecord(firstToken, now - 5 * DAY_MS) + logRecord(olderToken, now - 6 * DAY_MS), async () => {
    assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now, gitCommand: ctx.gitStub }), { attempted: 1, succeeded: 1 });
  });
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value, 2);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_membership").get() as { value: number }).value, 2);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_repo_state WHERE repo_id='syncing-repo'").get() as { value: number }).value, 1);
  const secondToken = randomBytes(20).toString("hex");
  await withGitOutput("ok", logRecord(secondToken, now - 4 * DAY_MS), () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: now + 1, gitCommand: ctx.gitStub }));
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value, 3);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_membership").get() as { value: number }).value, 1);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_membership m JOIN analytics_git_scan s ON s.scan_id=m.scan_id WHERE s.source_state='ready'").get() as { value: number }).value, 1);
});

test("scanner records safe failures, preserves prior readiness, and bounds source history", async (t) => {
  const ctx = await setup("awb-git-failure-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  const now = 100 * DAY_MS;
  addRepo(ctx.business, "repo"); await makeBareMirror(ctx.dataDir, "repo");
  await withGitOutput("ok", logRecord(randomBytes(20).toString("hex"), now - DAY_MS), () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now, gitCommand: ctx.gitStub }));
  const ready = ctx.analytics.prepare("SELECT current_scan_id,covered_to FROM analytics_git_repo_state WHERE repo_id='repo'").get() as { current_scan_id: string; covered_to: number };
  await withGitOutput("fail", "", () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: now + 1, gitCommand: ctx.gitStub }));
  assert.deepEqual(ctx.analytics.prepare("SELECT current_scan_id,covered_to FROM analytics_git_repo_state WHERE repo_id='repo'").get(), ready);
  assert.deepEqual(ctx.analytics.prepare("SELECT source_state,safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get(), { source_state: "failed", safe_error_code: "GIT_COMMAND_FAILED" });
});

test("scanner tracks commits by HMAC identity and validates output constraints", async (t) => {
  const ctx = await setup("awb-git-output-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  const now = 200 * DAY_MS;
  addRepo(ctx.business, "repo"); await makeBareMirror(ctx.dataDir, "repo");
  await withGitOutput("ok", "", () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now, gitCommand: ctx.gitStub }));
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value, 0);
  const later = randomBytes(20).toString("hex"), earlier = randomBytes(20).toString("hex");
  await withGitOutput("ok", logRecord(later, now - 2 * DAY_MS) + logRecord(earlier, now - 7 * DAY_MS), () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: now + 1, gitCommand: ctx.gitStub }));
  const identities = ctx.analytics.prepare("SELECT commit_identity FROM analytics_git_commit_fact ORDER BY committed_at").all() as Array<{ commit_identity: string }>;
  assert.equal(identities.length, 2); assert.equal(identities.every(({ commit_identity }) => /^[a-f0-9]{64}$/.test(commit_identity)), true);
  await withGitOutput("ok", logRecord(randomBytes(20).toString("hex"), now) + logRecord(randomBytes(20).toString("hex"), now), () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: now + 2, gitCommand: ctx.gitStub, limits: { maxCommits: 1 } }));
  assert.deepEqual(ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get(), { safe_error_code: "GIT_SCAN_BUDGET" });
  await withGitOutput("timeout", "", () => scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: now + 3, gitCommand: ctx.gitStub, limits: { timeoutMs: 20 } }));
  assert.deepEqual(ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get(), { safe_error_code: "GIT_SCAN_TIMEOUT" });
});

test("scanner rejects unsafe mirrors without exposing their contents", async (t) => {
  const ctx = await setup("awb-git-unsafe-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  addRepo(ctx.business, "repo");
  const outside = await mkdtemp(path.join(os.tmpdir(), "awb-git-outside-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await mkdir(path.dirname(repoMirrorPath(ctx.dataDir, "repo")), { recursive: true });
  await symlink(outside, repoMirrorPath(ctx.dataDir, "repo"));
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1, gitCommand: ctx.gitStub });
  assert.deepEqual(ctx.analytics.prepare("SELECT source_state,safe_error_code FROM analytics_git_scan").get(), { source_state: "failed", safe_error_code: "GIT_MIRROR_UNSAFE" });
});

test("scanner holds a verified mirror FD across a post-check symlink replacement", async (t) => {
  const ctx = await setup("awb-git-fd-toctou-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  addRepo(ctx.business, "idle-repo");
  await makeBareMirror(ctx.dataDir, "idle-repo", "safe\n");
  const outside = await mkdtemp(path.join(os.tmpdir(), "awb-git-external-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "HEAD"), "external\n");
  const mirror = repoMirrorPath(ctx.dataDir, "idle-repo");
  const heldMirror = path.join(path.dirname(mirror), "held-mirror.git");
  await scanManagedGitRepos({
    db: ctx.analytics, dataDir: ctx.dataDir, now: 10_000, gitCommand: ctx.fdReader,
    afterMirrorOpenedForTest: async () => {
      await rename(mirror, heldMirror);
      await symlink(outside, mirror);
    }
  });
  assert.deepEqual(ctx.analytics.prepare("SELECT committed_at FROM analytics_git_commit_fact").get(), { committed_at: 1_000 });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan WHERE source_state='failed'").get() as { safe_error_code: string } | undefined), undefined);
});

test("Git Domain health is certified over every managed repo and never advances past a failed or stale peer", async (t) => {
  const ctx = await setup("awb-git-domain-state-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  const hour = 60 * 60 * 1_000;
  const first = 500 * DAY_MS;
  addRepo(ctx.business, "repo-a"); addRepo(ctx.business, "repo-b");
  await makeBareMirror(ctx.dataDir, "repo-a", "ok\n"); await makeBareMirror(ctx.dataDir, "repo-b", "ok\n");
  assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: first, gitCommand: ctx.fdReader }), { attempted: 2, succeeded: 2 });
  assert.deepEqual(ctx.analytics.prepare("SELECT status,reconciled_through FROM analytics_domain_state WHERE domain='git'").get(), { status: "healthy", reconciled_through: first });

  const second = first + hour;
  await writeFile(path.join(repoMirrorPath(ctx.dataDir, "repo-b"), "objects", "analytics-mode"), "fail");
  assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: second, gitCommand: ctx.fdReader }), { attempted: 2, succeeded: 1 });
  assert.deepEqual(ctx.analytics.prepare("SELECT status,reconciled_through FROM analytics_domain_state WHERE domain='git'").get(), { status: "degraded", reconciled_through: first });

  const third = second + hour;
  await writeFile(path.join(repoMirrorPath(ctx.dataDir, "repo-b"), "objects", "analytics-mode"), "ok");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: third, gitCommand: ctx.fdReader });
  assert.deepEqual(ctx.analytics.prepare("SELECT status,reconciled_through FROM analytics_domain_state WHERE domain='git'").get(), { status: "healthy", reconciled_through: third });

  const staleNow = third + 3 * 60 * 60 * 1_000;
  ctx.analytics.prepare("UPDATE analytics_git_repo_state SET last_ready_at=? WHERE repo_id='repo-a'").run(third - 3 * 60 * 60 * 1_000);
  ctx.business.prepare("UPDATE repos SET sync_status='syncing' WHERE id='repo-a'").run();
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: staleNow, gitCommand: ctx.fdReader });
  assert.deepEqual(ctx.analytics.prepare("SELECT status,reconciled_through FROM analytics_domain_state WHERE domain='git'").get(), { status: "degraded", reconciled_through: third });
});

test("Git Fact collection timestamps follow actual completion rather than the source anchor", async (t) => {
  const ctx = await setup("awb-git-collected-at-");
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  const hour = 60 * 60 * 1_000;
  const sourceAnchor = 600 * DAY_MS;
  const completedAt = sourceAnchor + hour + 10;
  addRepo(ctx.business, "repo"); await makeBareMirror(ctx.dataDir, "repo", "ok\n");
  let mirrorOpened!: () => void;
  const opened = new Promise<void>((resolve) => { mirrorOpened = resolve; });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const clockValues = [sourceAnchor + 10, completedAt, completedAt + 10];
  const scan = scanManagedGitRepos({
    db: ctx.analytics, dataDir: ctx.dataDir, now: sourceAnchor, gitCommand: ctx.fdReader,
    clock: () => clockValues.shift() ?? completedAt + 10,
    afterMirrorOpenedForTest: async () => { mirrorOpened(); await paused; }
  });
  await opened;
  // Maintenance seals the source-anchor hour while the reader is still live.
  rebuildCollectedRollup(ctx.analytics, sourceAnchor, sourceAnchor + hour, sourceAnchor + hour);
  release(); await scan;
  assert.deepEqual(ctx.analytics.prepare("SELECT started_at,completed_at,covered_to FROM analytics_git_scan WHERE source_state='ready'").get(), {
    started_at: sourceAnchor + 10, completed_at: completedAt, covered_to: sourceAnchor
  });
  assert.deepEqual(ctx.analytics.prepare("SELECT collected_at,last_ready_at,last_scan_at FROM analytics_git_commit_fact f JOIN analytics_git_repo_state r ON r.repo_id=f.repo_id").get(), {
    collected_at: completedAt, last_ready_at: completedAt, last_scan_at: completedAt
  });
  assert.deepEqual(ctx.analytics.prepare("SELECT fact_count FROM dashboard_collected_1h WHERE bucket_start=? AND domain='git'").get(sourceAnchor), { fact_count: 0 });
  rebuildCollectedRollup(ctx.analytics, sourceAnchor + hour, sourceAnchor + 2 * hour, sourceAnchor + 2 * hour);
  assert.deepEqual(ctx.analytics.prepare("SELECT fact_count FROM dashboard_collected_1h WHERE bucket_start=? AND domain='git'").get(sourceAnchor + hour), { fact_count: 1 });
  ctx.analytics.prepare("UPDATE analytics_domain_state SET status='healthy',collection_started_at=0,reconciled_through=?").run(sourceAnchor + 2 * hour);
  const dashboard = queryDashboard(ctx.analytics, { rangeKind: "custom", timezone: "UTC", from: sourceAnchor + hour, to: sourceAnchor + 2 * hour }, sourceAnchor + 2 * hour);
  assert.equal(dashboard.kind, "success");
  assert.equal(dashboard.data.overview.monitoringVolume.value?.count, 1);
});

test("Git scan is superseded when a newer source config disables Git in flight", async (t) => {
  const ctx = await setup("awb-git-source-superseded-", false);
  t.after(async () => { ctx.business.close(); closeAnalyticsDb(ctx.analytics); await rm(ctx.dataDir, { recursive: true, force: true }); });
  const repoId = "repo";
  addRepo(ctx.business, repoId);
  ctx.business.prepare("INSERT INTO workspaces(id,dir_name,path) VALUES('workspace','workspace','ignored')").run();
  ctx.business.prepare("INSERT INTO workspace_repos(workspace_id,repo_id,dir_name,path) VALUES('workspace',?,'repo','ignored')").run(repoId);
  const gitDir = path.join(ctx.dataDir, "workspaces", "workspace", "repo", ".git");
  await makeBareMirror(ctx.dataDir, repoId, "safe\n");
  await makeStubWorkspaceGitDir(gitDir, "safe");
  assert.equal(acceptAnalyticsSignal(ctx.analytics, {
    kind: "expected_slots_config", sentAt: 99, requestId: "enable-git", sourceConfigVersion: 1, effectiveAt: 99,
    enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "git"],
    slots: [
      { domain: "execution", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
      { domain: "model", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
    ],
  }, 99).accepted, true);
  assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 100, gitCommand: ctx.fdReader }), { attempted: 1, succeeded: 1 });
  const prior = ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId) as { current_scan_id: string };
  let opened!: () => void;
  const started = new Promise<void>((resolve) => { opened = resolve; });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const scan = scanManagedGitRepos({
    db: ctx.analytics, dataDir: ctx.dataDir, now: 101, gitCommand: ctx.fdReader,
    afterMirrorOpenedForTest: async () => { opened(); await paused; },
  });
  await started;
  assert.equal(acceptAnalyticsSignal(ctx.analytics, {
    kind: "expected_slots_config", sentAt: 101, requestId: "disable-git", sourceConfigVersion: 2, effectiveAt: 101,
    enabledFactDomains: ["execution", "model"],
    slots: [
      { domain: "execution", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
      { domain: "model", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
    ],
  }, 101).accepted, true);
  release();
  await scan;
  assert.deepEqual(ctx.analytics.prepare("SELECT source_state,safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get(), { source_state: "failed", safe_error_code: "GIT_SCAN_SUPERSEDED" });
  assert.deepEqual(ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId), prior);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS count FROM analytics_git_membership WHERE scan_id=(SELECT scan_id FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1)").get() as { count: number }).count, 0);
  assert.deepEqual(ctx.analytics.prepare("SELECT status FROM analytics_domain_state WHERE domain='git'").get(), { status: "disabled" });
});

test("real Git Workspace refs contribute unpushed commits and union current membership without leaking locators", async (t) => {
  const ctx = await setup("awb-git-real-workspace-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "real-repo";
  addRepo(ctx.business, repoId);
  const { source } = await createRealGitSource(ctx.dataDir, repoId);
  const first = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "one");
  const second = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "two");
  await commitFixture(first, "workspace-one-private-message", "one.txt");
  await commitFixture(second, "workspace-two-private-message", "two.txt");
  const firstRaw = await gitText(["rev-parse", "HEAD"], first);
  const secondRaw = await gitText(["rev-parse", "HEAD"], second);

  assert.deepEqual(
    await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() }),
    { attempted: 1, succeeded: 1 },
  );
  const membership = currentMembership(ctx.analytics, repoId);
  assert.equal(membership.length, 3, "base plus two distinct unpushed workspace tips");
  const persisted = JSON.stringify({
    facts: ctx.analytics.prepare("SELECT * FROM analytics_git_commit_fact").all(),
    scans: ctx.analytics.prepare("SELECT * FROM analytics_git_scan").all(),
    errors: ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan").all(),
  });
  assert.equal(persisted.includes(firstRaw), false);
  assert.equal(persisted.includes(secondRaw), false);
  assert.equal(persisted.includes(first), false);
  assert.equal(persisted.includes("workspace-one-private-message"), false);
  assert.equal(persisted.includes("workspace-two-private-message"), false);
});

test("real Git Workspace source snapshots remove rewritten and deleted refs while retaining historical facts", async (t) => {
  const ctx = await setup("awb-git-real-membership-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "membership-repo";
  addRepo(ctx.business, repoId);
  const { source } = await createRealGitSource(ctx.dataDir, repoId);
  const workspace = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "one");
  await git(["switch", "-c", "discarded-ref"], workspace);
  await commitFixture(workspace, "discarded-private-message", "discarded.txt");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() });
  const beforeDelete = currentMembership(ctx.analytics, repoId);
  assert.equal(beforeDelete.length, 2);
  const historicalFactCount = (ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value;

  await git(["switch", "-"], workspace);
  await git(["branch", "-D", "discarded-ref"], workspace);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() + 1 });
  const afterDelete = currentMembership(ctx.analytics, repoId);
  assert.equal(afterDelete.length, 1);
  assert.equal(beforeDelete.some((identity) => !afterDelete.includes(identity)), true);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value, historicalFactCount);
});

test("an amended unpushed Workspace tip replaces only current membership while retaining its historical Fact", async (t) => {
  const ctx = await setup("awb-git-real-amend-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "amend-repo";
  addRepo(ctx.business, repoId);
  const { source } = await createRealGitSource(ctx.dataDir, repoId);
  const workspace = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "one");
  await commitFixture(workspace, "first-unpushed-private-message", "change.txt");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() });
  const before = currentMembership(ctx.analytics, repoId);
  await writeFile(path.join(workspace, "change.txt"), "amended content\n");
  await git(["add", "change.txt"], workspace);
  await git(["commit", "--amend", "--no-gpg-sign", "-m", "amended-unpushed-private-message"], workspace);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() + 1 });
  const after = currentMembership(ctx.analytics, repoId);
  assert.equal(after.length, 2);
  assert.equal(before.some((identity) => !after.includes(identity)), true);
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value, 3);
});

test("Workspace locator or source failures preserve the prior current generation and fixed descriptor resists replacement", async (t) => {
  const ctx = await setup("awb-git-real-failures-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "failure-repo";
  addRepo(ctx.business, repoId);
  const { source, mirror } = await createRealGitSource(ctx.dataDir, repoId);
  const workspace = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "one");
  await commitFixture(workspace, "workspace-fd-private-message", "fd.txt");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() });

  const gitDirectory = path.join(workspace, ".git");
  const retained = `${gitDirectory}.retained`;
  await scanManagedGitRepos({
    db: ctx.analytics,
    dataDir: ctx.dataDir,
    now: Date.now() + 1,
    afterWorkspaceGitOpenedForTest: async () => {
      await rename(gitDirectory, retained);
      await symlink(mirror, gitDirectory);
    },
  });
  assert.equal(currentMembership(ctx.analytics, repoId).length, 2, "the fixed .git descriptor supplies the original workspace history");
  const fixedDescriptorCurrent = ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId);

  await rm(gitDirectory, { force: true });
  await rename(retained, gitDirectory);
  await rename(gitDirectory, retained);
  await symlink(mirror, gitDirectory);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() + 2 });
  assert.deepEqual(ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId), fixedDescriptorCurrent);
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_COMMAND_FAILED");
  await rm(gitDirectory, { force: true });
  await rename(retained, gitDirectory);

  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() + 3, gitCommand: "/bin/false" });
  assert.deepEqual(ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId), fixedDescriptorCurrent);

  ctx.business.prepare("UPDATE workspace_repos SET dir_name='../outside',path=? WHERE repo_id=?").run("/outside/must-not-be-read", repoId);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() + 4 });
  assert.deepEqual(ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId), fixedDescriptorCurrent);

  ctx.business.prepare("DROP TABLE workspace_repos").run();
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: Date.now() + 5 });
  assert.deepEqual(ctx.analytics.prepare("SELECT current_scan_id FROM analytics_git_repo_state WHERE repo_id=?").get(repoId), fixedDescriptorCurrent);
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_MIRROR_UNSAFE");
});

test("workspace source conflicts and aggregate source budgets fail rather than publishing a partial snapshot", async (t) => {
  const ctx = await setup("awb-git-workspace-budget-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "budget-repo";
  addRepo(ctx.business, repoId);
  await makeBareMirror(ctx.dataDir, repoId, "safe\n");
  ctx.business.prepare("INSERT INTO workspaces(id,dir_name,path) VALUES('one','one','ignored')").run();
  ctx.business.prepare("INSERT INTO workspace_repos(workspace_id,repo_id,dir_name,path) VALUES('one',?,'repo','ignored')").run(repoId);
  const gitDir = path.join(ctx.dataDir, "workspaces", "one", "repo", ".git");
  await makeStubWorkspaceGitDir(gitDir, "ok");

  // `safe` and `ok` emit the same raw object identity with different aggregate
  // fields through the deterministic FD reader. A source snapshot must reject
  // that impossible identity conflict instead of selecting either source.
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 10, gitCommand: ctx.fdReader });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SCAN_OUTPUT_INVALID");
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS count FROM analytics_git_membership").get() as { count: number }).count, 0);

  await writeFile(path.join(gitDir, "objects", "analytics-mode"), "safe");
  await scanManagedGitRepos({
    db: ctx.analytics,
    dataDir: ctx.dataDir,
    now: 11,
    gitCommand: ctx.fdReader,
    limits: { maxCommits: 1 },
  });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SCAN_BUDGET");
  assert.equal((ctx.analytics.prepare("SELECT COUNT(*) AS count FROM analytics_git_membership").get() as { count: number }).count, 0);

  ctx.business.prepare("INSERT INTO workspaces(id,dir_name,path) VALUES('two','two','ignored')").run();
  ctx.business.prepare("INSERT INTO workspace_repos(workspace_id,repo_id,dir_name,path) VALUES('two',?,'repo','ignored')").run(repoId);
  const secondGitDir = path.join(ctx.dataDir, "workspaces", "two", "repo", ".git");
  await makeStubWorkspaceGitDir(secondGitDir, "safe");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 12, gitCommand: ctx.fdReader });
  const priorMembership = currentMembership(ctx.analytics, repoId);
  await writeFile(path.join(gitDir, "objects", "analytics-mode"), "slow");
  await writeFile(path.join(secondGitDir, "objects", "analytics-mode"), "slow");
  const startedAt = Date.now();
  await scanManagedGitRepos({
    db: ctx.analytics,
    dataDir: ctx.dataDir,
    now: 13,
    gitCommand: ctx.fdReader,
    limits: { timeoutMs: 70 },
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SCAN_TIMEOUT");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), priorMembership);
  assert.ok(elapsedMs < 180, `the shared deadline must bound all Workspace reads, got ${elapsedMs}ms`);
});

test("external alternates are rejected before their commits can enter Analytics or leak", async (t) => {
  const ctx = await setup("awb-git-alternates-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "alternate-repo";
  addRepo(ctx.business, repoId);
  const { mirror } = await createRealGitSource(ctx.dataDir, repoId);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 });
  const priorMembership = currentMembership(ctx.analytics, repoId);
  const external = path.join(ctx.dataDir, "external-object-source");
  await mkdir(external, { recursive: true });
  await git(["init"], external);
  await git(["config", "user.email", "analytics-test@example.invalid"], external);
  await git(["config", "user.name", "Analytics Test"], external);
  await commitFixture(external, "external-alternate-private-message", "external.txt");
  const externalSha = await gitText(["rev-parse", "HEAD"], external);
  const externalObjects = path.join(external, ".git", "objects");
  await writeFile(path.join(mirror, "objects", "info", "alternates"), `${externalObjects}\n`);
  await git([`--git-dir=${mirror}`, "update-ref", "refs/remotes/origin/external", externalSha]);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 2 });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SOURCE_UNSAFE");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), priorMembership);
  const persisted = JSON.stringify(ctx.analytics.prepare("SELECT * FROM analytics_git_commit_fact").all());
  assert.equal(persisted.includes(externalSha), false);
  assert.equal(persisted.includes(externalObjects), false);
  assert.equal(persisted.includes("external-alternate-private-message"), false);
});

test("Git child ignores inherited object, common, alternate, and config environments", async (t) => {
  const ctx = await setup("awb-git-child-env-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "environment-repo";
  addRepo(ctx.business, repoId);
  const { mirror } = await createRealGitSource(ctx.dataDir, repoId);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 });
  const priorMembership = currentMembership(ctx.analytics, repoId);
  const external = path.join(ctx.dataDir, "inherited-env-external");
  await mkdir(external, { recursive: true });
  const injected: Record<string, string> = {
    GIT_OBJECT_DIRECTORY: path.join(external, "objects"),
    GIT_COMMON_DIR: external,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(external, "alternate-objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: external,
  };
  const previous = new Map(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  try {
    assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 2 }), { attempted: 1, succeeded: 1 });
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.deepEqual(currentMembership(ctx.analytics, repoId), priorMembership);
  assert.equal(JSON.stringify(ctx.analytics.prepare("SELECT * FROM analytics_git_scan").all()).includes(mirror), false);
});

test("Git source validation rejects objects, commondir, refs symlinks, and Workspace config includes", async (t) => {
  const ctx = await setup("awb-git-source-validation-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "validation-repo";
  addRepo(ctx.business, repoId);
  const { source, mirror } = await createRealGitSource(ctx.dataDir, repoId);
  const workspace = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "one");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 });
  const priorMembership = currentMembership(ctx.analytics, repoId);
  const external = path.join(ctx.dataDir, "outside-git-source");
  await mkdir(external, { recursive: true });
  const externalInclude = path.join(external, "included.config");
  await writeFile(externalInclude, "[core]\n  worktree = /outside\n");
  const assertRejected = async (now: number) => {
    await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now });
    assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SOURCE_UNSAFE");
    assert.deepEqual(currentMembership(ctx.analytics, repoId), priorMembership);
  };

  const refsSymlink = path.join(mirror, "refs", "external-ref");
  await symlink(external, refsSymlink);
  await assertRejected(2);
  await unlink(refsSymlink);

  const commonDir = path.join(mirror, "commondir");
  await writeFile(commonDir, `${external}\n`);
  await assertRejected(3);
  await unlink(commonDir);

  const objects = path.join(mirror, "objects");
  const movedObjects = path.join(mirror, "objects-held");
  await rename(objects, movedObjects);
  await symlink(movedObjects, objects);
  await assertRejected(4);
  await unlink(objects);
  await rename(movedObjects, objects);

  const head = path.join(mirror, "HEAD");
  const heldHead = path.join(mirror, "HEAD-held");
  await rename(head, heldHead);
  await symlink(externalInclude, head);
  await assertRejected(5);
  await unlink(head);
  await rename(heldHead, head);

  const config = path.join(mirror, "config");
  const heldConfig = path.join(mirror, "config-held");
  await rename(config, heldConfig);
  await symlink(externalInclude, config);
  await assertRejected(6);
  await unlink(config);
  await rename(heldConfig, config);

  const packedRefs = path.join(mirror, "packed-refs");
  await rm(packedRefs, { force: true });
  await symlink(externalInclude, packedRefs);
  await assertRejected(7);
  await unlink(packedRefs);

  await git(["config", "--local", "include.path", externalInclude], workspace);
  await assertRejected(8);
  const persisted = JSON.stringify(ctx.analytics.prepare("SELECT * FROM analytics_git_scan").all());
  assert.equal(persisted.includes(external), false);
  assert.equal(persisted.includes(externalInclude), false);
});

test("partial-clone config redirectors fail closed without replacing current membership", async (t) => {
  const ctx = await setup("awb-git-partial-clone-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "partial-repo";
  addRepo(ctx.business, repoId);
  const { mirror } = await createRealGitSource(ctx.dataDir, repoId);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 });
  const prior = currentMembership(ctx.analytics, repoId);
  await git([`--git-dir=${mirror}`, "config", "extensions.partialClone", "origin"]);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 2 });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan WHERE repo_id=? ORDER BY started_at DESC LIMIT 1").get(repoId) as { safe_error_code: string }).safe_error_code, "GIT_SOURCE_UNSAFE");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), prior);
  await git([`--git-dir=${mirror}`, "config", "--unset", "extensions.partialClone"]);
  await git([`--git-dir=${mirror}`, "config", "remote.origin.promisor", "true"]);
  await git([`--git-dir=${mirror}`, "config", "remote.origin.partialCloneFilter", "blob:none"]);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 3 });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan WHERE repo_id=? ORDER BY started_at DESC LIMIT 1").get(repoId) as { safe_error_code: string }).safe_error_code, "GIT_SOURCE_UNSAFE");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), prior);
  const persisted = JSON.stringify(ctx.analytics.prepare("SELECT * FROM analytics_git_scan").all());
  assert.equal(persisted.includes("partialCloneFilter"), false);
  assert.equal(persisted.includes("blob:none"), false);
});

test("refs and config replacements after FD snapshot cannot change the Git child input", async (t) => {
  const ctx = await setup("awb-git-ref-snapshot-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "snapshot-repo";
  addRepo(ctx.business, repoId);
  const { mirror } = await createRealGitSource(ctx.dataDir, repoId);
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 });
  const prior = currentMembership(ctx.analytics, repoId);
  assert.deepEqual(await scanManagedGitRepos({
    db: ctx.analytics,
    dataDir: ctx.dataDir,
    now: 2,
    afterSourceSnapshotForTest: async (_repoId, scope) => {
      if (scope !== "mirror") return;
      await writeFile(path.join(mirror, "refs", "remotes", "origin", "master"), `${"f".repeat(40)}\n`);
      await writeFile(path.join(mirror, "config"), "[include]\n  path = /outside/never-read\n");
    },
  }), { attempted: 1, succeeded: 1 });
  assert.deepEqual(currentMembership(ctx.analytics, repoId), prior);
  assert.equal(JSON.stringify(ctx.analytics.prepare("SELECT * FROM analytics_git_scan").all()).includes("/outside/never-read"), false);
});

test("object-tree changes after Git spawn discard the source snapshot", async (t) => {
  const ctx = await setup("awb-git-object-fingerprint-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "fingerprint-repo";
  addRepo(ctx.business, repoId);
  const { mirror } = await createRealGitSource(ctx.dataDir, repoId);
  await mkdir(path.join(mirror, "objects", "pack"), { recursive: true });
  await writeFile(path.join(mirror, "objects", "pack", "pre-snapshot-marker"), "before");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 });
  const prior = currentMembership(ctx.analytics, repoId);
  await scanManagedGitRepos({
    db: ctx.analytics,
    dataDir: ctx.dataDir,
    now: 2,
    afterGitSpawnedForTest: async (_repoId, scope) => {
      if (scope !== "mirror") return;
      const marker = path.join(mirror, "objects", "pack", "pre-snapshot-marker");
      await rename(marker, `${marker}-held`);
      await writeFile(marker, "after");
    },
  });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SOURCE_UNSAFE");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), prior);
});

test("source tree entry and deadline budgets fail safely before publication", async (t) => {
  const ctx = await setup("awb-git-source-budget-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "source-budget-repo";
  addRepo(ctx.business, repoId);
  await makeBareMirror(ctx.dataDir, repoId, "safe");
  await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1, gitCommand: ctx.fdReader });
  const prior = currentMembership(ctx.analytics, repoId);
  const objects = path.join(repoMirrorPath(ctx.dataDir, repoId), "objects");
  await Promise.all(Array.from({ length: 4 }, (_, index) => writeFile(path.join(objects, `bulk-${index}`), "x")));
  await scanManagedGitRepos({
    db: ctx.analytics, dataDir: ctx.dataDir, now: 2, gitCommand: ctx.fdReader,
    sourceLimitsForTest: { maxEntries: 3 },
  });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SOURCE_UNSAFE");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), prior);
  await scanManagedGitRepos({
    db: ctx.analytics, dataDir: ctx.dataDir, now: 3, gitCommand: ctx.fdReader,
    limits: { timeoutMs: 1 },
    afterMirrorOpenedForTest: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  assert.equal((ctx.analytics.prepare("SELECT safe_error_code FROM analytics_git_scan ORDER BY started_at DESC LIMIT 1").get() as { safe_error_code: string }).safe_error_code, "GIT_SCAN_TIMEOUT");
  assert.deepEqual(currentMembership(ctx.analytics, repoId), prior);
});

test("SHA-256 repositories retain normal Git Analytics support when Git provides it", async (t) => {
  const ctx = await setup("awb-git-sha256-");
  t.after(async () => {
    ctx.business.close();
    closeAnalyticsDb(ctx.analytics);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  const repoId = "sha256-repo";
  addRepo(ctx.business, repoId);
  try {
    const { source } = await createRealGitSource(ctx.dataDir, repoId, "sha256");
    const workspace = await attachRealWorkspace(ctx.business, ctx.dataDir, source, repoId, "one");
    await commitFixture(workspace, "sha256-unpushed-private-message", "sha256.txt");
    assert.deepEqual(await scanManagedGitRepos({ db: ctx.analytics, dataDir: ctx.dataDir, now: 1 }), { attempted: 1, succeeded: 1 });
    assert.equal(currentMembership(ctx.analytics, repoId).length, 2);
  } catch (error: any) {
    if (/object format|sha256|unknown option/i.test(String(error?.message))) {
      t.skip("system Git does not support SHA-256 repositories");
      return;
    }
    throw error;
  }
});
