import type {
  AnalyticsComparisonResult,
  AnalyticsDomain,
  DashboardData,
  DashboardQueryErrorResponse,
  DashboardQueryRequest,
  DashboardQuerySuccessResponse,
  MetricResult,
  PanelResult,
} from "@agent-workbench/shared";
import { randomUUID } from "node:crypto";
import type { AnalyticsDb, AnalyticsDomainState } from "./analytics-db.js";
import { buildEmptyDashboardResponse } from "./analytics-empty-dashboard.js";
import {
  HOUR_MS,
  planUtcHourSources,
  type RollupDomain,
} from "./analytics-rollups.js";
import {
  planDisplayBuckets,
  type DisplayBucket,
} from "./analytics-display-buckets.js";

const FACT_DOMAINS = [
  "run",
  "session",
  "message",
  "tool",
  "execution",
  "model",
  "worker",
  "git",
] as const;
const comparisonUnavailable = {
  status: "domain_unavailable",
  delta: null,
  kind: null,
} as const satisfies AnalyticsComparisonResult;
const comparisonNotApplicable = {
  status: "not_applicable",
  delta: null,
  kind: null,
} as const satisfies AnalyticsComparisonResult;

type StateMap = Map<AnalyticsDomain, AnalyticsDomainState>;
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type DashboardBuilder = Mutable<DashboardData>;
type ComparisonAggregate =
  | { kind: "count" | "total"; value: number }
  | { kind: "ratio"; numerator: number; denominator: number }
  | { kind: "average"; sum: number; samples: number };
const comparisonAggregates = new WeakMap<object, ComparisonAggregate>();
function aggregate<T extends object>(result: T, value: ComparisonAggregate): T {
  comparisonAggregates.set(result, value);
  return result;
}

type Completeness = {
  complete: boolean;
  reason:
    | "coverage_gap"
    | "range_not_reconciled"
    | "collector_degraded"
    | "signal_loss"
    | "open_fact";
  unavailable: boolean;
  unavailableReason?: "domain_disabled" | "domain_unavailable";
};

function stateMap(db: AnalyticsDb): StateMap {
  const rows = db
    .prepare(
      `SELECT domain, status, collection_started_at AS collectionStartedAt, reconciled_through AS reconciledThrough,
    rollup_ready_through AS rollupReadyThrough, retention_floor AS retentionFloor, last_succeeded_at AS lastSucceededAt,
    last_error_code AS lastErrorCode FROM analytics_domain_state`,
    )
    .all() as AnalyticsDomainState[];
  return new Map(rows.map((row) => [row.domain as AnalyticsDomain, row]));
}

type DomainConfig = {
  collection_config_version: string;
  effective_at: number;
  enabled_fact_domains_json: string;
};

/** Config toggles are prospective: only Domains enabled in each range segment need certification. */
function monitoringCompleteness(
  db: AnalyticsDb,
  states: StateMap,
  from: number,
  to: number,
  asOf: number,
) {
  const configs = db
    .prepare(
      `SELECT collection_config_version, effective_at, enabled_fact_domains_json FROM analytics_domain_config_version
    WHERE effective_at <= ? ORDER BY effective_at, CAST(collection_config_version AS INTEGER)`,
    )
    .all(Math.max(to, asOf)) as DomainConfig[];
  let active = configs.filter((config) => config.effective_at <= from).at(-1);
  let cursor = from;
  let assessment: Completeness = {
    complete: true,
    unavailable: false,
    reason: "range_not_reconciled",
  };
  const required = new Set<AnalyticsDomain>();
  for (const config of configs.filter(
    (config) => config.effective_at > from && config.effective_at < to,
  )) {
    if (active && cursor < config.effective_at) {
      const domains = JSON.parse(
        active.enabled_fact_domains_json,
      ) as AnalyticsDomain[];
      domains.forEach((domain) => required.add(domain));
      const segment = completeness(
        db,
        states,
        domains,
        cursor,
        config.effective_at,
      );
      if (!segment.complete) assessment = segment;
    }
    active = config;
    cursor = config.effective_at;
  }
  if (active && cursor < to) {
    const domains = JSON.parse(
      active.enabled_fact_domains_json,
    ) as AnalyticsDomain[];
    domains.forEach((domain) => required.add(domain));
    const segment = completeness(db, states, domains, cursor, to);
    if (!segment.complete) assessment = segment;
  }
  const asOfConfig = configs
    .filter((config) => config.effective_at <= asOf)
    .at(-1);
  return {
    assessment,
    requiredDomains: [...required],
    asOfConfig,
    changedWithinRange: configs.some(
      (config) => config.effective_at >= from && config.effective_at < to,
    ),
  };
}

function completeness(
  db: AnalyticsDb,
  states: StateMap,
  domains: AnalyticsDomain[],
  from: number,
  to: number,
): Completeness {
  for (const domain of domains) {
    const state = states.get(domain);
    // A later disable is only an as-of diagnostic. It must not erase the
    // retained coverage of an earlier enabled configuration segment.
    if (
      !state ||
      // Re-enabling deliberately makes the current state unavailable until
      // the new segment is certified.  The prior segment remains certified
      // when its retained success and reconciliation waterlines cover it.
      // Domain state is a current diagnostic, not a rewrite of history.
      (state.status === "unavailable" &&
        (state.lastSucceededAt === null ||
          state.lastSucceededAt < to ||
          state.reconciledThrough === null ||
          state.reconciledThrough < to)) ||
      state.collectionStartedAt === null
    ) {
      return {
        complete: false,
        unavailable: true,
        reason: "collector_degraded",
        unavailableReason:
          state?.status === "disabled"
            ? "domain_disabled"
            : "domain_unavailable",
      };
    }
    if (state.retentionFloor !== null && from < state.retentionFloor)
      return {
        complete: false,
        unavailable: true,
        reason: "range_not_reconciled",
      };
    if (state.status === "stale" || state.status === "degraded")
      return {
        complete: false,
        unavailable: false,
        reason:
          state.status === "stale"
            ? "collector_degraded"
            : "collector_degraded",
      };
    if (
      state.reconciledThrough === null ||
      state.reconciledThrough < to ||
      state.collectionStartedAt > from
    )
      return {
        complete: false,
        unavailable: false,
        reason: "range_not_reconciled",
      };
    const gap = db
      .prepare(
        `SELECT 1 FROM analytics_signal_coverage_gap WHERE domain = ? AND ? > gap_from AND (gap_to IS NULL OR ? < gap_to) LIMIT 1`,
      )
      .get(domain, to, from);
    if (gap)
      return { complete: false, unavailable: false, reason: "coverage_gap" };
  }
  return { complete: true, unavailable: false, reason: "range_not_reconciled" };
}

function metric<T>(
  assessment: Completeness,
  domains: AnalyticsDomain[],
  value: T,
  known: boolean,
  comparison?: ComparisonAggregate,
): MetricResult<T> {
  if (assessment.complete)
    return comparison
      ? aggregate(
          {
            status: "available",
            value,
            completeness: "complete",
            dataIncomplete: false,
            requiredDomains: domains,
            comparison: comparisonNotApplicable,
          },
          comparison,
        )
      : {
          status: "available",
          value,
          completeness: "complete",
          dataIncomplete: false,
          requiredDomains: domains,
          comparison: comparisonNotApplicable,
        };
  if (known)
    return comparison
      ? aggregate(
          {
            status: "partial",
            value,
            completeness: "partial",
            dataIncomplete: true,
            partialReason: assessment.reason,
            requiredDomains: domains,
            comparison: comparisonUnavailable,
          },
          comparison,
        )
      : {
          status: "partial",
          value,
          completeness: "partial",
          dataIncomplete: true,
          partialReason: assessment.reason,
          requiredDomains: domains,
          comparison: comparisonUnavailable,
        };
  return {
    status: "unavailable",
    value: null,
    dataIncomplete: true,
    unavailableReason:
      assessment.unavailableReason ??
      (assessment.unavailable ? "domain_unavailable" : "no_safe_data"),
    requiredDomains: domains,
    comparison: comparisonUnavailable,
  };
}
function panel<T>(
  assessment: Completeness,
  domains: AnalyticsDomain[],
  data: T,
  known: boolean,
  comparison?: ComparisonAggregate,
): PanelResult<T> {
  if (assessment.complete)
    return comparison
      ? aggregate(
          {
            status: "available",
            data,
            completeness: "complete",
            dataIncomplete: false,
            requiredDomains: domains,
            comparison: comparisonNotApplicable,
          },
          comparison,
        )
      : {
          status: "available",
          data,
          completeness: "complete",
          dataIncomplete: false,
          requiredDomains: domains,
          comparison: comparisonNotApplicable,
        };
  if (known)
    return comparison
      ? aggregate(
          {
            status: "partial",
            data,
            completeness: "partial",
            dataIncomplete: true,
            partialReason: assessment.reason,
            requiredDomains: domains,
            comparison: comparisonUnavailable,
          },
          comparison,
        )
      : {
          status: "partial",
          data,
          completeness: "partial",
          dataIncomplete: true,
          partialReason: assessment.reason,
          requiredDomains: domains,
          comparison: comparisonUnavailable,
        };
  return {
    status: "unavailable",
    data: null,
    dataIncomplete: true,
    unavailableReason:
      assessment.unavailableReason ??
      (assessment.unavailable ? "domain_unavailable" : "no_safe_data"),
    requiredDomains: domains,
    comparison: comparisonUnavailable,
  };
}

function count(
  db: AnalyticsDb,
  table: string,
  field: string,
  from: number,
  to: number,
  suffix = "",
) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${field} >= ? AND ${field} < ? ${suffix}`,
      )
      .get(from, to) as { count: number }
  ).count;
}
function countTrend(
  db: AnalyticsDb,
  table: string,
  field: string,
  buckets: readonly DisplayBucket[],
  suffix = "",
) {
  const statement = db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${field} >= ? AND ${field} < ? ${suffix}`,
  );
  return buckets.map((bucket) => ({
    ...bucket,
    count: (statement.get(bucket.from, bucket.to) as { count: number }).count,
  }));
}

type ExtendedMetricResult<T, Extra extends object> =
  | (Extract<MetricResult<T>, { status: "available" }> & Extra)
  | (Extract<MetricResult<T>, { status: "partial" }> & Extra)
  | (Extract<MetricResult<T>, { status: "unavailable" }> & Extra);

function extendMetricResult<T, Extra extends object>(
  result: MetricResult<T>,
  extra: Extra,
): ExtendedMetricResult<T, Extra> {
  return { ...result, ...extra } as ExtendedMetricResult<T, Extra>;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : numerator / denominator;
}

function sumOrNull(value: number | null, sampleCount: number) {
  return sampleCount === 0 ? null : (value ?? 0);
}

function hourlySourcePlan(
  db: AnalyticsDb,
  states: StateMap,
  domain: RollupDomain,
  from: number,
  to: number,
  state: AnalyticsDomainState | undefined,
) {
  const dirtyHours = new Set(
    (
      db
        .prepare(
          "SELECT bucket_start FROM analytics_dirty_hour WHERE domain=? AND bucket_start>=? AND bucket_start<?",
        )
        .all(domain, Math.floor(from / HOUR_MS) * HOUR_MS, to) as Array<{
        bucket_start: number;
      }>
    ).map((row) => row.bucket_start),
  );
  const rebuiltHours = new Set(
    (
      db
        .prepare(
          "SELECT bucket_start FROM analytics_rollup_hour WHERE domain=? AND bucket_start>=? AND bucket_start<?",
        )
        .all(domain, Math.floor(from / HOUR_MS) * HOUR_MS, to) as Array<{
        bucket_start: number;
      }>
    ).map((row) => row.bucket_start),
  );
  return planUtcHourSources({
    domain,
    from,
    to,
    rollupReadyThrough: state?.rollupReadyThrough ?? null,
    dirtyHours,
    rebuiltHours,
    // A whole-range certification cannot certify a particular cached hour.
    coverageEstablished: (hourFrom, hourTo) =>
      completeness(db, states, [domain], hourFrom, hourTo).complete,
  });
}

function rollupCountTrend(
  db: AnalyticsDb,
  states: StateMap,
  domain: RollupDomain,
  state: AnalyticsDomainState | undefined,
  buckets: readonly DisplayBucket[],
  table: string,
  field: string,
  factSuffix: string,
  rollupTable: string,
  rollupCountField: "call_count" | "message_count",
  rollupSuffix: string,
) {
  const fact = db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${field}>=? AND ${field}<? ${factSuffix}`,
  );
  const rollup = db.prepare(
    `SELECT COALESCE(SUM(${rollupCountField}), 0) AS count FROM ${rollupTable} WHERE bucket_start=? ${rollupSuffix}`,
  );
  return buckets.map((bucket) => {
    let count = 0;
    for (const hour of hourlySourcePlan(
      db,
      states,
      domain,
      bucket.from,
      bucket.to,
      state,
    )) {
      count +=
        hour.source === "rollup"
          ? (rollup.get(hour.bucketStart) as { count: number }).count
          : (fact.get(hour.from, hour.to) as { count: number }).count;
    }
    return { ...bucket, count };
  });
}

type ModelHourRow = {
  provider_id: string;
  model_id: string;
  status: string;
  timeout_kind: string | null;
  request_count: number;
  duration_sum: number;
  duration_samples: number;
  input_tokens: number;
  input_reported_count: number;
  output_tokens: number;
  output_reported_count: number;
  total_tokens: number;
  total_reported_count: number;
  total_derived_count: number;
  cache_read_tokens: number;
  cache_comparable_count: number;
  comparable_input_tokens: number;
  comparable_cache_read_tokens: number;
};
function modelRowsForRange(
  db: AnalyticsDb,
  states: StateMap,
  from: number,
  to: number,
  state: AnalyticsDomainState | undefined,
): ModelHourRow[] {
  const fact =
    db.prepare(`SELECT provider_id, model_id, status, timeout_kind, COUNT(*) AS request_count,
    COALESCE(SUM(CASE WHEN status='completed' AND ended_at IS NOT NULL THEN ended_at-started_at ELSE 0 END),0) AS duration_sum, SUM(status='completed' AND ended_at IS NOT NULL) AS duration_samples,
    COALESCE(SUM(input_tokens),0) AS input_tokens, SUM(input_tokens IS NOT NULL) AS input_reported_count, COALESCE(SUM(output_tokens),0) AS output_tokens, SUM(output_tokens IS NOT NULL) AS output_reported_count,
    COALESCE(SUM(total_tokens),0) AS total_tokens, SUM(total_source='reported') AS total_reported_count, SUM(total_source='derived') AS total_derived_count,
    COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, SUM(cache_comparable=1) AS cache_comparable_count,
    COALESCE(SUM(CASE WHEN cache_comparable=1 THEN input_tokens ELSE 0 END),0) AS comparable_input_tokens, COALESCE(SUM(CASE WHEN cache_comparable=1 THEN cache_read_tokens ELSE 0 END),0) AS comparable_cache_read_tokens
    FROM analytics_model_call_fact WHERE started_at>=? AND started_at<? GROUP BY provider_id,model_id,status,timeout_kind`);
  const rollup =
    db.prepare(`SELECT provider_id, model_id, status, timeout_kind, request_count, completed_duration_sum_ms AS duration_sum, completed_duration_sample_count AS duration_samples,
    input_tokens,input_reported_count,output_tokens,output_reported_count,total_tokens,total_reported_count,total_derived_count,cache_read_tokens,cache_comparable_count,comparable_input_tokens,comparable_cache_read_tokens
    FROM dashboard_model_dimension_1h WHERE bucket_start=?`);
  const rows: ModelHourRow[] = [];
  for (const hour of hourlySourcePlan(db, states, "model", from, to, state)) {
    rows.push(
      ...((hour.source === "rollup"
        ? rollup.all(hour.bucketStart)
        : fact.all(hour.from, hour.to)) as ModelHourRow[]),
    );
  }
  return rows;
}

type ToolHourRow = {
  tool_name: string | null;
  status: string;
  call_count: number;
  duration_sum: number;
  duration_samples: number;
};
function toolRowsForRange(
  db: AnalyticsDb,
  states: StateMap,
  from: number,
  to: number,
  state: AnalyticsDomainState | undefined,
): ToolHourRow[] {
  const fact = db.prepare(
    `SELECT tool_name,status,COUNT(*) AS call_count,COALESCE(SUM(completed_duration_ms),0) AS duration_sum,SUM(completed_duration_ms IS NOT NULL) AS duration_samples FROM analytics_tool_fact WHERE created_at>=? AND created_at<? GROUP BY tool_name,status`,
  );
  const rollup = db.prepare(
    "SELECT tool_name,status,call_count,completed_duration_sum_ms AS duration_sum,completed_duration_sample_count AS duration_samples FROM dashboard_tool_1h WHERE bucket_start=?",
  );
  const rows: ToolHourRow[] = [];
  for (const hour of hourlySourcePlan(db, states, "tool", from, to, state))
    rows.push(
      ...((hour.source === "rollup"
        ? rollup.all(hour.bucketStart)
        : fact.all(hour.from, hour.to)) as ToolHourRow[]),
    );
  return rows;
}

type MessageHourRow = {
  message_kind: "user" | "assistant" | "runtime" | "system" | "compaction";
  message_status: string;
  compaction_kind: "manual" | "auto" | null;
  compaction_source_quality: "known" | "unknown" | "not_applicable";
  message_count: number;
};
function messageRowsForRange(
  db: AnalyticsDb,
  states: StateMap,
  from: number,
  to: number,
  state: AnalyticsDomainState | undefined,
): MessageHourRow[] {
  const fact = db.prepare(
    `SELECT message_kind,message_status,compaction_kind,compaction_source_quality,COUNT(*) AS message_count FROM analytics_message_fact WHERE created_at>=? AND created_at<? GROUP BY message_kind,message_status,compaction_kind,compaction_source_quality`,
  );
  const rollup = db.prepare(
    "SELECT message_kind,message_status,compaction_kind,compaction_source_quality,message_count FROM dashboard_message_1h WHERE bucket_start=?",
  );
  const rows: MessageHourRow[] = [];
  for (const hour of hourlySourcePlan(db, states, "message", from, to, state))
    rows.push(
      ...((hour.source === "rollup"
        ? rollup.all(hour.bucketStart)
        : fact.all(hour.from, hour.to)) as MessageHourRow[]),
    );
  return rows;
}

type CollectedDomain = (typeof FACT_DOMAINS)[number];
type CollectedCounts = Record<CollectedDomain, number>;
const collectedFactTables: ReadonlyArray<readonly [CollectedDomain, string]> = [
  ["run", "analytics_run_fact"],
  ["session", "analytics_session_fact"],
  ["message", "analytics_message_fact"],
  ["tool", "analytics_tool_fact"],
  ["execution", "analytics_execution_fact"],
  ["model", "analytics_model_call_fact"],
  ["worker", "analytics_worker_event_fact"],
  ["git", "analytics_git_commit_fact"],
];

function emptyCollectedCounts(): CollectedCounts {
  return {
    run: 0,
    session: 0,
    message: 0,
    tool: 0,
    execution: 0,
    model: 0,
    worker: 0,
    git: 0,
  };
}

/** Exact Fact fallback for partial/current/missing collected-at hours. */
function collectedFactCounts(
  db: AnalyticsDb,
  from: number,
  to: number,
): CollectedCounts {
  const result = emptyCollectedCounts();
  for (const [domain, table] of collectedFactTables) {
    result[domain] = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE collected_at >= ? AND collected_at < ?`,
        )
        .get(from, to) as { count: number }
    ).count;
  }
  return result;
}

function collectedRollupCounts(
  db: AnalyticsDb,
  bucketStart: number,
): CollectedCounts | null {
  const rows = db
    .prepare(
      `SELECT domain, fact_count FROM dashboard_collected_1h WHERE bucket_start=?`,
    )
    .all(bucketStart) as Array<{ domain: CollectedDomain; fact_count: number }>;
  // All fixed domains must be present. Missing is a cache hole, not a zero.
  if (
    rows.length !== FACT_DOMAINS.length ||
    new Set(rows.map((row) => row.domain)).size !== FACT_DOMAINS.length
  )
    return null;
  const result = emptyCollectedCounts();
  for (const row of rows) result[row.domain] = row.fact_count;
  return result;
}

function addCollected(target: CollectedCounts, source: CollectedCounts) {
  for (const domain of FACT_DOMAINS) target[domain] += source[domain];
}

/**
 * Uses a completed collected rollup only for exact full UTC hours; all other
 * intervals use exact Fact predicates. No hour can enter both paths.
 */
function collectedCountsForRange(
  db: AnalyticsDb,
  from: number,
  to: number,
): CollectedCounts {
  const result = emptyCollectedCounts();
  for (
    let hourStart = Math.floor(from / HOUR_MS) * HOUR_MS;
    hourStart < to;
    hourStart += HOUR_MS
  ) {
    const hourEnd = hourStart + HOUR_MS;
    const segmentFrom = Math.max(from, hourStart);
    const segmentTo = Math.min(to, hourEnd);
    const fullClosed = segmentFrom === hourStart && segmentTo === hourEnd;
    const rollup = fullClosed ? collectedRollupCounts(db, hourStart) : null;
    addCollected(
      result,
      rollup ?? collectedFactCounts(db, segmentFrom, segmentTo),
    );
  }
  return result;
}

/**
 * Child-owned, one-transaction query.  It starts with the contract-valid empty
 * response and replaces only independently provable resources; this prevents a
 * newly added card from accidentally turning unknown zero into a complete zero.
 */

type GitPartialReason =
  | "repo_not_ready"
  | "range_before_coverage"
  | "scan_stale"
  | "mixed_repo_coverage";
type GitCoverage = {
  ready: number;
  total: number;
  partialReason: GitPartialReason | null;
};
type GitStateRow = {
  repo_id: string;
  current_scan_id: string | null;
  covered_from: number | null;
  last_ready_at: number | null;
};
type GitRow = {
  committed_at: number;
  parent_count: number;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
};
type GitValues = {
  commits: number;
  nonMergeCommits: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
};

function gitCoverage(db: AnalyticsDb, from: number, now: number): GitCoverage {
  const rows = db
    .prepare(
      `SELECT repo_id,current_scan_id,covered_from,last_ready_at FROM analytics_git_repo_state`,
    )
    .all() as GitStateRow[];
  const readyRows = rows.filter(
    (row) => row.current_scan_id !== null && row.covered_from !== null,
  );
  if (readyRows.length === 0)
    return { ready: 0, total: rows.length, partialReason: null };
  const reasons = new Set<Exclude<GitPartialReason, "mixed_repo_coverage">>();
  if (readyRows.length < rows.length) reasons.add("repo_not_ready");
  if (readyRows.some((row) => row.covered_from! > from))
    reasons.add("range_before_coverage");
  if (
    readyRows.some(
      (row) =>
        row.last_ready_at === null || now - row.last_ready_at > 2 * 60 * 60_000,
    )
  )
    reasons.add("scan_stale");
  return {
    ready: readyRows.length,
    total: rows.length,
    partialReason:
      reasons.size === 0
        ? null
        : reasons.size === 1
          ? [...reasons][0]!
          : "mixed_repo_coverage",
  };
}

function currentGitRows(db: AnalyticsDb, from: number, to: number): GitRow[] {
  return db
    .prepare(
      `SELECT f.committed_at,f.parent_count,f.files_changed,f.insertions,f.deletions
    FROM analytics_git_repo_state r
    JOIN analytics_git_membership m ON m.repo_id=r.repo_id AND m.scan_id=r.current_scan_id
    JOIN analytics_git_commit_fact f ON f.repo_id=m.repo_id AND f.commit_identity=m.commit_identity
    WHERE f.committed_at>=? AND f.committed_at<?`,
    )
    .all(from, to) as GitRow[];
}

function gitValues(rows: readonly GitRow[]): GitValues {
  return {
    commits: rows.length,
    nonMergeCommits: rows.filter((row) => row.parent_count <= 1).length,
    filesChanged: rows.reduce(
      (total, row) => total + (row.files_changed ?? 0),
      0,
    ),
    linesAdded: rows.reduce((total, row) => total + (row.insertions ?? 0), 0),
    linesDeleted: rows.reduce((total, row) => total + (row.deletions ?? 0), 0),
  };
}

function applyGitDashboard(
  db: AnalyticsDb,
  data: DashboardBuilder,
  from: number,
  to: number,
  buckets: readonly DisplayBucket[],
  now: number,
  timezone = "UTC",
) {
  const coverage = gitCoverage(db, from, now);
  const base = {
    requiredDomains: ["git"] as AnalyticsDomain[],
    comparison: comparisonUnavailable,
    readyRepoCount: coverage.ready,
    totalRepoCount: coverage.total,
  };
  const unavailable = coverage.ready === 0;
  const rows = unavailable ? [] : currentGitRows(db, from, to);
  const values = gitValues(rows);
  const metric = (value: number) => {
    if (unavailable)
      return {
        status: "unavailable",
        value: null,
        dataIncomplete: true,
        unavailableReason: "no_ready_repo",
        ...base,
      };
    if (coverage.partialReason)
      return {
        status: "partial",
        value,
        completeness: "partial",
        dataIncomplete: true,
        partialReason: coverage.partialReason,
        ...base,
      };
    return {
      status: "available",
      value,
      completeness: "complete",
      dataIncomplete: false,
      ...base,
    };
  };
  const trend = (key: keyof GitValues) => {
    const points = buckets.map((bucket) => ({
      from: bucket.from,
      to: bucket.to,
      count: gitValues(
        rows.filter(
          (row) =>
            row.committed_at >= bucket.from && row.committed_at < bucket.to,
        ),
      )[key],
    }));
    if (unavailable)
      return {
        status: "unavailable",
        data: null,
        dataIncomplete: true,
        unavailableReason: "no_ready_repo",
        ...base,
      };
    if (coverage.partialReason)
      return {
        status: "partial",
        data: points,
        completeness: "partial",
        dataIncomplete: true,
        partialReason: coverage.partialReason,
        ...base,
      };
    return {
      status: "available",
      data: points,
      completeness: "complete",
      dataIncomplete: false,
      ...base,
    };
  };

  data.overview.gitCommits = metric(values.commits) as never;
  data.overviewTrends.gitCommits = trend("commits") as never;
  data.git.metrics = {
    commits: metric(values.commits) as never,
    nonMergeCommits: metric(values.nonMergeCommits) as never,
    filesChanged: metric(values.filesChanged) as never,
    linesAdded: metric(values.linesAdded) as never,
    linesDeleted: metric(values.linesDeleted) as never,
  };
  data.git.trends = {
    commits: trend("commits") as never,
    nonMergeCommits: trend("nonMergeCommits") as never,
    filesChanged: trend("filesChanged") as never,
    linesAdded: trend("linesAdded") as never,
    linesDeleted: trend("linesDeleted") as never,
  };

  // The heatmap has independent coverage. The early start guarantees that the
  // trailing 180 buckets are local calendar days even across DST transitions.
  const heatBuckets = planDisplayBuckets({
    from: now - 183 * 24 * HOUR_MS,
    to: now,
    timezone,
    rangeKind: "preset_90d",
  }).slice(-180);
  const heatFrom = heatBuckets[0]?.from ?? now;
  const heatCoverage = gitCoverage(db, heatFrom, now);
  const heatBase = {
    requiredDomains: ["git"] as AnalyticsDomain[],
    comparison: comparisonNotApplicable,
    readyRepoCount: heatCoverage.ready,
    totalRepoCount: heatCoverage.total,
  };
  const heatRows =
    heatCoverage.ready === 0 ? [] : currentGitRows(db, heatFrom, now);
  const days = heatBuckets.map((bucket) => ({
    from: bucket.from,
    to: bucket.to,
    commits: heatRows.filter(
      (row) => row.committed_at >= bucket.from && row.committed_at < bucket.to,
    ).length,
  }));
  data.exceptions.gitHeatmap180d = (
    heatCoverage.ready === 0
      ? {
          status: "unavailable",
          data: null,
          dataIncomplete: true,
          unavailableReason: "no_ready_repo",
          ...heatBase,
          from: heatFrom,
          to: now,
          asOf: now,
        }
      : heatCoverage.partialReason
        ? {
            status: "partial",
            data: { days },
            completeness: "partial",
            dataIncomplete: true,
            partialReason: heatCoverage.partialReason,
            ...heatBase,
            from: heatFrom,
            to: now,
            asOf: now,
          }
        : {
            status: "available",
            data: { days },
            completeness: "complete",
            dataIncomplete: false,
            ...heatBase,
            from: heatFrom,
            to: now,
            asOf: now,
          }
  ) as never;
}

function queryDashboardSnapshot(
  db: AnalyticsDb,
  request: DashboardQueryRequest,
  now = Date.now(),
): DashboardQuerySuccessResponse | DashboardQueryErrorResponse {
  const states = stateMap(db);
  const initial = buildEmptyDashboardResponse({
    request,
    asOf: now,
    states: [...states.values()],
  });
  if (initial.kind === "error") return initial;
  const data: DashboardBuilder = structuredClone(
    initial.data,
  ) as DashboardBuilder;
  const { from, to } = initial;
  const buckets = planDisplayBuckets({
    from,
    to,
    timezone: initial.timezone,
    rangeKind: request.rangeKind,
  });
  applyGitDashboard(db, data, from, to, buckets, now, initial.timezone);
  const run = completeness(db, states, ["run"], from, to);
  const message = completeness(db, states, ["message"], from, to);
  const tool = completeness(db, states, ["tool"], from, to);
  const model = completeness(db, states, ["model"], from, to);
  const execution = completeness(
    db,
    states,
    ["agent_duration", "execution"],
    from,
    to,
  );
  const worker = completeness(db, states, ["worker"], from, to);

  const runCount = count(db, "analytics_run_fact", "created_at", from, to);
  const primary = count(
    db,
    "analytics_run_fact",
    "created_at",
    from,
    to,
    "AND run_kind='user' AND parent_run_id IS NULL",
  );
  const subtask = count(
    db,
    "analytics_run_fact",
    "created_at",
    from,
    to,
    "AND run_kind='subtask'",
  );
  data.overview.agentDuration = metric(
    execution,
    ["agent_duration", "execution"],
    0,
    false,
  );
  data.agent.metrics.runCount = metric(run, ["run"], runCount, runCount > 0);
  data.agent.metrics.primaryRunCount = metric(
    run,
    ["run"],
    primary,
    primary > 0,
  );
  data.agent.metrics.subtaskRunCount = metric(
    run,
    ["run"],
    subtask,
    subtask > 0,
  );
  data.agent.trends.runCount = panel(
    run,
    ["run"],
    countTrend(db, "analytics_run_fact", "created_at", buckets),
    runCount > 0,
  );
  data.agent.trends.primaryRunCount = panel(
    run,
    ["run"],
    countTrend(
      db,
      "analytics_run_fact",
      "created_at",
      buckets,
      "AND run_kind='user' AND parent_run_id IS NULL",
    ),
    primary > 0,
  );
  data.agent.trends.subtaskRunCount = panel(
    run,
    ["run"],
    countTrend(
      db,
      "analytics_run_fact",
      "created_at",
      buckets,
      "AND run_kind='subtask'",
    ),
    subtask > 0,
  );

  const messageRows = messageRowsForRange(
    db,
    states,
    from,
    to,
    states.get("message"),
  );
  const messageCount = (
    kind: MessageHourRow["message_kind"],
    rows = messageRows,
  ) =>
    rows
      .filter((row) => row.message_kind === kind)
      .reduce((total, row) => total + row.message_count, 0);
  const messageTrend = (kind: MessageHourRow["message_kind"]) =>
    buckets.map((bucket) => ({
      ...bucket,
      count: messageRowsForRange(
        db,
        states,
        bucket.from,
        bucket.to,
        states.get("message"),
      )
        .filter((row) => row.message_kind === kind)
        .reduce((total, row) => total + row.message_count, 0),
    }));
  const user = messageCount("user");
  const assistant = messageCount("assistant");
  data.agent.metrics.userMessageCount = metric(
    message,
    ["message"],
    user,
    user > 0,
  );
  data.agent.metrics.assistantMessageCount = metric(
    message,
    ["message"],
    assistant,
    assistant > 0,
  );
  data.agent.trends.userMessageCount = panel(
    message,
    ["message"],
    messageTrend("user"),
    user > 0,
  );
  data.agent.trends.assistantMessageCount = panel(
    message,
    ["message"],
    messageTrend("assistant"),
    assistant > 0,
  );

  const toolRows = toolRowsForRange(db, states, from, to, states.get("tool"));
  const toolCalls = toolRows.reduce((total, row) => total + row.call_count, 0);
  const toolTerminal = toolRows.reduce(
    (total, row) => ({
      completed:
        total.completed + (row.status === "completed" ? row.call_count : 0),
      failed: total.failed + (row.status === "failed" ? row.call_count : 0),
    }),
    { completed: 0, failed: 0 },
  );
  const toolRate =
    toolTerminal.completed + toolTerminal.failed > 0
      ? toolTerminal.completed / (toolTerminal.completed + toolTerminal.failed)
      : null;
  data.agent.metrics.toolCallCount = metric(
    tool,
    ["tool"],
    toolCalls,
    toolCalls > 0,
  );
  data.agent.metrics.toolSuccessRate = metric(
    tool,
    ["tool"],
    { ratio: toolRate },
    toolCalls > 0,
    {
      kind: "ratio",
      numerator: toolTerminal.completed,
      denominator: toolTerminal.completed + toolTerminal.failed,
    },
  );
  data.agent.trends.toolCallCount = panel(
    tool,
    ["tool"],
    rollupCountTrend(
      db,
      states,
      "tool",
      states.get("tool"),
      buckets,
      "analytics_tool_fact",
      "created_at",
      "",
      "dashboard_tool_1h",
      "call_count",
      "",
    ),
    toolCalls > 0,
  );
  const toolBuckets = buckets.map(() => ({ completed: 0, failed: 0 }));
  for (const [index, bucket] of buckets.entries())
    for (const fact of toolRowsForRange(
      db,
      states,
      bucket.from,
      bucket.to,
      states.get("tool"),
    )) {
      if (fact.status === "completed")
        toolBuckets[index]!.completed += fact.call_count;
      if (fact.status === "failed")
        toolBuckets[index]!.failed += fact.call_count;
    }
  data.agent.trends.toolSuccessRate = panel(
    tool,
    ["tool"],
    buckets.map((bucket, index) => {
      const row = toolBuckets[index]!;
      return {
        ...bucket,
        ratio: ratio(row.completed, row.completed + row.failed),
      };
    }),
    toolCalls > 0,
    {
      kind: "ratio",
      numerator: toolTerminal.completed,
      denominator: toolTerminal.completed + toolTerminal.failed,
    },
  );

  const toolDistributionRows = toolRows
    .filter((row) =>
      ["completed", "failed", "cancelled", "unknown"].includes(row.status),
    )
    .map((row) => ({
      status: row.status as "completed" | "failed" | "cancelled" | "unknown",
      count: row.call_count,
    }));
  data.agent.toolStatusDistribution = panel(
    tool,
    ["tool"],
    toolDistributionRows,
    toolCalls > 0,
  );
  const unnamedTools = toolRows
    .filter((row) => row.tool_name === null)
    .reduce((total, row) => total + row.call_count, 0);
  const toolDetailAssessment =
    unnamedTools > 0 && tool.complete
      ? {
          ...tool,
          complete: false,
          unavailable: false,
          reason: "collector_degraded" as const,
        }
      : tool;
  const toolDetailMap = new Map<
    string | null,
    {
      toolName: string | null;
      calls: number;
      completed: number;
      failed: number;
      cancelled: number;
      unknown: number;
      durationSum: number;
      durationSamples: number;
    }
  >();
  for (const row of toolRows) {
    const prior = toolDetailMap.get(row.tool_name) ?? {
      toolName: row.tool_name,
      calls: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0,
      durationSum: 0,
      durationSamples: 0,
    };
    prior.calls += row.call_count;
    if (row.status === "completed") {
      prior.completed += row.call_count;
      prior.durationSum += row.duration_sum;
      prior.durationSamples += row.duration_samples;
    } else if (row.status === "failed") prior.failed += row.call_count;
    else if (row.status === "cancelled") prior.cancelled += row.call_count;
    else if (row.status === "unknown") prior.unknown += row.call_count;
    toolDetailMap.set(row.tool_name, prior);
  }
  const toolDetails = [...toolDetailMap.values()]
    .filter(
      (row): row is typeof row & { toolName: string } => row.toolName !== null,
    )
    .map(({ durationSum, durationSamples, ...row }) => ({
      ...row,
      completedAverageDurationMs: durationSamples
        ? Math.floor(durationSum / durationSamples)
        : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));
  data.agent.toolDetails = panel(
    toolDetailAssessment,
    ["tool"],
    toolDetails,
    toolCalls > 0,
  );

  const modelRows = modelRowsForRange(
    db,
    states,
    from,
    to,
    states.get("model"),
  );
  const modelCounts = modelRows.reduce(
    (result, row) => ({
      total: result.total + row.request_count,
      completed:
        result.completed + (row.status === "completed" ? row.request_count : 0),
      timed_out:
        result.timed_out + (row.status === "timed_out" ? row.request_count : 0),
    }),
    { total: 0, completed: 0, timed_out: 0 },
  );
  const requests = modelCounts.total;
  data.overview.modelRequests = metric(
    model,
    ["model"],
    requests,
    requests > 0,
  );
  data.model.metrics.requestCount = metric(
    model,
    ["model"],
    requests,
    requests > 0,
  );
  type ModelBucketStats = {
    completed: number;
    failed: number;
    timedOut: number;
    other: number;
    durationSum: number;
    durationSamples: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    comparable: number;
    inputCount: number;
    outputCount: number;
    comparableInput: number;
  };
  const modelBucketStats: ModelBucketStats[] = buckets.map(() => ({
    completed: 0,
    failed: 0,
    timedOut: 0,
    other: 0,
    durationSum: 0,
    durationSamples: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    comparable: 0,
    inputCount: 0,
    outputCount: 0,
    comparableInput: 0,
  }));
  for (const [index, bucket] of buckets.entries())
    for (const fact of modelRowsForRange(
      db,
      states,
      bucket.from,
      bucket.to,
      states.get("model"),
    )) {
      const row = modelBucketStats[index]!;
      if (fact.status === "completed") row.completed += fact.request_count;
      else if (fact.status === "failed") row.failed += fact.request_count;
      else if (fact.status === "timed_out") row.timedOut += fact.request_count;
      else row.other += fact.request_count;
      row.durationSum += fact.duration_sum;
      row.durationSamples += fact.duration_samples;
      row.inputTokens += fact.input_tokens;
      row.inputCount += fact.input_reported_count;
      row.outputTokens += fact.output_tokens;
      row.outputCount += fact.output_reported_count;
      row.comparable += fact.cache_comparable_count;
      row.comparableInput += fact.comparable_input_tokens;
      row.cacheReadTokens += fact.comparable_cache_read_tokens;
    }
  data.model.trends.requests = panel(
    model,
    ["model"],
    buckets.map((bucket, index) => {
      const row = modelBucketStats[index]!;
      return {
        ...bucket,
        completed: row.completed,
        failed: row.failed,
        timedOut: row.timedOut,
        other: row.other,
      };
    }),
    requests > 0,
  );

  const modelAggregate = modelRows.reduce<Record<string, number>>(
    (total, row) => ({
      ...total,
      completed:
        total.completed + (row.status === "completed" ? row.request_count : 0),
      failed: total.failed + (row.status === "failed" ? row.request_count : 0),
      timedOut:
        total.timedOut + (row.status === "timed_out" ? row.request_count : 0),
      idleTimeouts:
        total.idleTimeouts +
        (row.timeout_kind === "idle" ? row.request_count : 0),
      totalTimeouts:
        total.totalTimeouts +
        (row.timeout_kind === "total" ? row.request_count : 0),
      durationSum: total.durationSum + row.duration_sum,
      durationSamples: total.durationSamples + row.duration_samples,
      inputTokens: total.inputTokens + row.input_tokens,
      outputTokens: total.outputTokens + row.output_tokens,
      totalTokens: total.totalTokens + row.total_tokens,
      cacheReadTokens: total.cacheReadTokens + row.cache_read_tokens,
      inputReportedCount: total.inputReportedCount + row.input_reported_count,
      outputReportedCount:
        total.outputReportedCount + row.output_reported_count,
      totalReportedCount: total.totalReportedCount + row.total_reported_count,
      totalDerivedCount: total.totalDerivedCount + row.total_derived_count,
      cacheComparableCount:
        total.cacheComparableCount + row.cache_comparable_count,
      comparableInputTokens:
        total.comparableInputTokens + row.comparable_input_tokens,
      comparableCacheReadTokens:
        total.comparableCacheReadTokens + row.comparable_cache_read_tokens,
    }),
    {
      completed: 0,
      failed: 0,
      timedOut: 0,
      idleTimeouts: 0,
      totalTimeouts: 0,
      durationSum: 0,
      durationSamples: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      inputReportedCount: 0,
      outputReportedCount: 0,
      totalReportedCount: 0,
      totalDerivedCount: 0,
      cacheComparableCount: 0,
      comparableInputTokens: 0,
      comparableCacheReadTokens: 0,
    },
  );
  const completed = modelAggregate.completed ?? 0;
  const failed = modelAggregate.failed ?? 0;
  const timedOut = modelAggregate.timedOut ?? 0;
  const terminal = completed + failed + timedOut;
  const inputCount = modelAggregate.inputReportedCount ?? 0;
  const outputCount = modelAggregate.outputReportedCount ?? 0;
  const totalReported = modelAggregate.totalReportedCount ?? 0;
  const totalDerived = modelAggregate.totalDerivedCount ?? 0;
  const comparable = modelAggregate.cacheComparableCount ?? 0;
  const durationSamples = modelAggregate.durationSamples ?? 0;
  const modelKnown = requests > 0;
  const modelMetric = <T>(
    value: T,
    comparison?: ComparisonAggregate,
  ): MetricResult<T> => metric(model, ["model"], value, modelKnown, comparison);
  data.model.metrics.successRate = modelMetric(
    { ratio: ratio(completed, terminal) },
    { kind: "ratio", numerator: completed, denominator: terminal },
  );
  data.model.metrics.timeoutRate = modelMetric(
    { ratio: ratio(timedOut, terminal) },
    { kind: "ratio", numerator: timedOut, denominator: terminal },
  );
  data.overview.modelSuccessRate = data.model.metrics.successRate;
  data.model.metrics.timeoutKindBreakdown = modelMetric({
    idle: modelAggregate.idleTimeouts ?? 0,
    total: modelAggregate.totalTimeouts ?? 0,
    none: Math.max(
      0,
      timedOut -
        (modelAggregate.idleTimeouts ?? 0) -
        (modelAggregate.totalTimeouts ?? 0),
    ),
  });
  data.model.metrics.completedAverageDuration = modelMetric(
    {
      durationMs: durationSamples
        ? Math.floor((modelAggregate.durationSum ?? 0) / durationSamples)
        : null,
      reliableSampleCount: durationSamples,
    },
    {
      kind: "average",
      sum: modelAggregate.durationSum ?? 0,
      samples: durationSamples,
    },
  );
  data.model.metrics.inputTokens = modelMetric({
    count: sumOrNull(modelAggregate.inputTokens, inputCount),
  });
  data.model.metrics.outputTokens = modelMetric({
    count: sumOrNull(modelAggregate.outputTokens, outputCount),
  });
  data.model.metrics.totalTokens = modelMetric({
    count: sumOrNull(modelAggregate.totalTokens, totalReported + totalDerived),
  });
  data.model.metrics.cacheReadTokens = modelMetric({
    count: sumOrNull(modelAggregate.cacheReadTokens, comparable),
  });
  data.model.metrics.inputReportedCount = modelMetric(inputCount);
  data.model.metrics.outputReportedCount = modelMetric(outputCount);
  data.model.metrics.totalReportedCount = modelMetric(totalReported);
  data.model.metrics.totalDerivedCount = modelMetric(totalDerived);
  data.model.metrics.cacheComparableCount = modelMetric(comparable);
  data.model.metrics.inputTokenCoverage = modelMetric(
    { ratio: ratio(inputCount, requests) },
    { kind: "ratio", numerator: inputCount, denominator: requests },
  );
  data.model.metrics.outputTokenCoverage = modelMetric(
    { ratio: ratio(outputCount, requests) },
    { kind: "ratio", numerator: outputCount, denominator: requests },
  );
  data.model.metrics.totalTokenCoverage = modelMetric(
    { ratio: ratio(totalReported + totalDerived, requests) },
    {
      kind: "ratio",
      numerator: totalReported + totalDerived,
      denominator: requests,
    },
  );
  data.model.metrics.inputCacheCoverage = modelMetric(
    { ratio: ratio(comparable, requests) },
    { kind: "ratio", numerator: comparable, denominator: requests },
  );
  data.overview.cacheHitRate = modelMetric(
    {
      ratio: ratio(
        modelAggregate.comparableCacheReadTokens ?? 0,
        modelAggregate.comparableInputTokens ?? 0,
      ),
    },
    {
      kind: "ratio",
      numerator: modelAggregate.comparableCacheReadTokens ?? 0,
      denominator: modelAggregate.comparableInputTokens ?? 0,
    },
  );

  const modelRatioTrend = (numerator: "completed" | "timedOut") =>
    buckets.map((bucket, index) => {
      const row = modelBucketStats[index]!;
      const denominator = row.completed + row.failed + row.timedOut;
      return { ...bucket, ratio: ratio(row[numerator], denominator) };
    });
  data.model.trends.successRate = panel(
    model,
    ["model"],
    modelRatioTrend("completed"),
    modelKnown,
    { kind: "ratio", numerator: completed, denominator: terminal },
  );
  data.model.trends.timeoutRate = panel(
    model,
    ["model"],
    modelRatioTrend("timedOut"),
    modelKnown,
    { kind: "ratio", numerator: timedOut, denominator: terminal },
  );
  data.model.trends.completedAverageDuration = panel(
    model,
    ["model"],
    buckets.map((bucket, index) => {
      const row = modelBucketStats[index]!;
      return {
        ...bucket,
        durationMs: row.durationSamples
          ? Math.floor(row.durationSum / row.durationSamples)
          : null,
        reliableSampleCount: row.durationSamples,
      };
    }),
    modelKnown,
    {
      kind: "average",
      sum: modelAggregate.durationSum ?? 0,
      samples: durationSamples,
    },
  );
  data.model.trends.tokens = panel(
    model,
    ["model"],
    buckets.map((bucket, index) => {
      const row = modelBucketStats[index]!;
      return {
        ...bucket,
        inputTokens: sumOrNull(row.inputTokens, row.inputCount),
        outputTokens: sumOrNull(row.outputTokens, row.outputCount),
      };
    }),
    modelKnown,
  );
  data.model.trends.cacheHitRate = panel(
    model,
    ["model"],
    buckets.map((bucket, index) => {
      const row = modelBucketStats[index]!;
      return {
        ...bucket,
        ratio: ratio(row.cacheReadTokens, row.comparableInput),
      };
    }),
    modelKnown,
    {
      kind: "ratio",
      numerator: modelAggregate.comparableCacheReadTokens ?? 0,
      denominator: modelAggregate.comparableInputTokens ?? 0,
    },
  );

  data.overviewTrends.modelRequests = data.model.trends.requests;
  data.overviewTrends.modelSuccessRate = data.model.trends.successRate;
  data.overviewTrends.cacheHitRate = data.model.trends.cacheHitRate;
  const byModel = new Map<
    string,
    ModelHourRow & { terminal: number; completed: number; timedOut: number }
  >();
  for (const row of modelRows) {
    const key = `${row.provider_id}\u0000${row.model_id}`;
    const prior = byModel.get(key);
    byModel.set(
      key,
      prior
        ? {
            ...prior,
            request_count: prior.request_count + row.request_count,
            duration_sum: prior.duration_sum + row.duration_sum,
            duration_samples: prior.duration_samples + row.duration_samples,
            input_tokens: prior.input_tokens + row.input_tokens,
            output_tokens: prior.output_tokens + row.output_tokens,
            total_tokens: prior.total_tokens + row.total_tokens,
            cache_read_tokens: prior.cache_read_tokens + row.cache_read_tokens,
            comparable_input_tokens:
              prior.comparable_input_tokens + row.comparable_input_tokens,
            comparable_cache_read_tokens:
              prior.comparable_cache_read_tokens +
              row.comparable_cache_read_tokens,
            terminal:
              prior.terminal +
              (["completed", "failed", "timed_out"].includes(row.status)
                ? row.request_count
                : 0),
            completed:
              prior.completed +
              (row.status === "completed" ? row.request_count : 0),
            timedOut:
              prior.timedOut +
              (row.status === "timed_out" ? row.request_count : 0),
          }
        : {
            ...row,
            terminal: ["completed", "failed", "timed_out"].includes(row.status)
              ? row.request_count
              : 0,
            completed: row.status === "completed" ? row.request_count : 0,
            timedOut: row.status === "timed_out" ? row.request_count : 0,
          },
    );
  }
  data.model.byModel = panel(
    model,
    ["model"],
    [...byModel.values()]
      .map((row) => ({
        provider: row.provider_id,
        model: row.model_id,
        requests: row.request_count,
        successRate: ratio(row.completed, row.terminal),
        timeoutRate: ratio(row.timedOut, row.terminal),
        completedAverageDurationMs: row.duration_samples
          ? Math.floor(row.duration_sum / row.duration_samples)
          : null,
        reliableDurationSampleCount: row.duration_samples,
        inputTokens: sumOrNull(row.input_tokens, row.input_reported_count),
        outputTokens: sumOrNull(row.output_tokens, row.output_reported_count),
        totalTokens: sumOrNull(
          row.total_tokens,
          row.total_reported_count + row.total_derived_count,
        ),
        cacheReadTokens: sumOrNull(
          row.cache_read_tokens,
          row.cache_comparable_count,
        ),
        cacheHitRate: ratio(
          row.comparable_cache_read_tokens,
          row.comparable_input_tokens,
        ),
      }))
      .sort(
        (a, b) =>
          b.requests - a.requests ||
          a.provider.localeCompare(b.provider) ||
          a.model.localeCompare(b.model),
      ),
    modelKnown,
  ) as typeof data.model.byModel;

  const runDistribution = (scope = "") =>
    db
      .prepare(
        `SELECT display_status AS status, COUNT(*) AS count FROM analytics_run_fact
      WHERE created_at >= ? AND created_at < ? AND display_status != 'running' ${scope} GROUP BY display_status`,
      )
      .all(from, to) as Array<{
      status: "completed" | "failed" | "cancelled" | "unknown";
      count: number;
    }>;
  data.agent.runTerminalDistribution = panel(
    run,
    ["run"],
    {
      all: runDistribution(),
      main: runDistribution("AND run_kind = 'user' AND parent_run_id IS NULL"),
      subtask: runDistribution("AND run_kind = 'subtask'"),
    },
    runCount > 0,
  ) as typeof data.agent.runTerminalDistribution;
  data.agent.runTypeDistribution = panel(
    run,
    ["run"],
    db
      .prepare(
        `SELECT CASE WHEN run_kind='user' AND parent_run_id IS NULL THEN 'primary'
      WHEN run_kind='subtask' THEN 'subtask' ELSE 'other' END AS kind, COUNT(*) AS count FROM analytics_run_fact
      WHERE created_at >= ? AND created_at < ? GROUP BY kind`,
      )
      .all(from, to) as Array<{
      kind: "primary" | "subtask" | "other";
      count: number;
    }>,
    runCount > 0,
  ) as typeof data.agent.runTypeDistribution;
  const messageTypes = new Map<MessageHourRow["message_kind"], number>();
  for (const row of messageRows)
    messageTypes.set(
      row.message_kind,
      (messageTypes.get(row.message_kind) ?? 0) + row.message_count,
    );
  data.agent.messageTypeDistribution = panel(
    message,
    ["message"],
    [...messageTypes]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    user + assistant > 0,
  ) as typeof data.agent.messageTypeDistribution;
  const compactionCount = (
    kind: "manual" | "auto" | null,
    rows = messageRows,
  ) =>
    rows
      .filter(
        (row) =>
          row.message_kind === "compaction" &&
          row.message_status === "completed" &&
          row.compaction_kind === kind,
      )
      .reduce((total, row) => total + row.message_count, 0);
  const compaction = {
    manual: compactionCount("manual"),
    auto: compactionCount("auto"),
    unknown: messageRows
      .filter(
        (row) =>
          row.message_kind === "compaction" &&
          row.message_status === "completed" &&
          row.compaction_source_quality === "unknown",
      )
      .reduce((total, row) => total + row.message_count, 0),
  };
  const compactionBase = completeness(db, states, ["message", "run"], from, to);
  const compactionAssessment =
    compaction.unknown > 0 && compactionBase.complete
      ? {
          ...compactionBase,
          complete: false,
          unavailable: false,
          reason: "open_fact" as const,
        }
      : compactionBase;
  data.agent.metrics.manualCompactionCount = metric(
    compactionAssessment,
    ["message", "run"],
    compaction.manual,
    compaction.manual > 0,
  );
  data.agent.metrics.autoCompactionCount = metric(
    compactionAssessment,
    ["message", "run"],
    compaction.auto,
    compaction.auto > 0,
  );
  data.agent.trends.manualCompactionCount = panel(
    compactionAssessment,
    ["message", "run"],
    buckets.map((bucket) => ({
      ...bucket,
      count: compactionCount(
        "manual",
        messageRowsForRange(
          db,
          states,
          bucket.from,
          bucket.to,
          states.get("message"),
        ),
      ),
    })),
    compaction.manual > 0,
  );
  data.agent.trends.autoCompactionCount = panel(
    compactionAssessment,
    ["message", "run"],
    buckets.map((bucket) => ({
      ...bucket,
      count: compactionCount(
        "auto",
        messageRowsForRange(
          db,
          states,
          bucket.from,
          bucket.to,
          states.get("message"),
        ),
      ),
    })),
    compaction.auto > 0,
  );

  const durationRow = db
    .prepare(
      `SELECT COALESCE(SUM(MAX(0, MIN(effective_ended_at, ?) - MAX(started_at, ?))), 0) AS duration
      FROM analytics_execution_fact WHERE status='ended' AND end_time_quality IN ('observed', 'inferred') AND run_kind='user' AND parent_run_id IS NULL
      AND started_at < ? AND effective_ended_at > ?`,
    )
    .get(to, from, to, from) as { duration: number };
  const openExecution = db
    .prepare(
      `SELECT 1 FROM analytics_execution_fact WHERE status != 'ended' AND started_at < ? LIMIT 1`,
    )
    .get(to);
  const durationAssessment =
    openExecution && execution.complete
      ? {
          ...execution,
          complete: false,
          unavailable: false,
          reason: "open_fact" as const,
        }
      : execution;
  data.overview.agentDuration = metric(
    durationAssessment,
    ["agent_duration", "execution"],
    durationRow.duration,
    durationRow.duration > 0,
    { kind: "total", value: durationRow.duration },
  );
  data.agent.metrics.totalDuration = data.overview.agentDuration;
  const durationByBucket = buckets.map(() => 0);
  const durationFacts = db
    .prepare(
      `SELECT started_at, effective_ended_at FROM analytics_execution_fact WHERE status='ended' AND end_time_quality IN ('observed', 'inferred')
      AND run_kind='user' AND parent_run_id IS NULL AND started_at < ? AND effective_ended_at > ?`,
    )
    .all(to, from) as Array<{ started_at: number; effective_ended_at: number }>;
  for (const fact of durationFacts) {
    const start = Math.max(from, fact.started_at);
    const end = Math.min(to, fact.effective_ended_at);
    for (const [index, bucket] of buckets.entries())
      durationByBucket[index]! += Math.max(
        0,
        Math.min(end, bucket.to) - Math.max(start, bucket.from),
      );
  }
  data.agent.trends.totalDuration = panel(
    durationAssessment,
    ["agent_duration", "execution"],
    buckets.map((bucket, index) => ({
      ...bucket,
      durationMs: durationByBucket[index]!,
    })),
    durationRow.duration > 0,
    { kind: "total", value: durationRow.duration },
  );
  data.overviewTrends.agentDuration = data.agent.trends.totalDuration;

  const events = count(
    db,
    "analytics_worker_event_fact",
    "occurred_at",
    from,
    to,
  );
  const exits = count(
    db,
    "analytics_worker_event_fact",
    "occurred_at",
    from,
    to,
    "AND event_type = 'unexpected_exit'",
  );
  const restarts = count(
    db,
    "analytics_worker_event_fact",
    "occurred_at",
    from,
    to,
    "AND event_type = 'restart_attempted'",
  );
  const restartSucceeded = count(
    db,
    "analytics_worker_event_fact",
    "occurred_at",
    from,
    to,
    "AND event_type = 'restart_succeeded'",
  );
  const restartFailed = count(
    db,
    "analytics_worker_event_fact",
    "occurred_at",
    from,
    to,
    "AND event_type = 'restart_failed'",
  );
  data.worker.metrics.unexpectedExits = metric(
    worker,
    ["worker"],
    exits,
    exits > 0,
  );
  data.worker.metrics.restartAttempts = metric(
    worker,
    ["worker"],
    restarts,
    restarts > 0,
  );
  data.worker.metrics.restartSucceeded = metric(
    worker,
    ["worker"],
    restartSucceeded,
    restartSucceeded > 0,
  );
  data.worker.metrics.restartFailed = metric(
    worker,
    ["worker"],
    restartFailed,
    restartFailed > 0,
  );
  const workerBuckets = buckets.map(() => ({
    unexpectedExits: 0,
    restartAttempts: 0,
  }));
  const workerTrendFacts = db
    .prepare(
      `SELECT occurred_at, event_type FROM analytics_worker_event_fact WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`,
    )
    .all(from, to) as Array<{ occurred_at: number; event_type: string }>;
  let workerBucketIndex = 0;
  for (const fact of workerTrendFacts) {
    while (
      workerBucketIndex < buckets.length &&
      fact.occurred_at >= buckets[workerBucketIndex]!.to
    )
      workerBucketIndex += 1;
    if (
      workerBucketIndex >= buckets.length ||
      fact.occurred_at < buckets[workerBucketIndex]!.from
    )
      continue;
    if (fact.event_type === "unexpected_exit")
      workerBuckets[workerBucketIndex]!.unexpectedExits += 1;
    if (fact.event_type === "restart_attempted")
      workerBuckets[workerBucketIndex]!.restartAttempts += 1;
  }
  data.worker.eventTrend = panel(
    worker,
    ["worker"],
    buckets.map((bucket, index) => ({ ...bucket, ...workerBuckets[index]! })),
    events > 0,
  );
  data.worker.restartRecords = panel(
    worker,
    ["worker"],
    db
      .prepare(
        `SELECT occurred_at AS occurredAt, event_type AS event,
      CASE event_type WHEN 'restart_succeeded' THEN 'recovered' WHEN 'restart_failed' THEN 'not_recovered'
      WHEN 'restart_attempted' THEN 'pending' ELSE 'not_applicable' END AS restartStatus
      FROM analytics_worker_event_fact WHERE occurred_at >= ? AND occurred_at < ? AND event_type IN ('unexpected_exit','restart_attempted','restart_succeeded','restart_failed') ORDER BY occurred_at DESC`,
      )
      .all(from, to) as Array<{
      occurredAt: number;
      event:
        | "unexpected_exit"
        | "restart_attempted"
        | "restart_succeeded"
        | "restart_failed";
      restartStatus:
        "recovered" | "not_recovered" | "pending" | "not_applicable";
    }>,
    events > 0,
  ) as typeof data.worker.restartRecords;
  const live = db
    .prepare(
      `SELECT snapshot_at AS snapshotAt, active_count AS running, queue_length AS queued, concurrency, last_ready_at AS lastReadyAt
      FROM analytics_worker_live_snapshot WHERE runner_mode='agent_worker'`,
    )
    .get() as
    | {
        snapshotAt: number;
        running: number;
        queued: number;
        concurrency: number;
        lastReadyAt: number | null;
      }
    | undefined;
  if (live) {
    const fallback = db
      .prepare(
        `SELECT COUNT(*) AS count FROM analytics_execution_fact
        WHERE runtime_kind='api_local_fallback' AND status='running' AND parent_run_id IS NULL`,
      )
      .get() as { count: number };
    const fallbackCoverage = completeness(
      db,
      states,
      ["execution"],
      Math.max(0, now - 60_000),
      now,
    );
    const base =
      worker.complete && fallbackCoverage.complete
        ? { ...worker, complete: true }
        : {
            ...worker,
            complete: false,
            unavailable: false,
            reason: "collector_degraded" as const,
          };
    const liveAssessment =
      live.snapshotAt < now - 60_000 && base.complete
        ? {
            ...base,
            complete: false,
            unavailable: false,
            reason: "collector_degraded" as const,
          }
        : base;
    data.exceptions.workerLiveSnapshot = extendMetricResult(
      metric(
        liveAssessment,
        ["worker", "execution"],
        {
          running: live.running,
          queued: live.queued,
          concurrency: live.concurrency,
          utilization: ratio(live.running, live.concurrency),
          localFallbackRunning: fallback.count,
          lastReadyAt: live.lastReadyAt,
        },
        true,
      ),
      { snapshotAt: live.snapshotAt, asOf: now },
    );
  }

  const allHealthSlots = db
    .prepare(
      `SELECT s.domain, s.producer_namespace AS producerNamespace, s.producer_id AS producerId, g.producer_generation AS producerGeneration,
      g.lifecycle, c.received_at AS checkpointAt FROM analytics_producer_slot s
      LEFT JOIN analytics_producer_generation g ON g.domain=s.domain AND g.producer_namespace=s.producer_namespace AND g.producer_id=s.producer_id
        AND g.lifecycle IN ('registered', 'closing', 'stale')
      LEFT JOIN analytics_producer_checkpoint c ON c.rowid=(SELECT checkpoint.rowid FROM analytics_producer_checkpoint checkpoint
        WHERE checkpoint.domain=g.domain AND checkpoint.producer_namespace=g.producer_namespace AND checkpoint.producer_id=g.producer_id AND checkpoint.producer_generation=g.producer_generation
        ORDER BY checkpoint.received_at DESC LIMIT 1)
      WHERE s.expected_enabled=1`,
    )
    .all() as Array<{
    domain: AnalyticsDomain;
    producerNamespace: string;
    producerId: string;
    producerGeneration: string | null;
    lifecycle: string | null;
    checkpointAt: number | null;
  }>;
  const allGapSummaries = db
    .prepare(
      `SELECT domain, SUM(gap_to IS NULL) AS openCount, SUM(gap_to IS NOT NULL) AS historicalCount, MIN(gap_from) AS earliestGapFrom
      FROM analytics_signal_coverage_gap GROUP BY domain`,
    )
    .all() as Array<{
    domain: AnalyticsDomain;
    openCount: number | null;
    historicalCount: number | null;
    earliestGapFrom: number | null;
  }>;
  const gapsByDomain = new Map(
    allGapSummaries.map((summary) => [summary.domain, summary]),
  );
  const healthRows = [...states.values()].map((state) => {
    const slots = allHealthSlots.filter((slot) => slot.domain === state.domain);
    const activeLifecycles = new Set(["registered", "closing", "stale"]);
    const expectedSlotCount = new Set(
      slots.map((slot) => `${slot.producerNamespace}:${slot.producerId}`),
    ).size;
    const gapSummary = gapsByDomain.get(state.domain);
    const coverageGaps = {
      openCount: gapSummary?.openCount ?? 0,
      historicalCount: gapSummary?.historicalCount ?? 0,
      earliestGapFrom: gapSummary?.earliestGapFrom ?? null,
      hasOpenGap: (gapSummary?.openCount ?? 0) > 0,
    };
    return {
      domain: state.domain,
      status: state.status,
      collectionStartedAt: state.collectionStartedAt,
      reconciledThrough: state.reconciledThrough,
      rollupReadyThrough: state.rollupReadyThrough,
      retentionFloor: state.retentionFloor,
      lastSucceededAt: state.lastSucceededAt,
      expectedSlotCount,
      activeGenerationCount: slots.filter(
        (slot) =>
          slot.producerGeneration !== null &&
          activeLifecycles.has(slot.lifecycle ?? ""),
      ).length,
      slots: slots.map((slot) => {
        const active =
          slot.producerGeneration !== null &&
          activeLifecycles.has(slot.lifecycle ?? "");
        return !active
          ? {
              slotStatus: "missing_generation",
              producerNamespace: slot.producerNamespace,
              producerId: slot.producerId,
              producerGeneration: null,
              lifecycle: null,
              checkpoint: { freshness: "missing", observedAt: null },
              coverageGaps,
            }
          : {
              slotStatus: "generation_active",
              producerNamespace: slot.producerNamespace,
              producerId: slot.producerId,
              producerGeneration: slot.producerGeneration,
              lifecycle: slot.lifecycle as "registered" | "closing" | "stale",
              checkpoint:
                slot.checkpointAt === null
                  ? { freshness: "missing", observedAt: null }
                  : {
                      freshness:
                        slot.checkpointAt < now - 60_000 ? "stale" : "fresh",
                      observedAt: slot.checkpointAt,
                    },
              coverageGaps,
            };
      }),
      coverageGaps,
    };
  });
  data.exceptions.domainHealth = {
    status: "available",
    data: healthRows,
    completeness: "complete",
    dataIncomplete: false,
    requiredDomains: [],
    comparison: comparisonNotApplicable,
    diagnosedAt: now,
    asOf: now,
  } as typeof data.exceptions.domainHealth;

  const monitoring = monitoringCompleteness(db, states, from, to, now);
  const factDomains = monitoring.requiredDomains;
  const volume = monitoring.assessment;
  const config = monitoring.asOfConfig;
  const collected = collectedCountsForRange(db, from, to);
  const collectedTotal = FACT_DOMAINS.reduce(
    (total, domain) => total + collected[domain],
    0,
  );
  data.overview.monitoringVolume = metric(
    volume,
    factDomains,
    {
      count: collectedTotal,
      metricDefinitionVersion: "dashboard_collected_fact_v1",
      collectionConfigVersion: config?.collection_config_version ?? "0000000000000000",
      configuredDomainsAtAsOf: config
        ? JSON.parse(config.enabled_fact_domains_json)
        : [],
      configurationChangedWithinRange: monitoring.changedWithinRange,
    },
    collectedTotal > 0,
  );
  const volumeByBucket = buckets.map((bucket) =>
    collectedCountsForRange(db, bucket.from, bucket.to),
  );
  data.overviewTrends.monitoringVolume = panel(
    volume,
    factDomains,
    buckets.map((bucket, index) => {
      const value = volumeByBucket[index]!;
      return {
        ...bucket,
        ...value,
        total:
          value.run +
          value.session +
          value.message +
          value.tool +
          value.execution +
          value.model +
          value.worker +
          value.git,
      };
    }),
    collectedTotal > 0,
  );
  return { ...initial, rangeId: randomUUID(), data };
}

type ResultNode = {
  status?: unknown;
  comparison?: AnalyticsComparisonResult;
  value?: unknown;
  data?: unknown;
  [key: string]: unknown;
};
function isResultNode(value: unknown): value is ResultNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "comparison" in value
  );
}
function comparableNumber(
  value: unknown,
): { value: number; ratio: boolean } | null {
  if (typeof value === "number" && Number.isFinite(value))
    return { value, ratio: false };
  if (typeof value !== "object" || value === null) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.count === "number" && Number.isFinite(object.count))
    return { value: object.count, ratio: false };
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        "from" in point &&
        "to" in point,
    )
  ) {
    const points = value as Array<Record<string, unknown>>;
    if (points.every((point) => typeof point.count === "number"))
      return {
        value: points.reduce((sum, point) => sum + Number(point.count), 0),
        ratio: false,
      };
    if (points.every((point) => typeof point.total === "number"))
      return {
        value: points.reduce((sum, point) => sum + Number(point.total), 0),
        ratio: false,
      };
    if (
      points.every(
        (point) =>
          typeof point.completed === "number" &&
          typeof point.failed === "number" &&
          typeof point.timedOut === "number" &&
          typeof point.other === "number",
      )
    )
      return {
        value: points.reduce(
          (sum, point) =>
            sum +
            Number(point.completed) +
            Number(point.failed) +
            Number(point.timedOut) +
            Number(point.other),
          0,
        ),
        ratio: false,
      };
  }
  return null;
}
function comparisonFromAggregates(
  current: ComparisonAggregate,
  previous: ComparisonAggregate,
): AnalyticsComparisonResult {
  if (current.kind === "ratio" && previous.kind === "ratio") {
    if (previous.denominator === 0)
      return { status: "previous_zero", delta: null, kind: null };
    if (current.denominator === 0) return comparisonNotApplicable;
    return {
      status: "available",
      delta:
        current.numerator / current.denominator -
        previous.numerator / previous.denominator,
      kind: "percentage_points",
    };
  }
  if (current.kind === "average" && previous.kind === "average") {
    if (previous.samples === 0)
      return { status: "previous_zero", delta: null, kind: null };
    if (current.samples === 0) return comparisonNotApplicable;
    const before = previous.sum / previous.samples;
    return before === 0
      ? { status: "previous_zero", delta: null, kind: null }
      : {
          status: "available",
          delta: (current.sum / current.samples - before) / Math.abs(before),
          kind: "relative",
        };
  }
  if (current.kind !== "count" && current.kind !== "total")
    return comparisonNotApplicable;
  if (previous.kind !== "count" && previous.kind !== "total")
    return comparisonNotApplicable;
  const now = current.value;
  const then = previous.value;
  return then === 0
    ? { status: "previous_zero", delta: null, kind: null }
    : {
        status: "available",
        delta: (now - then) / Math.abs(then),
        kind: "relative",
      };
}
function comparisonFor(
  current: ResultNode,
  previous: ResultNode | undefined,
  rangeTooLarge: boolean,
): AnalyticsComparisonResult {
  if (current.status === "unavailable") return comparisonUnavailable;
  // Partial data is useful for display but cannot produce a certified delta.
  if (current.status !== "available")
    return { status: "previous_not_covered", delta: null, kind: null };
  if (rangeTooLarge)
    return { status: "range_too_large", delta: null, kind: null };
  if (!previous || previous.status !== "available")
    return { status: "previous_not_covered", delta: null, kind: null };
  const currentAggregate = comparisonAggregates.get(current);
  const previousAggregate = comparisonAggregates.get(previous);
  if (currentAggregate && previousAggregate)
    return comparisonFromAggregates(currentAggregate, previousAggregate);
  const now = comparableNumber(current.value ?? current.data);
  const then = comparableNumber(previous.value ?? previous.data);
  if (!now || !then) return comparisonNotApplicable;
  // A zero percentage is a valid observation, not a missing denominator.
  const kind = now.ratio || then.ratio ? "percentage_points" : "relative";
  if (kind === "percentage_points")
    return { status: "available", delta: now.value - then.value, kind };
  if (then.value === 0)
    return { status: "previous_zero", delta: null, kind: null };
  const delta = (now.value - then.value) / Math.abs(then.value);
  return Number.isFinite(delta)
    ? { status: "available", delta, kind }
    : comparisonNotApplicable;
}
function attachComparisons(
  current: unknown,
  previous: unknown,
  rangeTooLarge: boolean,
) {
  if (isResultNode(current))
    current.comparison = comparisonFor(
      current,
      isResultNode(previous) ? previous : undefined,
      rangeTooLarge,
    );
  if (typeof current !== "object" || current === null || Array.isArray(current))
    return;
  const now = current as Record<string, unknown>;
  const before =
    typeof previous === "object" && previous !== null
      ? (previous as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(now))
    if (key !== "comparison")
      attachComparisons(value, before[key], rangeTooLarge);
}

function markNotApplicable(value: unknown) {
  if (isResultNode(value)) value.comparison = comparisonNotApplicable;
}

/** The public query runs current and previous windows inside one child-owned read snapshot. */
export function queryDashboard(
  db: AnalyticsDb,
  request: DashboardQueryRequest,
  now = Date.now(),
): DashboardQuerySuccessResponse | DashboardQueryErrorResponse {
  return db.transaction(() => {
    const current = queryDashboardSnapshot(db, request, now);
    if (current.kind !== "success") return current;
    const duration = current.to - current.from;
    const rangeTooLarge =
      request.rangeKind === "preset_90d" ||
      (request.rangeKind === "custom" && duration >= 90 * 24 * HOUR_MS);
    const previousRequest: DashboardQueryRequest = {
      rangeKind: "custom",
      timezone: current.timezone,
      from: current.from - duration,
      to: current.from,
    };
    const previous = rangeTooLarge
      ? undefined
      : queryDashboardSnapshot(db, previousRequest, now);
    attachComparisons(
      current.data,
      previous?.kind === "success" ? previous.data : undefined,
      rangeTooLarge,
    );
    markNotApplicable(current.data.exceptions.domainHealth);
    markNotApplicable(current.data.exceptions.workerLiveSnapshot);
    markNotApplicable(current.data.exceptions.gitHeatmap180d);
    return current;
  })();
}
