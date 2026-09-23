import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { DashboardQuerySuccessResponseSchema } from "@agent-workbench/shared";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { queryDashboard } from "./analytics-dashboard-query.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type Commit = { identity: string; committedAt: number; parents: number; files: number | null; added: number | null; deleted: number | null };

async function database(now: number) {
  const root = await mkdtemp(join(tmpdir(), "awb-git-dashboard-"));
  const db = await openAnalyticsDb(root, now);
  return { root, db };
}

function insertCurrent(db: Awaited<ReturnType<typeof openAnalyticsDb>>, input: { repo: string; scan: string; coverageFrom: number; now: number; commits: Commit[]; lastReadyAt?: number }) {
  db.prepare(`INSERT INTO analytics_git_scan
    (scan_id,repo_id,started_at,completed_at,source_state,covered_from,covered_to,safe_error_code)
    VALUES(?,?,?,?,'ready',?,?,NULL)`).run(input.scan, input.repo, input.now, input.now, input.coverageFrom, input.now);
  const fact = db.prepare(`INSERT INTO analytics_git_commit_fact
    (repo_id,commit_identity,committed_at,parent_count,files_changed,insertions,deletions,collected_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  const membership = db.prepare("INSERT INTO analytics_git_membership(scan_id,repo_id,commit_identity) VALUES(?,?,?)");
  for (const commit of input.commits) {
    fact.run(input.repo, commit.identity, commit.committedAt, commit.parents, commit.files, commit.added, commit.deleted, input.now);
    membership.run(input.scan, input.repo, commit.identity);
  }
  db.prepare(`INSERT INTO analytics_git_repo_state(repo_id,current_scan_id,covered_from,covered_to,last_ready_at,last_scan_at)
    VALUES(?,?,?,?,?,?)`).run(input.repo, input.scan, input.coverageFrom, input.now, input.lastReadyAt ?? input.now, input.now);
}

function insertNotReady(db: Awaited<ReturnType<typeof openAnalyticsDb>>, repo: string) {
  db.prepare("INSERT INTO analytics_git_repo_state(repo_id,current_scan_id,covered_from,covered_to,last_ready_at,last_scan_at) VALUES(?,NULL,NULL,NULL,NULL,NULL)").run(repo);
}

function custom(from: number, to: number) {
  return { rangeKind: "custom" as const, timezone: "UTC", from, to };
}

test("Git cards and trends only use current membership; merge changes are excluded", async (t) => {
  const now = 500 * DAY_MS;
  const { root, db } = await database(now);
  t.after(async () => { closeAnalyticsDb(db); await rm(root, { recursive: true, force: true }); });
  const from = now - 7 * DAY_MS;
  insertCurrent(db, { repo: "repo", scan: "current", coverageFrom: now - 30 * DAY_MS, now, commits: [
    { identity: "a".repeat(64), committedAt: now - DAY_MS, parents: 1, files: 3, added: 4, deleted: 5 },
    { identity: "b".repeat(64), committedAt: now - 2 * DAY_MS, parents: 2, files: null, added: null, deleted: null }
  ] });
  // This Fact simulates a force-pushed commit. It remains retained but is not
  // a member of the current generation and must not affect Git range metrics.
  db.prepare(`INSERT INTO analytics_git_commit_fact
    (repo_id,commit_identity,committed_at,parent_count,files_changed,insertions,deletions,collected_at)
    VALUES ('repo',?, ?,1,99,99,99,?)`).run("c".repeat(64), now - DAY_MS, now);

  const response = queryDashboard(db, custom(from, now), now);
  assert.equal(response.kind, "success");
  assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
  assert.equal(response.data.git.metrics.commits.value, 2);
  assert.equal(response.data.git.metrics.nonMergeCommits.value, 1);
  assert.equal(response.data.git.metrics.filesChanged.value, 3);
  assert.equal(response.data.git.metrics.linesAdded.value, 4);
  assert.equal(response.data.git.metrics.linesDeleted.value, 5);
  assert.equal(response.data.git.trends.commits.data?.reduce((sum, point) => sum + point.count, 0), 2);
  assert.equal(response.data.git.metrics.commits.comparison.status, "previous_zero");
});

test("monitoring volume counts retained Git Facts by first collected_at without membership", async (t) => {
  const now = 500 * DAY_MS;
  const { root, db } = await database(now);
  t.after(async () => { closeAnalyticsDb(db); await rm(root, { recursive: true, force: true }); });
  db.prepare("UPDATE analytics_domain_state SET status='healthy',collection_started_at=0,reconciled_through=?").run(now + 60 * 60_000);
  db.prepare(`INSERT INTO analytics_git_commit_fact
    (repo_id,commit_identity,committed_at,parent_count,files_changed,insertions,deletions,collected_at)
    VALUES ('removed-repo',?,1,0,0,0,0,?)`).run("e".repeat(64), now);
  const response = queryDashboard(db, custom(now, now + 60 * 60_000), now + 60 * 60_000);
  assert.equal(response.kind, "success");
  assert.equal(response.data.overview.monitoringVolume.status, "available");
  assert.equal(response.data.overview.monitoringVolume.value?.count, 1);
  assert.equal(response.data.overviewTrends.monitoringVolume.data?.[0]?.git, 1);
});

test("Git range and heatmap calculate coverage independently", async (t) => {
  const now = 500 * DAY_MS;
  const { root, db } = await database(now);
  t.after(async () => { closeAnalyticsDb(db); await rm(root, { recursive: true, force: true }); });
  insertCurrent(db, { repo: "repo", scan: "current", coverageFrom: now - 30 * DAY_MS, now, commits: [{ identity: "d".repeat(64), committedAt: now - DAY_MS, parents: 0, files: 1, added: 1, deleted: 0 }] });
  const recent = queryDashboard(db, custom(now - 7 * DAY_MS, now), now);
  assert.equal(recent.kind, "success");
  assert.equal(recent.data.git.metrics.commits.status, "available");
  assert.equal(recent.data.exceptions.gitHeatmap180d.status, "partial");
  assert.equal(recent.data.exceptions.gitHeatmap180d.partialReason, "range_before_coverage");

  db.prepare("UPDATE analytics_git_repo_state SET covered_from=? WHERE repo_id='repo'").run(now - 181 * DAY_MS);
  const historical = queryDashboard(db, custom(now - 200 * DAY_MS, now), now);
  assert.equal(historical.kind, "success");
  assert.equal(historical.data.git.metrics.commits.status, "partial");
  assert.equal(historical.data.git.metrics.commits.partialReason, "range_before_coverage");
  assert.equal(historical.data.exceptions.gitHeatmap180d.status, "available");
  assert.equal(historical.data.exceptions.gitHeatmap180d.data?.days.length, 180);
});

test("Git coverage emits unavailable, dedicated partial reasons, and ready/total metadata", async (t) => {
  const now = 500 * DAY_MS;
  const { root, db } = await database(now);
  t.after(async () => { closeAnalyticsDb(db); await rm(root, { recursive: true, force: true }); });
  const from = now - 7 * DAY_MS;
  insertNotReady(db, "not-ready");
  let response = queryDashboard(db, custom(from, now), now);
  assert.equal(response.kind, "success");
  assert.equal(response.data.git.metrics.commits.status, "unavailable");
  assert.equal(response.data.git.metrics.commits.value, null);
  assert.equal(response.data.git.metrics.commits.readyRepoCount, 0);
  assert.equal(response.data.git.metrics.commits.totalRepoCount, 1);

  db.prepare("DELETE FROM analytics_git_repo_state").run();
  insertCurrent(db, { repo: "repo", scan: "range", coverageFrom: now - DAY_MS, now, commits: [] });
  response = queryDashboard(db, custom(from, now), now);
  assert.equal(response.kind, "success");
  assert.equal(response.data.git.metrics.commits.status, "partial");
  if (response.data.git.metrics.commits.status !== "partial") throw new Error("expected partial Git metric");
  assert.equal(response.data.git.metrics.commits.partialReason, "range_before_coverage");

  db.prepare("UPDATE analytics_git_repo_state SET covered_from=?,last_ready_at=? WHERE repo_id='repo'").run(now - 30 * DAY_MS, now - 3 * 60 * 60_000);
  response = queryDashboard(db, custom(from, now), now);
  assert.equal(response.kind, "success");
  assert.equal(response.data.git.metrics.commits.status, "partial");
  if (response.data.git.metrics.commits.status !== "partial") throw new Error("expected partial Git metric");
  assert.equal(response.data.git.metrics.commits.partialReason, "scan_stale");

  insertNotReady(db, "not-ready");
  response = queryDashboard(db, custom(from, now), now);
  assert.equal(response.kind, "success");
  assert.equal(response.data.git.metrics.commits.status, "partial");
  if (response.data.git.metrics.commits.status !== "partial") throw new Error("expected partial Git metric");
  assert.equal(response.data.git.metrics.commits.partialReason, "mixed_repo_coverage");
  assert.equal(response.data.git.metrics.commits.readyRepoCount, 1);
  assert.equal(response.data.git.metrics.commits.totalRepoCount, 2);
});

test("Git heatmap returns exactly 180 IANA local-day buckets across DST", async (t) => {
  const now = Date.parse("2024-11-05T18:00:00.000Z");
  const { root, db } = await database(now);
  t.after(async () => { closeAnalyticsDb(db); await rm(root, { recursive: true, force: true }); });
  insertCurrent(db, { repo: "repo", scan: "current", coverageFrom: now - 250 * DAY_MS, now, commits: [] });
  const response = queryDashboard(db, { rangeKind: "preset_7d", timezone: "America/New_York" }, now);
  assert.equal(response.kind, "success");
  const days = response.data.exceptions.gitHeatmap180d.data?.days ?? [];
  assert.equal(days.length, 180);
  assert.equal(days.some((day) => day.to - day.from === 25 * 60 * 60_000), true);
});
