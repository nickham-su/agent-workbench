import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { applyAnalyticsRetention } from "./analytics-maintenance.js";
import { rebuildCollectedRollup } from "./analytics-rollups.js";

const HOUR_MS = 60 * 60 * 1000;

test("Git collected facts use collected_at indexes and retention preserves only current-generation history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awb-git-maintenance-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const now = 1_000 * HOUR_MS;
  const db = await openAnalyticsDb(root, now);
  t.after(() => closeAnalyticsDb(db));
  const old = now - 10 * HOUR_MS;
  db.prepare(`INSERT INTO analytics_git_scan
    (scan_id,repo_id,started_at,completed_at,source_state,covered_from,covered_to,safe_error_code)
    VALUES ('current','repo',0,?, 'ready',0,?,NULL)`).run(now, now);
  const insert = db.prepare(`INSERT INTO analytics_git_commit_fact
    (repo_id,commit_identity,committed_at,parent_count,files_changed,insertions,deletions,collected_at)
    VALUES ('repo',?,1,0,0,0,0,?)`);
  insert.run("a".repeat(64), old);
  insert.run("b".repeat(64), old);
  db.prepare("INSERT INTO analytics_git_membership(scan_id,repo_id,commit_identity) VALUES ('current','repo',?)").run("a".repeat(64));
  db.prepare("INSERT INTO analytics_git_repo_state(repo_id,current_scan_id,covered_from,covered_to,last_ready_at,last_scan_at) VALUES ('repo','current',0,?,?,?)").run(now, now, now);

  rebuildCollectedRollup(db, old, old + HOUR_MS, now);
  assert.deepEqual(db.prepare("SELECT fact_count FROM dashboard_collected_1h WHERE bucket_start=? AND domain='git'").get(old), { fact_count: 2 });
  const collectedPlan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM analytics_git_commit_fact WHERE collected_at>=? AND collected_at<?").all(old, old + HOUR_MS) as Array<{ detail: string }>;
  assert.equal(collectedPlan.some((row) => row.detail.includes("analytics_git_commit_collected_at")), true);
  const membershipPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT f.committed_at FROM analytics_git_membership m
    JOIN analytics_git_commit_fact f ON f.repo_id=m.repo_id AND f.commit_identity=m.commit_identity
    WHERE m.scan_id=? AND m.repo_id=? AND f.committed_at>=? AND f.committed_at<?`).all("current", "repo", 0, now) as Array<{ detail: string }>;
  assert.equal(membershipPlan.some((row) => row.detail.includes("analytics_git_membership_current") || row.detail.includes("sqlite_autoindex_analytics_git_membership")), true);

  applyAnalyticsRetention(db, now, HOUR_MS);
  assert.equal((db.prepare("SELECT COUNT(*) AS value FROM analytics_git_commit_fact").get() as { value: number }).value, 1);
  assert.equal((db.prepare("SELECT retention_floor FROM analytics_domain_state WHERE domain='git'").get() as { retention_floor: number }).retention_floor, now - HOUR_MS);
});
