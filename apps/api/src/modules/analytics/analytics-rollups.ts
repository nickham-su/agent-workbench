import type { AnalyticsDb } from "./analytics-db.js";

export const HOUR_MS = 60 * 60 * 1000;
export const utcHourStart = (value: number) => Math.floor(value / HOUR_MS) * HOUR_MS;
export type RollupDomain = "model" | "tool" | "message";
export type HourSource = { bucketStart: number; from: number; to: number; source: "fact" | "rollup" };

/**
 * The sole source-selection authority for dashboard hourly resources. A cache
 * marker is a replacement row: it exists even for a zero-valued hour, unlike
 * the dimensional Tool/Message rows themselves.
 */
export function planUtcHourSources(input: {
  domain: RollupDomain;
  from: number;
  to: number;
  coverageEstablished: (from: number, to: number) => boolean;
  rollupReadyThrough: number | null;
  dirtyHours: ReadonlySet<number>;
  rebuiltHours: ReadonlySet<number>;
}): HourSource[] {
  const plan: HourSource[] = [];
  let continuous = true;
  for (let bucketStart = utcHourStart(input.from); bucketStart < input.to; bucketStart += HOUR_MS) {
    const bucketEnd = bucketStart + HOUR_MS;
    const from = Math.max(input.from, bucketStart);
    const to = Math.min(input.to, bucketEnd);
    const fullClosedHour = from === bucketStart && to === bucketEnd;
    const useRollup = fullClosedHour
      && input.rollupReadyThrough !== null
      && bucketEnd <= input.rollupReadyThrough
      && !input.dirtyHours.has(bucketStart)
      && input.rebuiltHours.has(bucketStart)
      && input.coverageEstablished(bucketStart, bucketEnd);
    const source = useRollup && continuous ? "rollup" : "fact";
    plan.push({ bucketStart, from, to, source });
    // Do not trust a claimed ready-through watermark beyond an observed hole.
    if (fullClosedHour && bucketEnd <= (input.rollupReadyThrough ?? 0) && (!input.rebuiltHours.has(bucketStart) || input.dirtyHours.has(bucketStart))) continuous = false;
  }
  return plan;
}

/** Marks a business-time hour dirty in the same Analytics transaction as its fact update. */
export function markDirtyHour(db: AnalyticsDb, domain: RollupDomain, eventTime: number, now = Date.now()) {
  db.prepare(`INSERT INTO analytics_dirty_hour(domain, bucket_start, marked_at) VALUES (?, ?, ?)
    ON CONFLICT(domain, bucket_start) DO UPDATE SET marked_at = excluded.marked_at`).run(domain, utcHourStart(eventTime), now);
}

function advanceReadyThrough(db: AnalyticsDb, domain: RollupDomain, seed: number, now: number) {
  const state = db.prepare("SELECT rollup_ready_through FROM analytics_domain_state WHERE domain=?").get(domain) as { rollup_ready_through: number | null };
  let cursor = state.rollup_ready_through ?? seed;
  while (db.prepare("SELECT 1 FROM analytics_rollup_hour WHERE domain=? AND bucket_start=?").get(domain, cursor)
    && !db.prepare("SELECT 1 FROM analytics_dirty_hour WHERE domain=? AND bucket_start=?").get(domain, cursor)) cursor += HOUR_MS;
  db.prepare("UPDATE analytics_domain_state SET rollup_ready_through=?, updated_at=? WHERE domain=?").run(cursor, now, domain);
}

/** Replaces closed Dirty hours. Dirty removal, zero markers and readiness move atomically. */
export function rebuildDirtyRollups(db: AnalyticsDb, now = Date.now(), maxBuckets = 24) {
  const rows = db.prepare(`SELECT domain, bucket_start FROM analytics_dirty_hour WHERE bucket_start + ? <= ?
    ORDER BY bucket_start, domain LIMIT ?`).all(HOUR_MS, now, maxBuckets) as Array<{ domain: RollupDomain; bucket_start: number }>;
  db.transaction(() => {
    for (const { domain, bucket_start } of rows) {
      const end = bucket_start + HOUR_MS;
      if (domain === "model") {
        const value = db.prepare(`SELECT COUNT(*) AS request_count, SUM(status='completed') AS completed_count, SUM(status='failed') AS failed_count,
          SUM(status='timed_out') AS timed_out_count, SUM(status NOT IN ('completed','failed','timed_out')) AS other_count,
          COALESCE(SUM(CASE WHEN status='completed' AND ended_at IS NOT NULL THEN ended_at-started_at ELSE 0 END),0) AS duration_sum,
          SUM(status='completed' AND ended_at IS NOT NULL) AS duration_samples, COALESCE(SUM(input_tokens),0) AS input_tokens,
          COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(total_tokens),0) AS total_tokens
           FROM analytics_model_call_fact WHERE started_at>=? AND started_at<?`).get(bucket_start, end) as Record<string, number>;
        db.prepare("INSERT OR REPLACE INTO dashboard_model_1h VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(bucket_start, value.request_count, value.completed_count ?? 0, value.failed_count ?? 0, value.timed_out_count ?? 0, value.other_count ?? 0, value.duration_sum, value.duration_samples ?? 0, value.input_tokens, value.output_tokens, value.total_tokens);
        db.prepare("DELETE FROM dashboard_model_dimension_1h WHERE bucket_start=?").run(bucket_start);
        const dimensions = db.prepare(`SELECT provider_id, model_id, status, timeout_kind, COUNT(*) AS request_count,
          COALESCE(SUM(CASE WHEN status='completed' AND ended_at IS NOT NULL THEN ended_at-started_at ELSE 0 END),0) AS duration_sum, SUM(status='completed' AND ended_at IS NOT NULL) AS duration_samples,
          COALESCE(SUM(input_tokens),0) AS input_tokens, SUM(input_tokens IS NOT NULL) AS input_reported_count, COALESCE(SUM(output_tokens),0) AS output_tokens, SUM(output_tokens IS NOT NULL) AS output_reported_count,
          COALESCE(SUM(total_tokens),0) AS total_tokens, SUM(total_source='reported') AS total_reported_count, SUM(total_source='derived') AS total_derived_count,
           COALESCE(SUM(CASE WHEN cache_comparable=1 THEN cache_read_tokens ELSE 0 END),0) AS cache_read_tokens, SUM(cache_comparable=1) AS cache_comparable_count,
           COALESCE(SUM(CASE WHEN cache_comparable=1 THEN cache_input_tokens ELSE 0 END),0) AS comparable_input_tokens, COALESCE(SUM(CASE WHEN cache_comparable=1 THEN cache_read_tokens ELSE 0 END),0) AS comparable_cache_read_tokens
          FROM analytics_model_call_fact WHERE started_at>=? AND started_at<? GROUP BY provider_id, model_id, status, timeout_kind`).all(bucket_start, end) as Array<Record<string, unknown>>;
        const insertDimension = db.prepare("INSERT INTO dashboard_model_dimension_1h VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const row of dimensions) insertDimension.run(bucket_start, row.provider_id, row.model_id, row.status, row.timeout_kind, row.request_count, row.duration_sum, row.duration_samples, row.input_tokens, row.input_reported_count, row.output_tokens, row.output_reported_count, row.total_tokens, row.total_reported_count, row.total_derived_count, row.cache_read_tokens, row.cache_comparable_count, row.comparable_input_tokens, row.comparable_cache_read_tokens);
      } else if (domain === "tool") {
        db.prepare("DELETE FROM dashboard_tool_1h WHERE bucket_start=?").run(bucket_start);
        const source = db.prepare(`SELECT tool_name, status, COUNT(*) AS call_count, COALESCE(SUM(completed_duration_ms),0) AS duration_sum,
          SUM(completed_duration_ms IS NOT NULL) AS duration_samples FROM analytics_tool_fact WHERE created_at>=? AND created_at<? GROUP BY tool_name,status`).all(bucket_start, end) as Array<Record<string, unknown>>;
        const insert = db.prepare("INSERT INTO dashboard_tool_1h VALUES (?, ?, ?, ?, ?, ?)");
        for (const row of source) insert.run(bucket_start, row.tool_name, row.status, row.call_count, row.duration_sum, row.duration_samples);
      } else {
        db.prepare("DELETE FROM dashboard_message_1h WHERE bucket_start=?").run(bucket_start);
        const source = db.prepare(`SELECT message_kind, message_status, compaction_kind, compaction_source_quality, COUNT(*) AS message_count FROM analytics_message_fact
          WHERE created_at>=? AND created_at<? GROUP BY message_kind,message_status,compaction_kind,compaction_source_quality`).all(bucket_start, end) as Array<Record<string, unknown>>;
        const insert = db.prepare("INSERT INTO dashboard_message_1h VALUES (?, ?, ?, ?, ?, ?)");
        for (const row of source) insert.run(bucket_start, row.message_kind, row.message_status, row.compaction_kind, row.compaction_source_quality, row.message_count);
      }
      db.prepare("INSERT INTO analytics_rollup_hour(domain,bucket_start,rebuilt_at) VALUES(?,?,?) ON CONFLICT(domain,bucket_start) DO UPDATE SET rebuilt_at=excluded.rebuilt_at").run(domain, bucket_start, now);
      db.prepare("DELETE FROM analytics_dirty_hour WHERE domain=? AND bucket_start=?").run(domain, bucket_start);
      advanceReadyThrough(db, domain, bucket_start, now);
    }
  })();
  return rows.length;
}

const COLLECTED_SOURCES: Array<[string, string]> = [
  ["run", "analytics_run_fact"], ["session", "analytics_session_fact"], ["message", "analytics_message_fact"], ["tool", "analytics_tool_fact"],
  ["execution", "analytics_execution_fact"], ["model", "analytics_model_call_fact"], ["worker", "analytics_worker_event_fact"]
];
const COLLECTED_DOMAINS = COLLECTED_SOURCES.map(([domain]) => domain);

/** Exact replacement of collected-at buckets, including explicit zero rows. */
export function rebuildCollectedRollup(db: AnalyticsDb, from: number, to: number, now = Date.now()) {
  const start = utcHourStart(from); const end = utcHourStart(to);
  if (end <= start) return start;
  db.transaction(() => {
    for (const [domain, table] of COLLECTED_SOURCES) {
      db.prepare("DELETE FROM dashboard_collected_1h WHERE domain=? AND bucket_start>=? AND bucket_start<?").run(domain, start, end);
      const rows = db.prepare(`SELECT CAST(collected_at / ? AS INTEGER) * ? AS bucket_start, COUNT(*) AS fact_count FROM ${table}
        WHERE collected_at>=? AND collected_at<? GROUP BY bucket_start`).all(HOUR_MS, HOUR_MS, start, end) as Array<{ bucket_start: number; fact_count: number }>;
      const insert = db.prepare("INSERT INTO dashboard_collected_1h(bucket_start,domain,fact_count) VALUES(?,?,?)");
      for (const row of rows) insert.run(row.bucket_start, domain, row.fact_count);
    }
    // A completed collected-at hour is represented by all seven domains,
    // including zero-valued dimensions. This lets readers distinguish a
    // certified zero from a cache hole without guessing from missing rows.
    const zero = db.prepare(`INSERT INTO dashboard_collected_1h(bucket_start,domain,fact_count)
      VALUES(?,?,0) ON CONFLICT(bucket_start,domain) DO NOTHING`);
    for (let bucket = start; bucket < end; bucket += HOUR_MS) {
      for (const domain of COLLECTED_DOMAINS) zero.run(bucket, domain);
    }
    db.prepare(`INSERT INTO analytics_maintenance_state(task_name,last_started_at,last_succeeded_at,last_error_code,updated_at)
      VALUES('collected_rollup',?,?,NULL,?) ON CONFLICT(task_name) DO UPDATE SET last_started_at=excluded.last_started_at,last_succeeded_at=excluded.last_succeeded_at,last_error_code=NULL,updated_at=excluded.updated_at`).run(now, end, now);
  })();
  return end;
}
