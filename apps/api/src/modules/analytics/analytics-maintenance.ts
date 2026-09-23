import type { AnalyticsDb } from "./analytics-db.js";

export const DEFAULT_ANALYTICS_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Bounded, best-effort retention.  Business-time query floors are updated in
 * the same transaction as cleanup.  Open Model/Execution facts are retained:
 * their eventual end can still change duration, coverage and gap semantics.
 */
export function applyAnalyticsRetention(db: AnalyticsDb, now = Date.now(), retentionMs = DEFAULT_ANALYTICS_RETENTION_MS) {
  const physicalFloor = now - retentionMs;
  const bucketFloor = Math.floor(physicalFloor / HOUR_MS) * HOUR_MS;
  const run = db.transaction(() => {
    for (const table of ["analytics_run_fact", "analytics_session_fact", "analytics_message_fact", "analytics_tool_fact", "analytics_worker_event_fact"]) {
      db.prepare(`DELETE FROM ${table} WHERE collected_at < ?`).run(physicalFloor);
    }
    db.prepare(`DELETE FROM analytics_execution_fact WHERE collected_at < ? AND status = 'ended' AND end_time_quality IN ('observed', 'inferred') AND effective_ended_at < ?`).run(physicalFloor, physicalFloor);
    db.prepare(`DELETE FROM analytics_model_call_fact WHERE collected_at < ? AND status <> 'running' AND completion_quality = 'observed' AND ended_at IS NOT NULL AND ended_at < ?`).run(physicalFloor, physicalFloor);
    db.prepare(`DELETE FROM analytics_git_commit_fact WHERE collected_at < ?
      AND NOT EXISTS (SELECT 1 FROM analytics_git_membership m JOIN analytics_git_repo_state r
        ON r.repo_id=m.repo_id AND r.current_scan_id=m.scan_id
        WHERE m.repo_id=analytics_git_commit_fact.repo_id AND m.commit_identity=analytics_git_commit_fact.commit_identity)`).run(physicalFloor);
    // A non-terminal producer still needs its entire receipt prefix for
    // checkpoint continuity. Pruning it would make a live generation appear
    // to have an unexplained sequence gap.
    db.prepare(`DELETE FROM analytics_event_receipt WHERE committed_at < ?
      AND NOT EXISTS (SELECT 1 FROM analytics_producer_generation g
        WHERE g.producer_namespace=analytics_event_receipt.producer_namespace
          AND g.producer_id=analytics_event_receipt.producer_id AND g.producer_generation=analytics_event_receipt.producer_generation
          AND g.lifecycle IN ('registered','closing','stale'))`).run(physicalFloor);
    db.prepare("DELETE FROM dashboard_model_1h WHERE bucket_start + ? <= ?").run(HOUR_MS, bucketFloor);
    db.prepare("DELETE FROM dashboard_tool_1h WHERE bucket_start + ? <= ?").run(HOUR_MS, bucketFloor);
    db.prepare("DELETE FROM dashboard_message_1h WHERE bucket_start + ? <= ?").run(HOUR_MS, bucketFloor);
    db.prepare("DELETE FROM dashboard_collected_1h WHERE bucket_start + ? <= ?").run(HOUR_MS, bucketFloor);
    db.prepare("DELETE FROM analytics_dirty_hour WHERE bucket_start + ? <= ?").run(HOUR_MS, bucketFloor);
    db.prepare("DELETE FROM analytics_rollup_hour WHERE bucket_start + ? <= ?").run(HOUR_MS, bucketFloor);
    db.prepare("UPDATE analytics_domain_state SET retention_floor = ?, updated_at = ?").run(physicalFloor, now);
    db.prepare(`INSERT INTO analytics_maintenance_state(task_name, last_started_at, last_succeeded_at, last_error_code, updated_at)
      VALUES ('retention', ?, ?, NULL, ?) ON CONFLICT(task_name) DO UPDATE SET last_started_at=excluded.last_started_at, last_succeeded_at=excluded.last_succeeded_at, last_error_code=NULL, updated_at=excluded.updated_at`).run(now, now, now);
  });
  run();
}
