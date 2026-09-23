import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyticsGitInstallationSecretPath } from "../../infra/fs/paths.js";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { gitCommitIdentity, readOrCreateGitInstallationSecret } from "./analytics-git.js";

async function tempDataDir() {
  return mkdtemp(path.join(os.tmpdir(), "awb-analytics-git-"));
}

test("Git installation secret is stable, private, and scopes commit identities by repo", async (t) => {
  const dataDir = await tempDataDir();
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 100);
  t.after(() => closeAnalyticsDb(db));

  const first = await readOrCreateGitInstallationSecret(dataDir, db);
  const second = await readOrCreateGitInstallationSecret(dataDir, db);
  assert.ok(first);
  assert.deepEqual(second, first);
  assert.equal(first.length, 32);
  assert.equal((await readFile(analyticsGitInstallationSecretPath(dataDir))).length, 32);
  assert.equal((await stat(analyticsGitInstallationSecretPath(dataDir))).mode & 0o077, 0);
  // The input is deliberately opaque test data, never a real repository SHA.
  assert.notEqual(gitCommitIdentity(first, "repo-a", "opaque-commit-input"), gitCommitIdentity(first, "repo-b", "opaque-commit-input"));
});

test("Git secret concurrent initialization publishes one durable private file and removes temporary candidates", async (t) => {
  const dataDir = await tempDataDir();
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 100);
  t.after(() => closeAnalyticsDb(db));

  const secrets = await Promise.all(Array.from({ length: 12 }, () => readOrCreateGitInstallationSecret(dataDir, db)));
  assert.equal(secrets.every(Buffer.isBuffer), true);
  assert.equal(secrets.every((secret) => secret!.equals(secrets[0]!)), true);
  const secretPath = analyticsGitInstallationSecretPath(dataDir);
  assert.equal((await stat(secretPath)).mode & 0o077, 0);
  assert.deepEqual(await readFile(secretPath), secrets[0]);
  assert.equal((await readdir(path.dirname(secretPath))).some((name) => name.endsWith(".tmp")), false);
});

test("Git secret is unavailable when its file is unsafe or historical Git facts exist", async (t) => {
  const dataDir = await tempDataDir();
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 100);
  t.after(() => closeAnalyticsDb(db));
  const secretPath = analyticsGitInstallationSecretPath(dataDir);

  assert.ok(await readOrCreateGitInstallationSecret(dataDir, db));
  await chmod(secretPath, 0o644);
  assert.equal(await readOrCreateGitInstallationSecret(dataDir, db), null);
  await chmod(secretPath, 0o600);
  await unlink(secretPath);
  db.prepare(`INSERT INTO analytics_git_scan
    (scan_id,repo_id,started_at,completed_at,source_state,covered_from,covered_to,safe_error_code)
    VALUES ('historical-scan','repo',1,NULL,'running',NULL,NULL,NULL)`).run();
  db.prepare("INSERT INTO analytics_git_repo_state(repo_id,current_scan_id,covered_from,covered_to,last_ready_at,last_scan_at) VALUES ('repo',NULL,NULL,NULL,NULL,1)").run();
  db.prepare("INSERT INTO analytics_git_membership(scan_id,repo_id,commit_identity) VALUES ('historical-scan','repo',?)").run("a".repeat(64));
  assert.equal(await readOrCreateGitInstallationSecret(dataDir, db), null);
  db.prepare(`INSERT INTO analytics_git_commit_fact
    (repo_id, commit_identity, committed_at, parent_count, files_changed, insertions, deletions, collected_at)
    VALUES ('repo', ?, 1, 0, 0, 0, 0, 1)`).run("b".repeat(64));
  assert.equal(await readOrCreateGitInstallationSecret(dataDir, db), null);
});
