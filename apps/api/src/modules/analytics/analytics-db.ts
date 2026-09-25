import Database from "better-sqlite3";
import type { FileHandle } from "node:fs/promises";
import {
  openSecureAnalyticsRoot,
  type SecureAnalyticsDirectory,
} from "@agent-workbench/shared/node/analytics-root";

/** Version 19 retires Git Analytics without resetting any other domain. */
export const ANALYTICS_SCHEMA_VERSION = 19;
const V18_SCHEMA_VERSION = 18;
const PRE_GIT_SCHEMA_VERSION = 11;
const V12_SCHEMA_VERSION = 12;
const V13_SCHEMA_VERSION = 13;
const V14_SCHEMA_VERSION = 14;
const V15_SCHEMA_VERSION = 15;
const V16_SCHEMA_VERSION = 16;
const V17_SCHEMA_VERSION = 17;

const ANALYTICS_DOMAINS = ["model", "run", "execution", "agent_duration", "tool", "message", "session", "worker"] as const;
const LEGACY_ANALYTICS_DOMAINS = [...ANALYTICS_DOMAINS, "git"] as const;
const DOMAIN_STATUSES = ["healthy", "degraded", "stale", "unavailable", "disabled"] as const;
const ANALYTICS_FACT_DOMAINS = ["run", "session", "message", "tool", "execution", "model", "worker"] as const;
const LEGACY_FACT_DOMAINS = [...ANALYTICS_FACT_DOMAINS, "git"] as const;
const BUSINESS_COLLECTOR_DOMAINS = ["run", "session", "message", "tool"] as const;
const DOMAIN_STATUS_SQL = DOMAIN_STATUSES.map((status) => `'${status}'`).join(", ");
const BASE_TABLES = ["analytics_schema_meta", "analytics_domain_state", "analytics_domain_config_version"] as const;
const SOURCE_CONTROL_TABLE = "analytics_config_source_control";

export type AnalyticsDb = Database.Database;
const databaseRoots = new WeakMap<AnalyticsDb, { root: SecureAnalyticsDirectory; file: FileHandle }>();
export type AnalyticsDomainState = {
  domain: typeof ANALYTICS_DOMAINS[number];
  status: typeof DOMAIN_STATUSES[number];
  collectionStartedAt: number | null;
  reconciledThrough: number | null;
  rollupReadyThrough: number | null;
  retentionFloor: number | null;
  lastSucceededAt: number | null;
  lastErrorCode: string | null;
};


const SIGNAL_TABLE_SQL = `
  CREATE TABLE analytics_producer_slot (
    domain TEXT NOT NULL CHECK (domain IN ('execution', 'model', 'worker')),
    producer_namespace TEXT NOT NULL CHECK (producer_namespace IN ('agent_worker', 'api_local_fallback', 'worker_observer')),
    producer_id TEXT NOT NULL,
    expected_enabled INTEGER NOT NULL CHECK (expected_enabled IN (0, 1)),
    config_version TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (domain, producer_namespace, producer_id),
    CHECK ((domain = 'worker' AND producer_namespace = 'worker_observer' AND producer_id = 'process_manager') OR (domain IN ('execution', 'model') AND ((producer_namespace = 'agent_worker' AND producer_id = 'agent_runner') OR (producer_namespace = 'api_local_fallback' AND producer_id = 'api_local_fallback'))))
  );
  CREATE TABLE analytics_producer_generation (
    domain TEXT NOT NULL CHECK (domain IN ('execution', 'model', 'worker')),
    producer_namespace TEXT NOT NULL, producer_id TEXT NOT NULL, producer_generation TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('registered', 'closing', 'closed', 'stale', 'abandoned')),
    final_sequence INTEGER CHECK (final_sequence >= 0), committed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (committed_sequence >= 0),
    max_observed_at INTEGER CHECK (max_observed_at >= 0), earliest_open_started_at INTEGER CHECK (earliest_open_started_at >= 0),
    known_drop INTEGER NOT NULL DEFAULT 0 CHECK (known_drop IN (0, 1)), dropped_since_sequence INTEGER CHECK (dropped_since_sequence >= 1),
    outbox_pending INTEGER NOT NULL DEFAULT 0 CHECK (outbox_pending >= 0), oldest_pending_at INTEGER CHECK (oldest_pending_at >= 0),
    loss_epoch INTEGER NOT NULL DEFAULT 0 CHECK (loss_epoch >= 0), control_sequence INTEGER NOT NULL DEFAULT 1 CHECK (control_sequence >= 1), last_control_received_at INTEGER NOT NULL CHECK (last_control_received_at >= 0), created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (domain, producer_namespace, producer_id, producer_generation),
    CHECK (final_sequence IS NULL OR committed_sequence <= final_sequence),
    CHECK ((known_drop = 0 AND dropped_since_sequence IS NULL) OR (known_drop = 1 AND dropped_since_sequence IS NOT NULL)),
    CHECK ((outbox_pending = 0 AND oldest_pending_at IS NULL) OR (outbox_pending > 0 AND oldest_pending_at IS NOT NULL)),
    CHECK (earliest_open_started_at IS NULL OR max_observed_at IS NULL OR earliest_open_started_at <= max_observed_at)
  );
  CREATE TABLE analytics_producer_checkpoint (
    domain TEXT NOT NULL CHECK (domain IN ('execution', 'model', 'worker')),
    producer_namespace TEXT NOT NULL, producer_id TEXT NOT NULL, producer_generation TEXT NOT NULL,
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0), max_observed_at INTEGER CHECK (max_observed_at >= 0),
    earliest_open_started_at INTEGER CHECK (earliest_open_started_at >= 0), open_execution_count INTEGER NOT NULL CHECK (open_execution_count >= 0), open_model_count INTEGER NOT NULL CHECK (open_model_count >= 0),
    known_drop INTEGER NOT NULL CHECK (known_drop IN (0, 1)), dropped_since_sequence INTEGER CHECK (dropped_since_sequence >= 1),
    outbox_pending INTEGER NOT NULL CHECK (outbox_pending >= 0), oldest_pending_at INTEGER CHECK (oldest_pending_at >= 0), loss_epoch INTEGER NOT NULL CHECK (loss_epoch >= 0), control_sequence INTEGER NOT NULL CHECK (control_sequence >= 1),
    received_at INTEGER NOT NULL CHECK (received_at >= 0), PRIMARY KEY (domain, producer_namespace, producer_id, producer_generation),
    CHECK ((known_drop = 0 AND dropped_since_sequence IS NULL) OR (known_drop = 1 AND dropped_since_sequence IS NOT NULL)),
    CHECK ((outbox_pending = 0 AND oldest_pending_at IS NULL) OR (outbox_pending > 0 AND oldest_pending_at IS NOT NULL)),
    CHECK ((open_execution_count = 0 AND open_model_count = 0 AND earliest_open_started_at IS NULL) OR ((open_execution_count > 0 OR open_model_count > 0) AND earliest_open_started_at IS NOT NULL)),
    CHECK (earliest_open_started_at IS NULL OR max_observed_at IS NULL OR earliest_open_started_at <= max_observed_at)
  );
  CREATE TABLE analytics_event_receipt (
    event_id TEXT PRIMARY KEY, producer_namespace TEXT NOT NULL, producer_id TEXT NOT NULL, producer_generation TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1), payload_version INTEGER NOT NULL CHECK (payload_version = 1),
    event_type TEXT NOT NULL CHECK (event_type IN ('execution_started', 'execution_finished', 'model_invoked', 'model_finished', 'worker_ready', 'worker_snapshot', 'worker_restart_attempted', 'worker_restart_succeeded', 'worker_restart_failed', 'worker_unexpected_exit', 'worker_controlled_stop')),
    subject_identity TEXT NOT NULL, fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64), received_at INTEGER NOT NULL CHECK (received_at >= 0), committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
    UNIQUE(producer_namespace, producer_id, producer_generation, sequence)
  );
  CREATE TABLE analytics_signal_coverage_gap (
    gap_id TEXT PRIMARY KEY, domain TEXT NOT NULL CHECK (domain IN ('execution', 'model', 'worker')), producer_namespace TEXT NOT NULL, producer_id TEXT NOT NULL, producer_generation TEXT NOT NULL,
    gap_from INTEGER NOT NULL CHECK (gap_from >= 0), gap_to INTEGER CHECK (gap_to >= 0), cause TEXT NOT NULL CHECK (cause IN ('known_drop', 'abandoned_exit', 'outbox_corrupt')),
    dropped_since_sequence INTEGER CHECK (dropped_since_sequence >= 1), recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0), closed_at INTEGER CHECK (closed_at >= 0),
    CHECK (gap_to IS NULL OR gap_to > gap_from), CHECK ((gap_to IS NULL AND closed_at IS NULL) OR (gap_to IS NOT NULL AND closed_at IS NOT NULL))
  );
  CREATE TABLE analytics_execution_fact (
    execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('agent_worker', 'api_local_fallback')), producer_namespace TEXT,
    producer_id TEXT, producer_generation TEXT,
    run_kind TEXT NOT NULL, parent_run_id TEXT, queued_at INTEGER CHECK (queued_at >= 0), started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at >= 0), effective_ended_at INTEGER CHECK (effective_ended_at >= 0), status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ended')),
    end_time_quality TEXT NOT NULL CHECK (end_time_quality IN ('observed', 'inferred', 'unknown')), end_reason TEXT CHECK (end_reason IN ('completed', 'failed', 'cancelled', 'timed_out', 'other', 'worker_exit')),
    observed_at INTEGER NOT NULL CHECK (observed_at >= 0), updated_at INTEGER NOT NULL CHECK (updated_at >= 0), collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
    CHECK (ended_at IS NULL OR ended_at >= started_at), CHECK (effective_ended_at IS NULL OR effective_ended_at >= started_at),
    CHECK ((status = 'ended' AND ((end_time_quality IN ('observed', 'inferred') AND ended_at IS NOT NULL AND effective_ended_at IS NOT NULL AND end_reason IS NOT NULL) OR (end_time_quality = 'unknown' AND ended_at IS NULL AND effective_ended_at IS NULL AND end_reason = 'worker_exit'))) OR (status IN ('queued', 'running') AND ended_at IS NULL AND effective_ended_at IS NULL AND end_reason IS NULL AND end_time_quality = 'unknown')),
    CHECK ((producer_namespace IS NULL AND producer_id IS NULL AND producer_generation IS NULL) OR (producer_namespace IN ('agent_worker', 'api_local_fallback') AND producer_id IS NOT NULL AND producer_generation IS NOT NULL))
  );
  CREATE TABLE analytics_model_call_fact (
    model_call_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    producer_namespace TEXT, producer_id TEXT, producer_generation TEXT,
    provider_id TEXT NOT NULL, model_id TEXT NOT NULL, started_at INTEGER NOT NULL CHECK (started_at >= 0), ended_at INTEGER CHECK (ended_at >= 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled', 'other')), completion_quality TEXT NOT NULL CHECK (completion_quality IN ('observed', 'unknown')),
    timeout_kind TEXT CHECK (timeout_kind IN ('idle', 'total')), input_tokens INTEGER CHECK (input_tokens >= 0), output_tokens INTEGER CHECK (output_tokens >= 0), total_tokens INTEGER CHECK (total_tokens >= 0), total_source TEXT NOT NULL CHECK (total_source IN ('reported', 'derived', 'unavailable')),
    cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0), cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0), cache_comparable INTEGER NOT NULL CHECK (cache_comparable IN (0, 1)), cache_write_verified INTEGER NOT NULL CHECK (cache_write_verified IN (0, 1)),
    failure_kind TEXT CHECK (failure_kind IN ('provider', 'timeout', 'cancelled', 'other')), observed_at INTEGER NOT NULL CHECK (observed_at >= 0), updated_at INTEGER NOT NULL CHECK (updated_at >= 0), collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
    CHECK (ended_at IS NULL OR ended_at >= started_at), CHECK ((status = 'running' AND ended_at IS NULL AND failure_kind IS NULL) OR (status != 'running' AND ended_at IS NOT NULL)),
    CHECK ((total_source = 'unavailable' AND total_tokens IS NULL) OR (total_source != 'unavailable' AND total_tokens IS NOT NULL)),
    CHECK (total_tokens IS NULL OR input_tokens IS NULL OR output_tokens IS NULL OR total_tokens = input_tokens + output_tokens),
    CHECK ((status = 'running' AND completion_quality = 'unknown') OR status != 'running'),
    CHECK ((producer_namespace IS NULL AND producer_id IS NULL AND producer_generation IS NULL) OR (producer_namespace IN ('agent_worker', 'api_local_fallback') AND producer_id IS NOT NULL AND producer_generation IS NOT NULL))
  );
  CREATE TABLE analytics_worker_event_fact (
    event_id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0), event_type TEXT NOT NULL CHECK (event_type IN ('ready', 'unexpected_exit', 'restart_attempted', 'restart_succeeded', 'restart_failed', 'controlled_stop')),
    restart_attempt_id TEXT, runner_mode TEXT NOT NULL CHECK (runner_mode IN ('agent_worker', 'api_local_fallback')), collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
    CHECK ((event_type LIKE 'restart_%' AND restart_attempt_id IS NOT NULL) OR (event_type NOT LIKE 'restart_%' AND restart_attempt_id IS NULL))
  );
  CREATE TABLE analytics_worker_live_snapshot (
    runner_mode TEXT PRIMARY KEY CHECK (runner_mode IN ('agent_worker', 'api_local_fallback')), snapshot_at INTEGER NOT NULL CHECK (snapshot_at >= 0), active_count INTEGER NOT NULL CHECK (active_count >= 0), queue_length INTEGER NOT NULL CHECK (queue_length >= 0),
    concurrency INTEGER NOT NULL CHECK (concurrency >= 1), last_ready_at INTEGER CHECK (last_ready_at >= 0), received_at INTEGER NOT NULL CHECK (received_at >= 0)
  );
  CREATE INDEX idx_analytics_receipt_committed_at ON analytics_event_receipt(committed_at);
  CREATE INDEX idx_analytics_receipt_generation_sequence ON analytics_event_receipt(producer_namespace, producer_id, producer_generation, sequence);
  CREATE INDEX idx_analytics_checkpoint_domain_received ON analytics_producer_checkpoint(domain, received_at);
  CREATE INDEX idx_analytics_generation_lifecycle ON analytics_producer_generation(domain, lifecycle, last_control_received_at);
  CREATE INDEX idx_analytics_gap_slot_range ON analytics_signal_coverage_gap(domain, producer_namespace, producer_id, gap_from, gap_to);
  CREATE INDEX idx_analytics_execution_range ON analytics_execution_fact(started_at, effective_ended_at, run_kind, parent_run_id);
  CREATE INDEX idx_analytics_execution_open ON analytics_execution_fact(producer_namespace, producer_id, producer_generation, status, started_at);
  CREATE INDEX idx_analytics_execution_collected_at ON analytics_execution_fact(collected_at);
  CREATE INDEX idx_analytics_model_range ON analytics_model_call_fact(started_at, provider_id, model_id, status);
  CREATE INDEX idx_analytics_model_open ON analytics_model_call_fact(producer_namespace, producer_id, producer_generation, status, started_at);
  CREATE INDEX idx_analytics_model_collected_at ON analytics_model_call_fact(collected_at);
  CREATE INDEX idx_analytics_worker_event_range ON analytics_worker_event_fact(occurred_at, event_type);
  CREATE INDEX idx_analytics_worker_event_collected_at ON analytics_worker_event_fact(collected_at);
`;

type TableColumn = { name: string; type: string; notnull: number; pk: number };
type ExpectedColumn = Pick<TableColumn, "name" | "type" | "notnull" | "pk">;
type SchemaObject = { name: string; sql: string | null };

function unavailableSchema(): never {
  throw new Error("analytics database unavailable");
}

function normalizedSql(sql: string | null) {
  return String(sql ?? "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}

function expectedList(values: readonly string[]) {
  return values.map((value) => `'${value}'`).join(", ");
}

const COLLECTOR_TABLE_SQL = `
  CREATE TABLE analytics_collector_watermark (
    domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN ('run', 'session', 'message', 'tool')),
    initial_anchor INTEGER NOT NULL CHECK (initial_anchor >= 0),
    initial_floor_updated_at INTEGER NOT NULL CHECK (initial_floor_updated_at >= 0),
    initial_floor_stable_id TEXT NOT NULL,
    durable_updated_at INTEGER NOT NULL CHECK (durable_updated_at >= 0),
    durable_stable_id TEXT NOT NULL,
    scan_anchor INTEGER CHECK (scan_anchor >= 0),
    cycle_cursor_updated_at INTEGER CHECK (cycle_cursor_updated_at >= 0),
    cycle_cursor_stable_id TEXT,
    cycle_state TEXT NOT NULL CHECK (cycle_state IN ('idle', 'scanning')),
    reconciled_through INTEGER CHECK (reconciled_through >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK (
      (cycle_state = 'idle' AND scan_anchor IS NULL AND cycle_cursor_updated_at IS NULL AND cycle_cursor_stable_id IS NULL)
      OR (cycle_state = 'scanning' AND scan_anchor IS NOT NULL AND cycle_cursor_updated_at IS NOT NULL AND cycle_cursor_stable_id IS NOT NULL)
    )
  );
  CREATE TABLE analytics_run_fact (
    run_id TEXT PRIMARY KEY NOT NULL,
    run_kind TEXT NOT NULL CHECK (run_kind IN ('user', 'manual_compaction', 'subtask')),
    parent_run_id TEXT,
    display_status TEXT NOT NULL CHECK (display_status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown')),
    status_quality TEXT NOT NULL CHECK (status_quality IN ('observed', 'inferred')),
    inferred_evidence_type TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    terminal_at INTEGER CHECK (terminal_at >= 0),
    source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
    collected_at INTEGER NOT NULL CHECK (collected_at >= 0)
  );
  CREATE INDEX analytics_run_fact_created_run_id ON analytics_run_fact(created_at, run_id);
  CREATE INDEX analytics_run_fact_collected_at ON analytics_run_fact(collected_at);
  CREATE TABLE analytics_session_fact (
    session_id TEXT PRIMARY KEY NOT NULL,
    session_kind TEXT NOT NULL CHECK (session_kind IN ('primary', 'subtask')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
    collected_at INTEGER NOT NULL CHECK (collected_at >= 0)
  );
  CREATE INDEX analytics_session_fact_created_session_id ON analytics_session_fact(created_at, session_id);
  CREATE INDEX analytics_session_fact_collected_at ON analytics_session_fact(collected_at);
  CREATE TABLE analytics_message_fact (
    message_id TEXT PRIMARY KEY NOT NULL,
    message_kind TEXT NOT NULL CHECK (message_kind IN ('user', 'assistant', 'runtime', 'system', 'compaction')),
    message_status TEXT NOT NULL CHECK (message_status IN ('streaming', 'completed', 'failed', 'cancelled', 'superseded')),
    origin_run_id TEXT,
    compaction_kind TEXT CHECK (compaction_kind IN ('manual', 'auto')),
    compaction_source_quality TEXT NOT NULL CHECK (compaction_source_quality IN ('known', 'unknown', 'not_applicable')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
    collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
    CHECK ((compaction_kind IS NOT NULL AND compaction_source_quality = 'known') OR (compaction_kind IS NULL AND compaction_source_quality IN ('unknown', 'not_applicable')))
  );
  CREATE INDEX analytics_message_fact_created_kind_status_compaction ON analytics_message_fact(created_at, message_kind, message_status, compaction_kind);
  CREATE INDEX analytics_message_fact_collected_at ON analytics_message_fact(collected_at);
  CREATE TABLE analytics_tool_fact (
    tool_id TEXT PRIMARY KEY NOT NULL,
    tool_name TEXT,
    tool_name_quality TEXT NOT NULL CHECK (tool_name_quality IN ('known', 'unavailable')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    started_at INTEGER CHECK (started_at >= 0),
    completed_at INTEGER CHECK (completed_at >= 0),
    completed_duration_ms INTEGER CHECK (completed_duration_ms >= 0),
    source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
    collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
    CHECK ((tool_name IS NOT NULL AND tool_name_quality = 'known') OR (tool_name IS NULL AND tool_name_quality = 'unavailable')),
    CHECK (completed_duration_ms IS NULL OR (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at AND completed_duration_ms = completed_at - started_at))
  );
  CREATE INDEX analytics_tool_fact_created_tool_name_status ON analytics_tool_fact(created_at, tool_name, status);
  CREATE INDEX analytics_tool_fact_collected_at ON analytics_tool_fact(collected_at);
`;


/** Git analytics deliberately persists only HMAC identities and aggregate metadata. */
const GIT_TABLE_SQL = `
  CREATE TABLE analytics_git_scan (
    scan_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, started_at INTEGER NOT NULL CHECK(started_at >= 0), completed_at INTEGER,
    source_state TEXT NOT NULL CHECK(source_state IN ('running','ready','failed')), covered_from INTEGER, covered_to INTEGER,
    safe_error_code TEXT, CHECK((source_state='ready' AND completed_at IS NOT NULL AND covered_from IS NOT NULL AND covered_to IS NOT NULL) OR source_state <> 'ready')
  );
  CREATE TABLE analytics_git_commit_fact (
    repo_id TEXT NOT NULL, commit_identity TEXT NOT NULL CHECK(length(commit_identity)=64), committed_at INTEGER NOT NULL CHECK(committed_at >= 0),
    parent_count INTEGER NOT NULL CHECK(parent_count >= 0), files_changed INTEGER, insertions INTEGER, deletions INTEGER, collected_at INTEGER NOT NULL CHECK(collected_at >= 0),
    PRIMARY KEY(repo_id, commit_identity), CHECK(files_changed IS NULL OR files_changed >= 0), CHECK(insertions IS NULL OR insertions >= 0), CHECK(deletions IS NULL OR deletions >= 0),
    CHECK((parent_count > 1 AND files_changed IS NULL AND insertions IS NULL AND deletions IS NULL) OR parent_count <= 1)
  );
  CREATE TABLE analytics_git_membership (scan_id TEXT NOT NULL, repo_id TEXT NOT NULL, commit_identity TEXT NOT NULL CHECK(length(commit_identity)=64), PRIMARY KEY(scan_id,repo_id,commit_identity));
  CREATE TABLE analytics_git_repo_state (repo_id TEXT PRIMARY KEY, current_scan_id TEXT, covered_from INTEGER, covered_to INTEGER, last_ready_at INTEGER, last_scan_at INTEGER,
    CHECK(covered_from IS NULL OR covered_from >= 0), CHECK(covered_to IS NULL OR covered_to >= 0));
  CREATE INDEX analytics_git_commit_repo_committed ON analytics_git_commit_fact(repo_id, committed_at);
  CREATE INDEX analytics_git_commit_collected_at ON analytics_git_commit_fact(collected_at);
  CREATE INDEX analytics_git_membership_current ON analytics_git_membership(scan_id, repo_id, commit_identity);
  CREATE INDEX analytics_git_scan_repo_state ON analytics_git_scan(repo_id, source_state, completed_at);
`;

/** Only Model, Tool and Message have business-time hourly rollups. */
const DASHBOARD_TABLE_SQL = `
  CREATE TABLE analytics_dirty_hour (
    domain TEXT NOT NULL CHECK (domain IN ('model', 'tool', 'message')),
    bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0),
    marked_at INTEGER NOT NULL CHECK (marked_at >= 0),
    PRIMARY KEY (domain, bucket_start)
  );
  CREATE TABLE dashboard_model_1h (
    bucket_start INTEGER PRIMARY KEY CHECK (bucket_start >= 0),
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    completed_count INTEGER NOT NULL CHECK (completed_count >= 0),
    failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
    timed_out_count INTEGER NOT NULL CHECK (timed_out_count >= 0),
    other_count INTEGER NOT NULL CHECK (other_count >= 0),
    completed_duration_sum_ms INTEGER NOT NULL CHECK (completed_duration_sum_ms >= 0),
    completed_duration_sample_count INTEGER NOT NULL CHECK (completed_duration_sample_count >= 0),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0)
  );
  CREATE TABLE dashboard_model_dimension_1h (
    bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0), provider_id TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL, timeout_kind TEXT,
    request_count INTEGER NOT NULL CHECK (request_count >= 0), completed_duration_sum_ms INTEGER NOT NULL CHECK (completed_duration_sum_ms >= 0), completed_duration_sample_count INTEGER NOT NULL CHECK (completed_duration_sample_count >= 0),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0), input_reported_count INTEGER NOT NULL CHECK (input_reported_count >= 0), output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0), output_reported_count INTEGER NOT NULL CHECK (output_reported_count >= 0),
    total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0), total_reported_count INTEGER NOT NULL CHECK (total_reported_count >= 0), total_derived_count INTEGER NOT NULL CHECK (total_derived_count >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0), cache_comparable_count INTEGER NOT NULL CHECK (cache_comparable_count >= 0), comparable_input_tokens INTEGER NOT NULL CHECK (comparable_input_tokens >= 0), comparable_cache_read_tokens INTEGER NOT NULL CHECK (comparable_cache_read_tokens >= 0),
    PRIMARY KEY (bucket_start, provider_id, model_id, status, timeout_kind)
  );
  CREATE INDEX dashboard_model_dimension_1h_bucket ON dashboard_model_dimension_1h(bucket_start);
  CREATE TABLE dashboard_tool_1h (
    bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0),
    tool_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
    call_count INTEGER NOT NULL CHECK (call_count >= 0),
    completed_duration_sum_ms INTEGER NOT NULL CHECK (completed_duration_sum_ms >= 0),
    completed_duration_sample_count INTEGER NOT NULL CHECK (completed_duration_sample_count >= 0),
    PRIMARY KEY (bucket_start, tool_name, status)
  );
  CREATE TABLE dashboard_message_1h (
    bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0),
    message_kind TEXT NOT NULL CHECK (message_kind IN ('user', 'assistant', 'runtime', 'system', 'compaction')),
    message_status TEXT NOT NULL,
    compaction_kind TEXT, compaction_source_quality TEXT NOT NULL CHECK (compaction_source_quality IN ('known', 'unknown', 'not_applicable')),
    message_count INTEGER NOT NULL CHECK (message_count >= 0),
    PRIMARY KEY (bucket_start, message_kind, message_status, compaction_kind, compaction_source_quality)
  );
  CREATE TABLE dashboard_collected_1h (
    bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0),
    domain TEXT NOT NULL CHECK (domain IN ('run', 'session', 'message', 'tool', 'execution', 'model', 'worker', 'git')),
    fact_count INTEGER NOT NULL CHECK (fact_count >= 0),
    PRIMARY KEY (bucket_start, domain)
  );
  /* A marker is written even when the replacement aggregate is zero. */
  CREATE TABLE analytics_rollup_hour (
    domain TEXT NOT NULL CHECK (domain IN ('model', 'tool', 'message')),
    bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0),
    rebuilt_at INTEGER NOT NULL CHECK (rebuilt_at >= 0),
    PRIMARY KEY (domain, bucket_start)
  );
  CREATE TABLE analytics_maintenance_state (
    task_name TEXT PRIMARY KEY NOT NULL,
    last_started_at INTEGER,
    last_succeeded_at INTEGER,
    last_error_code TEXT,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  );
  CREATE INDEX analytics_dirty_hour_domain_bucket ON analytics_dirty_hour(domain, bucket_start);
  CREATE INDEX analytics_rollup_hour_domain_bucket ON analytics_rollup_hour(domain, bucket_start);
  CREATE INDEX dashboard_collected_1h_bucket ON dashboard_collected_1h(bucket_start);
`;

// Keep the released DDL above intact: older migrations and schema fingerprints
// must still recognize their historical Git-aware collected cache.
const CURRENT_DASHBOARD_TABLE_SQL = DASHBOARD_TABLE_SQL.replace(
  "'worker', 'git'", "'worker'",
);

function rawExpectedDdl(name: string, kind: "table" | "index") {
  const source = SIGNAL_TABLE_SQL.toLowerCase().includes(`create ${kind} ${name}`)
    ? SIGNAL_TABLE_SQL
    : DASHBOARD_TABLE_SQL.toLowerCase().includes(`create ${kind} ${name}`)
      ? DASHBOARD_TABLE_SQL
      : GIT_TABLE_SQL.toLowerCase().includes(`create ${kind} ${name}`)
        ? GIT_TABLE_SQL
        : COLLECTOR_TABLE_SQL;
  const expression = kind === "table"
    ? new RegExp(`create table ${name}\\s*\\([\\s\\S]*?\\);`, "i")
    : new RegExp(`create index ${name}\\s+on[\\s\\S]*?;`, "i");
  const match = source.match(expression)?.[0];
  if (!match) throw new Error(`missing ${kind} definition: ${name}`);
  return match;
}
function expectedDdl(name: string, kind: "table" | "index") { return normalizedSql(rawExpectedDdl(name, kind)); }
function currentCollectedDdl() {
  return rawExpectedDdl("dashboard_collected_1h", "table").replace("'worker', 'git'", "'worker'");
}

/** The released v11/v12/v13 layouts predate Fact producer identity and the
 * controlled-stop worker evidence.  Constructing an intermediate migration
 * state must use that real layout, rather than writing a current layout with a
 * historical marker. */
function legacyFactDdl(name: "analytics_execution_fact" | "analytics_model_call_fact") {
  return rawExpectedDdl(name, "table")
    .replace(/,\s*producer_namespace TEXT,\s*producer_id TEXT,\s*producer_generation TEXT,/, ",")
    .replace(/,\s*CHECK \(\(producer_namespace IS NULL AND producer_id IS NULL AND producer_generation IS NULL\) OR \(producer_namespace IN \('agent_worker', 'api_local_fallback'\) AND producer_id IS NOT NULL AND producer_generation IS NOT NULL\)\)/, "");
}
function legacyFactIndexDdl(name: string) { return rawExpectedDdl(name, "index").replace("producer_namespace, producer_id, producer_generation, ", ""); }

function rebuildV11SignalHistoryTables(db: AnalyticsDb) {
  const oldWorkerDdl = rawExpectedDdl("analytics_worker_event_fact", "table").replace(", 'controlled_stop'", "");
  const oldReceiptDdl = rawExpectedDdl("analytics_event_receipt", "table").replace(", 'worker_controlled_stop'", "");
  db.exec(`
    ALTER TABLE analytics_execution_fact RENAME TO v11_execution;
    ALTER TABLE analytics_model_call_fact RENAME TO v11_model;
    ALTER TABLE analytics_worker_event_fact RENAME TO v11_worker;
    ALTER TABLE analytics_event_receipt RENAME TO v11_receipt;
    DROP INDEX idx_analytics_execution_range; DROP INDEX idx_analytics_execution_open; DROP INDEX idx_analytics_execution_collected_at;
    DROP INDEX idx_analytics_model_range; DROP INDEX idx_analytics_model_open; DROP INDEX idx_analytics_model_collected_at;
    DROP INDEX idx_analytics_worker_event_range; DROP INDEX idx_analytics_worker_event_collected_at;
    DROP INDEX idx_analytics_receipt_committed_at; DROP INDEX idx_analytics_receipt_generation_sequence;
  `);
  db.exec(legacyFactDdl("analytics_execution_fact")); db.exec(legacyFactDdl("analytics_model_call_fact"));
  db.exec(oldWorkerDdl); db.exec(oldReceiptDdl);
  for (const index of ["idx_analytics_execution_range", "idx_analytics_execution_open", "idx_analytics_execution_collected_at", "idx_analytics_model_range", "idx_analytics_model_open", "idx_analytics_model_collected_at"] as const) db.exec(legacyFactIndexDdl(index));
  for (const index of ["idx_analytics_worker_event_range", "idx_analytics_worker_event_collected_at", "idx_analytics_receipt_committed_at", "idx_analytics_receipt_generation_sequence"] as const) db.exec(rawExpectedDdl(index, "index"));
  db.exec(`
    INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
      SELECT execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at FROM v11_execution;
    INSERT INTO analytics_model_call_fact (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
      SELECT model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at FROM v11_model;
    INSERT INTO analytics_worker_event_fact SELECT * FROM v11_worker;
    INSERT INTO analytics_event_receipt SELECT * FROM v11_receipt;
    DROP TABLE v11_execution; DROP TABLE v11_model; DROP TABLE v11_worker; DROP TABLE v11_receipt;
  `);
}

const COLLECTOR_TABLE_FINGERPRINTS = Object.fromEntries([
  "analytics_collector_watermark", "analytics_run_fact", "analytics_session_fact", "analytics_message_fact", "analytics_tool_fact"
].map((name) => [name, expectedDdl(name, "table")]));

const FACT_TABLE_COLUMNS: Record<string, readonly ExpectedColumn[]> = {
  analytics_collector_watermark: [
    { name: "domain", type: "TEXT", notnull: 1, pk: 1 }, { name: "initial_anchor", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "initial_floor_updated_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "initial_floor_stable_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "durable_updated_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "durable_stable_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "scan_anchor", type: "INTEGER", notnull: 0, pk: 0 }, { name: "cycle_cursor_updated_at", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "cycle_cursor_stable_id", type: "TEXT", notnull: 0, pk: 0 }, { name: "cycle_state", type: "TEXT", notnull: 1, pk: 0 },
    { name: "reconciled_through", type: "INTEGER", notnull: 0, pk: 0 }, { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }
  ],
  analytics_run_fact: [
    { name: "run_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "run_kind", type: "TEXT", notnull: 1, pk: 0 }, { name: "parent_run_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "display_status", type: "TEXT", notnull: 1, pk: 0 }, { name: "status_quality", type: "TEXT", notnull: 1, pk: 0 }, { name: "inferred_evidence_type", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "terminal_at", type: "INTEGER", notnull: 0, pk: 0 }, { name: "source_updated_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "collected_at", type: "INTEGER", notnull: 1, pk: 0 }
  ],
  analytics_session_fact: [
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "session_kind", type: "TEXT", notnull: 1, pk: 0 }, { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "source_updated_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "collected_at", type: "INTEGER", notnull: 1, pk: 0 }
  ],
  analytics_message_fact: [
    { name: "message_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "message_kind", type: "TEXT", notnull: 1, pk: 0 }, { name: "message_status", type: "TEXT", notnull: 1, pk: 0 }, { name: "origin_run_id", type: "TEXT", notnull: 0, pk: 0 }, { name: "compaction_kind", type: "TEXT", notnull: 0, pk: 0 }, { name: "compaction_source_quality", type: "TEXT", notnull: 1, pk: 0 }, { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "source_updated_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "collected_at", type: "INTEGER", notnull: 1, pk: 0 }
  ],
  analytics_tool_fact: [
    { name: "tool_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "tool_name", type: "TEXT", notnull: 0, pk: 0 }, { name: "tool_name_quality", type: "TEXT", notnull: 1, pk: 0 }, { name: "status", type: "TEXT", notnull: 1, pk: 0 }, { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "started_at", type: "INTEGER", notnull: 0, pk: 0 }, { name: "completed_at", type: "INTEGER", notnull: 0, pk: 0 }, { name: "completed_duration_ms", type: "INTEGER", notnull: 0, pk: 0 }, { name: "source_updated_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "collected_at", type: "INTEGER", notnull: 1, pk: 0 }
  ]
};

const FACT_INDEXES: Array<[string, readonly string[]]> = [
  ["analytics_run_fact_created_run_id", ["created_at", "run_id"]], ["analytics_run_fact_collected_at", ["collected_at"]],
  ["analytics_session_fact_created_session_id", ["created_at", "session_id"]], ["analytics_session_fact_collected_at", ["collected_at"]],
  ["analytics_message_fact_created_kind_status_compaction", ["created_at", "message_kind", "message_status", "compaction_kind"]], ["analytics_message_fact_collected_at", ["collected_at"]],
  ["analytics_tool_fact_created_tool_name_status", ["created_at", "tool_name", "status"]], ["analytics_tool_fact_collected_at", ["collected_at"]]
];

function expectColumns(db: AnalyticsDb, table: string, columns: readonly ExpectedColumn[]) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
  if (actual.length !== columns.length || actual.some((column, index) => {
    const expected = columns[index];
    return !expected || column.name !== expected.name || column.type.toUpperCase() !== expected.type || column.notnull !== expected.notnull || column.pk !== expected.pk;
  })) unavailableSchema();
}

function expectIndex(db: AnalyticsDb, name: string, columns: readonly string[]) {
  const actual = db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>;
  if (actual.length !== columns.length || actual.some((column, index) => column.name !== columns[index])) unavailableSchema();
  const object = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { tbl_name?: string; sql?: string } | undefined;
  if (!object?.tbl_name || normalizedSql(object.sql ?? null) !== expectedDdl(name, "index")) unavailableSchema();
  const details = db.prepare(`PRAGMA index_list(${object.tbl_name})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>;
  const detail = details.find((row) => row.name === name);
  if (!detail || detail.unique !== 0 || detail.origin !== "c" || detail.partial !== 0) unavailableSchema();
}

function expectCollectorFingerprint(db: AnalyticsDb, table: string) {
  const actual = normalizedSql((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql ?? null);
  if (actual !== COLLECTOR_TABLE_FINGERPRINTS[table]) unavailableSchema();
}

function isSafeSqliteInteger(value: unknown, storageType: unknown) {
  return storageType === "integer" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validEnabledFactDomains(raw: unknown, allowHistoricalGit = false) {
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) return false;
  const values = new Set(raw);
  const domains: readonly string[] = allowHistoricalGit ? LEGACY_FACT_DOMAINS : ANALYTICS_FACT_DOMAINS;
  return values.size === raw.length && raw.every((domain) => domains.includes(domain));
}

function expectSql(db: AnalyticsDb, table: string, fragments: readonly string[]) {
  const sql = normalizedSql((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql ?? null);
  if (fragments.some((fragment) => !sql.includes(fragment))) unavailableSchema();
}

function verifyBaseSchema(db: AnalyticsDb, expectedVersion: number, includeSourceControl = false) {
  const expectedTables = includeSourceControl ? [...BASE_TABLES, SOURCE_CONTROL_TABLE] : [...BASE_TABLES];
  const objects = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${expectedTables.map(() => "?").join(",")})`).all(...expectedTables) as SchemaObject[];
  if (objects.length !== expectedTables.length) unavailableSchema();
  const byName = new Map(objects.map((object) => [object.name, object]));
  if (expectedTables.some((table) => !byName.has(table))) unavailableSchema();
  expectColumns(db, "analytics_schema_meta", [{ name: "singleton", type: "INTEGER", notnull: 0, pk: 1 }, { name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 }]);
  expectColumns(db, "analytics_domain_state", [
    { name: "domain", type: "TEXT", notnull: 1, pk: 1 }, { name: "collection_started_at", type: "INTEGER", notnull: 0, pk: 0 }, { name: "reconciled_through", type: "INTEGER", notnull: 0, pk: 0 }, { name: "rollup_ready_through", type: "INTEGER", notnull: 0, pk: 0 }, { name: "retention_floor", type: "INTEGER", notnull: 0, pk: 0 }, { name: "status", type: "TEXT", notnull: 1, pk: 0 }, { name: "last_succeeded_at", type: "INTEGER", notnull: 0, pk: 0 }, { name: "last_error_code", type: "TEXT", notnull: 0, pk: 0 }, { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }
  ]);
  expectColumns(db, "analytics_domain_config_version", [
    { name: "collection_config_version", type: "TEXT", notnull: 1, pk: 1 }, { name: "effective_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "enabled_fact_domains_json", type: "TEXT", notnull: 1, pk: 0 }, { name: "changed_at", type: "INTEGER", notnull: 1, pk: 0 }
  ]);
  expectSql(db, "analytics_schema_meta", ["singleton integer primary key check (singleton = 1)", "schema_version integer not null"]);
  expectSql(db, "analytics_domain_state", ["domain text primary key not null", `check (domain in (${expectedList(expectedVersion >= ANALYTICS_SCHEMA_VERSION ? ANALYTICS_DOMAINS : LEGACY_ANALYTICS_DOMAINS)}))`, `check (status in (${DOMAIN_STATUS_SQL.toLowerCase()}))`, "updated_at integer not null"]);
  expectSql(db, "analytics_domain_config_version", ["collection_config_version text primary key not null", "effective_at integer not null", "enabled_fact_domains_json text not null", "changed_at integer not null"]);
  if (includeSourceControl) {
    expectColumns(db, SOURCE_CONTROL_TABLE, [
      { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 }, { name: "source_config_version", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "effective_at", type: "INTEGER", notnull: 1, pk: 0 }, { name: "content_hash", type: "TEXT", notnull: 1, pk: 0 },
      { name: "canonical_content", type: "TEXT", notnull: 1, pk: 0 },
    ]);
    expectSql(db, SOURCE_CONTROL_TABLE, ["singleton integer primary key check (singleton = 1)", "source_config_version integer not null", "effective_at integer not null", "content_hash text not null", "canonical_content text not null"]);
    const rows = db.prepare(`SELECT singleton, typeof(singleton) AS singleton_type, source_config_version, typeof(source_config_version) AS version_type, effective_at, typeof(effective_at) AS effective_type, content_hash, typeof(content_hash) AS hash_type, canonical_content, typeof(canonical_content) AS content_type FROM ${SOURCE_CONTROL_TABLE}`).all() as Array<Record<string, unknown>>;
    if (rows.length > 1 || rows.some((row) => row.singleton !== 1 || row.singleton_type !== "integer" || !isSafeSqliteInteger(row.source_config_version, row.version_type) || Number(row.source_config_version) < 1 || !isSafeSqliteInteger(row.effective_at, row.effective_type) || row.hash_type !== "text" || typeof row.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.content_hash) || row.content_type !== "text" || typeof row.canonical_content !== "string")) unavailableSchema();
  }

  const meta = db.prepare("SELECT singleton, typeof(singleton) AS singleton_type, schema_version, typeof(schema_version) AS schema_version_type FROM analytics_schema_meta").all() as Array<Record<string, unknown>>;
  if (meta.length !== 1 || !isSafeSqliteInteger(meta[0]?.singleton, meta[0]?.singleton_type) || meta[0]?.singleton !== 1 || !isSafeSqliteInteger(meta[0]?.schema_version, meta[0]?.schema_version_type) || meta[0]?.schema_version !== expectedVersion) unavailableSchema();
  const domains = db.prepare(`SELECT domain, typeof(domain) AS domain_type, status, typeof(status) AS status_type, collection_started_at, typeof(collection_started_at) AS collection_started_at_type, reconciled_through, typeof(reconciled_through) AS reconciled_through_type, rollup_ready_through, typeof(rollup_ready_through) AS rollup_ready_through_type, retention_floor, typeof(retention_floor) AS retention_floor_type, last_succeeded_at, typeof(last_succeeded_at) AS last_succeeded_at_type, last_error_code, typeof(last_error_code) AS last_error_code_type, updated_at, typeof(updated_at) AS updated_at_type FROM analytics_domain_state`).all() as Array<Record<string, unknown>>;
  const domainSet = new Set(domains.map((row) => row.domain));
  const expectedDomains: readonly string[] = expectedVersion >= ANALYTICS_SCHEMA_VERSION ? ANALYTICS_DOMAINS : LEGACY_ANALYTICS_DOMAINS;
  if (domains.length !== expectedDomains.length || domainSet.size !== expectedDomains.length || expectedDomains.some((domain) => !domainSet.has(domain))) unavailableSchema();
  for (const row of domains) {
    if (row.domain_type !== "text" || typeof row.domain !== "string" || row.status_type !== "text" || typeof row.status !== "string" || !DOMAIN_STATUSES.includes(row.status as typeof DOMAIN_STATUSES[number])) unavailableSchema();
    for (const field of ["collection_started_at", "reconciled_through", "rollup_ready_through", "retention_floor", "last_succeeded_at"] as const) if (row[field] !== null && !isSafeSqliteInteger(row[field], row[`${field}_type`])) unavailableSchema();
    if (row.last_error_code !== null && (row.last_error_code_type !== "text" || typeof row.last_error_code !== "string")) unavailableSchema();
    if (!isSafeSqliteInteger(row.updated_at, row.updated_at_type)) unavailableSchema();
  }
  const configs = db.prepare("SELECT collection_config_version, typeof(collection_config_version) AS version_type, effective_at, typeof(effective_at) AS effective_type, enabled_fact_domains_json, typeof(enabled_fact_domains_json) AS enabled_type, changed_at, typeof(changed_at) AS changed_type FROM analytics_domain_config_version").all() as Array<Record<string, unknown>>;
  if (configs.length === 0 || configs.some((row) => {
    if (row.version_type !== "text" || typeof row.collection_config_version !== "string" || row.collection_config_version.length === 0 || !isSafeSqliteInteger(row.effective_at, row.effective_type) || !isSafeSqliteInteger(row.changed_at, row.changed_type) || row.enabled_type !== "text" || typeof row.enabled_fact_domains_json !== "string") return true;
    try { return !validEnabledFactDomains(JSON.parse(row.enabled_fact_domains_json), expectedVersion < ANALYTICS_SCHEMA_VERSION); } catch { return true; }
  })) unavailableSchema();
  if (expectedVersion >= V17_SCHEMA_VERSION) {
    const baseline = configs.filter((row) =>
      row.collection_config_version === "0000000000000000" &&
      row.effective_at === 0 && row.changed_at === 0,
    );
    if (baseline.length !== 1 || configs.some((row) => !/^\d{16}$/.test(row.collection_config_version as string))) unavailableSchema();
  }
  if (expectedVersion >= 17 && configs.some((row) =>
    row.collection_config_version === "0000000000000000" &&
    row.enabled_fact_domains_json !== "[]",
  )) unavailableSchema();
}

function verifyFacts(db: AnalyticsDb) {
  for (const [table, columns] of Object.entries(FACT_TABLE_COLUMNS)) expectColumns(db, table, columns);
  for (const [name, columns] of FACT_INDEXES) expectIndex(db, name, columns);
  for (const table of Object.keys(COLLECTOR_TABLE_FINGERPRINTS)) expectCollectorFingerprint(db, table);

  const watermarks = db.prepare("SELECT *, typeof(domain) AS domain_type, typeof(initial_anchor) AS initial_anchor_type, typeof(initial_floor_updated_at) AS initial_floor_updated_at_type, typeof(initial_floor_stable_id) AS initial_floor_stable_id_type, typeof(durable_updated_at) AS durable_updated_at_type, typeof(durable_stable_id) AS durable_stable_id_type, typeof(scan_anchor) AS scan_anchor_type, typeof(cycle_cursor_updated_at) AS cycle_cursor_updated_at_type, typeof(cycle_cursor_stable_id) AS cycle_cursor_stable_id_type, typeof(cycle_state) AS cycle_state_type, typeof(reconciled_through) AS reconciled_through_type, typeof(updated_at) AS updated_at_type FROM analytics_collector_watermark").all() as Array<Record<string, unknown>>;
  for (const row of watermarks) {
    if (row.domain_type !== "text" || !BUSINESS_COLLECTOR_DOMAINS.includes(row.domain as typeof BUSINESS_COLLECTOR_DOMAINS[number]) || row.initial_floor_stable_id_type !== "text" || typeof row.initial_floor_stable_id !== "string" || row.durable_stable_id_type !== "text" || typeof row.durable_stable_id !== "string" || row.cycle_state_type !== "text" || !["idle", "scanning"].includes(row.cycle_state as string)) unavailableSchema();
    for (const field of ["initial_anchor", "initial_floor_updated_at", "durable_updated_at", "updated_at"] as const) if (!isSafeSqliteInteger(row[field], row[`${field}_type`])) unavailableSchema();
    for (const field of ["scan_anchor", "cycle_cursor_updated_at", "reconciled_through"] as const) if (row[field] !== null && !isSafeSqliteInteger(row[field], row[`${field}_type`])) unavailableSchema();
    const scanning = row.cycle_state === "scanning";
    if (scanning !== (row.scan_anchor !== null && row.cycle_cursor_updated_at !== null && row.cycle_cursor_stable_id !== null) || (row.cycle_cursor_stable_id !== null && (row.cycle_cursor_stable_id_type !== "text" || typeof row.cycle_cursor_stable_id !== "string"))) unavailableSchema();
  }
  verifyFactRows(db, "analytics_run_fact", ["run_id", "run_kind", "parent_run_id", "display_status", "status_quality", "inferred_evidence_type"], ["created_at", "terminal_at", "source_updated_at", "collected_at"]);
  verifyFactRows(db, "analytics_session_fact", ["session_id", "session_kind"], ["created_at", "source_updated_at", "collected_at"]);
  verifyFactRows(db, "analytics_message_fact", ["message_id", "message_kind", "message_status", "origin_run_id", "compaction_kind", "compaction_source_quality"], ["created_at", "source_updated_at", "collected_at"]);
  verifyFactRows(db, "analytics_tool_fact", ["tool_id", "tool_name", "tool_name_quality", "status"], ["created_at", "started_at", "completed_at", "completed_duration_ms", "source_updated_at", "collected_at"]);
  verifyFactEnumValues(db);
}

function verifyFactEnumValues(db: AnalyticsDb) {
  const runKinds = new Set(["user", "manual_compaction", "subtask"]);
  const runStatuses = new Set(["running", "completed", "failed", "cancelled", "interrupted", "unknown"]);
  const qualities = new Set(["observed", "inferred"]);
  for (const row of db.prepare("SELECT run_kind, display_status, status_quality FROM analytics_run_fact").all() as Array<{ run_kind: string; display_status: string; status_quality: string }>) {
    if (!runKinds.has(row.run_kind) || !runStatuses.has(row.display_status) || !qualities.has(row.status_quality)) unavailableSchema();
  }
  for (const row of db.prepare("SELECT session_kind FROM analytics_session_fact").all() as Array<{ session_kind: string }>) if (row.session_kind !== "primary" && row.session_kind !== "subtask") unavailableSchema();
  const messageKinds = new Set(["user", "assistant", "runtime", "system", "compaction"]);
  const messageStatuses = new Set(["streaming", "completed", "failed", "cancelled", "superseded"]);
  for (const row of db.prepare("SELECT message_kind, message_status, compaction_kind, compaction_source_quality FROM analytics_message_fact").all() as Array<{ message_kind: string; message_status: string; compaction_kind: string | null; compaction_source_quality: string }>) {
    if (!messageKinds.has(row.message_kind) || !messageStatuses.has(row.message_status) || !["known", "unknown", "not_applicable"].includes(row.compaction_source_quality)) unavailableSchema();
    if ((row.compaction_kind !== null && (!["manual", "auto"].includes(row.compaction_kind) || row.compaction_source_quality !== "known")) || (row.compaction_kind === null && !["unknown", "not_applicable"].includes(row.compaction_source_quality))) unavailableSchema();
  }
  const toolStatuses = new Set(["queued", "running", "completed", "failed", "cancelled", "unknown"]);
  for (const row of db.prepare("SELECT tool_name, tool_name_quality, status, started_at, completed_at, completed_duration_ms FROM analytics_tool_fact").all() as Array<{ tool_name: string | null; tool_name_quality: string; status: string; started_at: number | null; completed_at: number | null; completed_duration_ms: number | null }>) {
    if (!toolStatuses.has(row.status) || !["known", "unavailable"].includes(row.tool_name_quality) || (row.tool_name === null) !== (row.tool_name_quality === "unavailable")) unavailableSchema();
    if (row.completed_duration_ms !== null && (row.status !== "completed" || row.started_at === null || row.completed_at === null || row.completed_at < row.started_at || row.completed_duration_ms !== row.completed_at - row.started_at)) unavailableSchema();
  }
}

/** Validate the only v5 layout that is eligible for the explicit v6 migration. */
function verifyV5SignalSchema(db: AnalyticsDb) {
  const currentSlot = expectedDdl("analytics_producer_slot", "table");
  const v5Slot = currentSlot.replace(" config_version text not null,", "");
  const currentReceipt = expectedDdl("analytics_event_receipt", "table");
  const v5Receipt = currentReceipt.replace("'worker_snapshot', 'worker_restart_attempted', 'worker_restart_succeeded', 'worker_restart_failed',", "'worker_restart',");
  for (const [name, expected] of [["analytics_producer_slot", v5Slot], ["analytics_event_receipt", v5Receipt]] as const) {
    const actual = normalizedSql((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql?: string } | undefined)?.sql ?? null);
    if (actual !== expected) unavailableSchema();
  }
  for (const table of ["analytics_producer_generation", "analytics_producer_checkpoint", "analytics_signal_coverage_gap", "analytics_execution_fact", "analytics_model_call_fact", "analytics_worker_event_fact", "analytics_worker_live_snapshot"]) {
    const actual = normalizedSql((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql?: string } | undefined)?.sql ?? null);
    if (actual !== expectedDdl(table, "table")) unavailableSchema();
  }
}

function verifyFactRows(db: AnalyticsDb, table: string, textFields: readonly string[], integerFields: readonly string[]) {
  const projection = [...textFields.map((field) => `${field}, typeof(${field}) AS ${field}_type`), ...integerFields.map((field) => `${field}, typeof(${field}) AS ${field}_type`)].join(", ");
  const rows = db.prepare(`SELECT ${projection} FROM ${table}`).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    if (textFields.some((field) => row[field] !== null && (row[`${field}_type`] !== "text" || typeof row[field] !== "string"))) unavailableSchema();
    if (integerFields.some((field) => row[field] !== null && !isSafeSqliteInteger(row[field], row[`${field}_type`]))) unavailableSchema();
  }
}

function verifySignalSchema(db: AnalyticsDb, includeCollectedAtIndexes = true, legacyWorkerEvents = false, legacyFactIdentity = false, legacyReceiptEvents = false, legacyExecutionEndQuality = false) {
  const required = ["analytics_producer_slot", "analytics_producer_generation", "analytics_producer_checkpoint", "analytics_event_receipt", "analytics_signal_coverage_gap", "analytics_execution_fact", "analytics_model_call_fact", "analytics_worker_event_fact", "analytics_worker_live_snapshot"];
  for (const table of required) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as SchemaObject | undefined;
    const expected = table === "analytics_worker_event_fact" && legacyWorkerEvents
      ? expectedDdl(table, "table").replace(", 'controlled_stop'", "")
      : table === "analytics_event_receipt" && legacyReceiptEvents
        ? expectedDdl(table, "table").replace(", 'worker_controlled_stop'", "")
        : expectedDdl(table, "table");
    if (legacyExecutionEndQuality && table === "analytics_execution_fact") {
      const actual = normalizedSql(row?.sql ?? null);
      const v17 = actual.includes("end_time_quality text not null check (end_time_quality in ('observed', 'unknown'))") && actual.includes("end_reason text check (end_reason in ('completed', 'failed', 'cancelled', 'timed_out', 'other'))");
      const relabelledCurrent = actual === expected;
      if (!v17 && !relabelledCurrent) unavailableSchema();
      continue;
    }
    const legacyExpected = legacyFactIdentity && table === "analytics_execution_fact"
      ? expected.replace(", producer_namespace text, producer_id text, producer_generation text", "").replace(", check ((producer_namespace is null and producer_id is null and producer_generation is null) or (producer_namespace in ('agent_worker', 'api_local_fallback') and producer_id is not null and producer_generation is not null))", "")
      : legacyFactIdentity && table === "analytics_model_call_fact"
        ? expected.replace(", producer_namespace text, producer_id text, producer_generation text", "").replace(", check ((producer_namespace is null and producer_id is null and producer_generation is null) or (producer_namespace in ('agent_worker', 'api_local_fallback') and producer_id is not null and producer_generation is not null))", "")
        : expected;
    if (!row?.sql || normalizedSql(row.sql) !== legacyExpected) unavailableSchema();
  }
  const indexes = ["idx_analytics_receipt_committed_at", "idx_analytics_receipt_generation_sequence", "idx_analytics_checkpoint_domain_received", "idx_analytics_generation_lifecycle", "idx_analytics_gap_slot_range", "idx_analytics_execution_range", "idx_analytics_execution_open", "idx_analytics_model_range", "idx_analytics_model_open", "idx_analytics_worker_event_range"];
  if (includeCollectedAtIndexes) indexes.push("idx_analytics_execution_collected_at", "idx_analytics_model_collected_at", "idx_analytics_worker_event_collected_at");
  for (const index of indexes) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) as SchemaObject | undefined;
    const expected = legacyFactIdentity && index === "idx_analytics_execution_open" ? expectedDdl(index, "index").replace("producer_namespace, producer_id, producer_generation, ", "")
      : legacyFactIdentity && index === "idx_analytics_model_open" ? expectedDdl(index, "index").replace("producer_namespace, producer_id, producer_generation, ", "")
        : expectedDdl(index, "index");
    if (!row?.sql || normalizedSql(row.sql) !== expected) unavailableSchema();
  }
  verifySignalRows(db);
}

function migrateV9ToV10(db: AnalyticsDb) {
  db.transaction(() => {
    db.exec(`${rawExpectedDdl("idx_analytics_execution_collected_at", "index")}
      ${rawExpectedDdl("idx_analytics_model_collected_at", "index")}
      ${rawExpectedDdl("idx_analytics_worker_event_collected_at", "index")}
      ${rawExpectedDdl("dashboard_model_dimension_1h", "table")}
      ${rawExpectedDdl("dashboard_model_dimension_1h_bucket", "index")}`);
    // v9 markers certify the old, non-dimensional Model aggregate only.
    // Never permit them to authorize a newly introduced dimensional cache.
    db.prepare(`INSERT INTO analytics_dirty_hour(domain,bucket_start,marked_at)
      SELECT 'model',bucket_start,? FROM analytics_rollup_hour WHERE domain='model'
      ON CONFLICT(domain,bucket_start) DO UPDATE SET marked_at=excluded.marked_at`).run(Date.now());
    db.prepare("DELETE FROM analytics_rollup_hour WHERE domain='model'").run();
    db.prepare("UPDATE analytics_domain_state SET rollup_ready_through=NULL WHERE domain='model'").run();
    db.prepare("UPDATE analytics_schema_meta SET schema_version = 10 WHERE singleton = 1").run();
  })();
}

function migrateV10ToV11(db: AnalyticsDb) {
  db.transaction(() => {
    db.exec("DROP TABLE dashboard_message_1h;");
    db.exec(rawExpectedDdl("dashboard_message_1h", "table"));
    // The former table could not distinguish an unknown compaction source.
    db.prepare(`INSERT INTO analytics_dirty_hour(domain,bucket_start,marked_at)
      SELECT 'message',bucket_start,? FROM analytics_rollup_hour WHERE domain='message'
      ON CONFLICT(domain,bucket_start) DO UPDATE SET marked_at=excluded.marked_at`).run(Date.now());
    db.prepare("DELETE FROM analytics_rollup_hour WHERE domain='message'").run();
    db.prepare("UPDATE analytics_domain_state SET rollup_ready_through=NULL WHERE domain='message'").run();
    rebuildV11SignalHistoryTables(db);
    db.prepare("UPDATE analytics_schema_meta SET schema_version = 11 WHERE singleton = 1").run();
  })();
}

function migrateV16ToV17(db: AnalyticsDb, testFaultAt?: "after_empty_baseline") {
  db.transaction(() => {
    const result = db.prepare(
      "UPDATE analytics_domain_config_version SET enabled_fact_domains_json='[]' WHERE collection_config_version='0000000000000000' AND effective_at=0 AND changed_at=0",
    ).run();
    if (result.changes !== 1) throw new Error("missing v16 numeric config baseline");
    if (testFaultAt === "after_empty_baseline") throw new Error("injected v17 migration failure");
    db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(V17_SCHEMA_VERSION);
  })();
}

function migrateV17ToV18(db: AnalyticsDb, testFaultAt?: "after_execution_rebuild") {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE analytics_execution_fact RENAME TO v17_analytics_execution_fact;
      DROP INDEX idx_analytics_execution_range;
      DROP INDEX idx_analytics_execution_open;
      DROP INDEX idx_analytics_execution_collected_at;
    `);
    db.exec(rawExpectedDdl("analytics_execution_fact", "table"));
    for (const index of ["idx_analytics_execution_range", "idx_analytics_execution_open", "idx_analytics_execution_collected_at"] as const)
      db.exec(rawExpectedDdl(index, "index"));
    db.exec(`INSERT INTO analytics_execution_fact
      (execution_id,run_id,runtime_kind,producer_namespace,producer_id,producer_generation,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
      SELECT execution_id,run_id,runtime_kind,producer_namespace,producer_id,producer_generation,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at
      FROM v17_analytics_execution_fact;
      DROP TABLE v17_analytics_execution_fact;`);
    if (testFaultAt === "after_execution_rebuild") throw new Error("injected v18 migration failure");
    db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(V18_SCHEMA_VERSION);
  })();
}

/** Retain every non-Git Fact, waterline and historical configuration version. */
function migrateV18ToV19(db: AnalyticsDb, testFaultAt?: "after_collected_rebuild") {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE dashboard_collected_1h RENAME TO v18_dashboard_collected_1h;
      DROP INDEX dashboard_collected_1h_bucket;
      ${currentCollectedDdl()}
      INSERT INTO dashboard_collected_1h(bucket_start,domain,fact_count)
        SELECT bucket_start,domain,fact_count FROM v18_dashboard_collected_1h WHERE domain <> 'git';
      DROP TABLE v18_dashboard_collected_1h;
      ${rawExpectedDdl("dashboard_collected_1h_bucket", "index")}
    `);
    if (testFaultAt === "after_collected_rebuild") throw new Error("injected v19 migration failure");

    db.exec(`
      ALTER TABLE analytics_domain_state RENAME TO v18_analytics_domain_state;
      CREATE TABLE analytics_domain_state (
        domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN (${expectedList(ANALYTICS_DOMAINS)})), collection_started_at INTEGER,
        reconciled_through INTEGER, rollup_ready_through INTEGER, retention_floor INTEGER,
        status TEXT NOT NULL CHECK (status IN (${DOMAIN_STATUS_SQL})), last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO analytics_domain_state
        SELECT * FROM v18_analytics_domain_state WHERE domain <> 'git';
      DROP TABLE v18_analytics_domain_state;
      DROP TABLE analytics_git_membership;
      DROP TABLE analytics_git_commit_fact;
      DROP TABLE analytics_git_repo_state;
      DROP TABLE analytics_git_scan;
      DELETE FROM analytics_dirty_hour WHERE domain='git';
      DELETE FROM analytics_rollup_hour WHERE domain='git';
      DELETE FROM analytics_signal_coverage_gap WHERE domain='git';
    `);
    // Historic versions retain their real effective times and identifiers;
    // only the now-retired domain is removed from their composition. The
    // source-control hash is a historical receipt and must not be rewritten.
    const historical = db.prepare("SELECT collection_config_version,enabled_fact_domains_json FROM analytics_domain_config_version").all() as Array<{ collection_config_version: string; enabled_fact_domains_json: string }>;
    const update = db.prepare("UPDATE analytics_domain_config_version SET enabled_fact_domains_json=? WHERE collection_config_version=?");
    for (const row of historical) {
      const domains = JSON.parse(row.enabled_fact_domains_json) as string[];
      if (domains.includes("git")) update.run(JSON.stringify(domains.filter((domain) => domain !== "git")), row.collection_config_version);
    }
    db.prepare("UPDATE analytics_schema_meta SET schema_version=? WHERE singleton=1").run(ANALYTICS_SCHEMA_VERSION);
  })();
}

/**
 * SQLite affinity can still store malformed values when a database was edited
 * outside this process. DDL fingerprints protect future writes; these checks
 * fail closed for persisted generation and Fact state before WAL is enabled.
 */
function verifySignalRows(db: AnalyticsDb) {
  const integerFields: Record<string, readonly string[]> = {
    analytics_producer_slot: ["expected_enabled", "updated_at"],
    analytics_producer_generation: ["final_sequence", "committed_sequence", "max_observed_at", "earliest_open_started_at", "known_drop", "dropped_since_sequence", "outbox_pending", "oldest_pending_at", "loss_epoch", "control_sequence", "last_control_received_at", "created_at"],
    analytics_producer_checkpoint: ["last_sequence", "max_observed_at", "earliest_open_started_at", "open_execution_count", "open_model_count", "known_drop", "dropped_since_sequence", "outbox_pending", "oldest_pending_at", "loss_epoch", "control_sequence", "received_at"],
    analytics_event_receipt: ["sequence", "payload_version", "received_at", "committed_at"],
    analytics_signal_coverage_gap: ["gap_from", "gap_to", "dropped_since_sequence", "recorded_at", "closed_at"],
    analytics_execution_fact: ["queued_at", "started_at", "ended_at", "effective_ended_at", "observed_at", "updated_at", "collected_at"],
    analytics_model_call_fact: ["attempt_no", "started_at", "ended_at", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens", "cache_comparable", "cache_write_verified", "observed_at", "updated_at", "collected_at"],
    analytics_worker_event_fact: ["occurred_at", "collected_at"],
    analytics_worker_live_snapshot: ["snapshot_at", "active_count", "queue_length", "concurrency", "last_ready_at", "received_at"]
  };
  const textFields: Record<string, readonly string[]> = {
    analytics_producer_slot: ["domain", "producer_namespace", "producer_id", "config_version"],
    analytics_producer_generation: ["domain", "producer_namespace", "producer_id", "producer_generation", "lifecycle"],
    analytics_producer_checkpoint: ["domain", "producer_namespace", "producer_id", "producer_generation"],
    analytics_event_receipt: ["event_id", "producer_namespace", "producer_id", "producer_generation", "event_type", "subject_identity", "fingerprint"],
    analytics_signal_coverage_gap: ["gap_id", "domain", "producer_namespace", "producer_id", "producer_generation", "cause"],
    analytics_execution_fact: ["execution_id", "run_id", "runtime_kind", "run_kind", "parent_run_id", "status", "end_time_quality", "end_reason"],
    analytics_model_call_fact: ["model_call_id", "execution_id", "run_id", "provider_id", "model_id", "status", "completion_quality", "timeout_kind", "total_source", "failure_kind"],
    analytics_worker_event_fact: ["event_id", "event_type", "restart_attempt_id", "runner_mode"],
    analytics_worker_live_snapshot: ["runner_mode"]
  };
  for (const [table, fields] of Object.entries(integerFields)) {
    const text = textFields[table] ?? [];
    const projection = [...fields, ...text].map((field) => `${field}, typeof(${field}) AS ${field}_type`).join(", ");
    for (const row of db.prepare(`SELECT ${projection} FROM ${table}`).all() as Array<Record<string, unknown>>) {
      if (fields.some((field) => row[field] !== null && !isSafeSqliteInteger(row[field], row[`${field}_type`]))) unavailableSchema();
      if (text.some((field) => row[field] !== null && (row[`${field}_type`] !== "text" || typeof row[field] !== "string"))) unavailableSchema();
    }
  }
  for (const row of db.prepare("SELECT lifecycle, final_sequence, committed_sequence, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at FROM analytics_producer_generation").all() as Array<GenerationValidationRow>) {
    if (!['registered', 'closing', 'closed', 'stale', 'abandoned'].includes(row.lifecycle) || (row.final_sequence !== null && row.committed_sequence > row.final_sequence) || (row.known_drop === 0) !== (row.dropped_since_sequence === null) || (row.outbox_pending === 0) !== (row.oldest_pending_at === null)) unavailableSchema();
  }
  for (const row of db.prepare("SELECT status, end_time_quality, ended_at, effective_ended_at, end_reason FROM analytics_execution_fact").all() as Array<{ status: string; end_time_quality: string; ended_at: number | null; effective_ended_at: number | null; end_reason: string | null }>) {
    const hasTerminalTimes = row.ended_at !== null && row.effective_ended_at !== null;
    const hasNoTerminalTimes = row.ended_at === null && row.effective_ended_at === null;
    const knownEnded = row.status === "ended" && ["observed", "inferred"].includes(row.end_time_quality) && hasTerminalTimes && row.end_reason !== null;
    const unknownEnded = row.status === "ended" && row.end_time_quality === "unknown" && hasNoTerminalTimes && row.end_reason === "worker_exit";
    const open = ["queued", "running"].includes(row.status) && row.end_time_quality === "unknown" && hasNoTerminalTimes && row.end_reason === null;
    if (!knownEnded && !unknownEnded && !open) unavailableSchema();
  }
}

type GenerationValidationRow = { lifecycle: string; final_sequence: number | null; committed_sequence: number; known_drop: number; dropped_since_sequence: number | null; outbox_pending: number; oldest_pending_at: number | null };

function verifyDashboardSchema(db: AnalyticsDb, includeGit = true) {
  verifyDashboardSchemaNames(db, ["analytics_dirty_hour", "dashboard_model_1h", "dashboard_model_dimension_1h", "dashboard_tool_1h", "dashboard_message_1h", "dashboard_collected_1h", "analytics_rollup_hour", "analytics_maintenance_state"], ["analytics_dirty_hour_domain_bucket", "analytics_rollup_hour_domain_bucket", "dashboard_model_dimension_1h_bucket", "dashboard_collected_1h_bucket"], includeGit);
}

function verifyV9DashboardSchema(db: AnalyticsDb) {
  verifyDashboardSchemaNames(db, ["analytics_dirty_hour", "dashboard_model_1h", "dashboard_tool_1h", "dashboard_collected_1h", "analytics_rollup_hour", "analytics_maintenance_state"], ["analytics_dirty_hour_domain_bucket", "analytics_rollup_hour_domain_bucket", "dashboard_collected_1h_bucket"]);
  verifyOldMessageRollupSchema(db);
}

function verifyOldMessageRollupSchema(db: AnalyticsDb) {
  const oldMessageDdl = expectedDdl("dashboard_message_1h", "table")
    .replace(", compaction_source_quality text not null check (compaction_source_quality in ('known', 'unknown', 'not_applicable'))", "")
    .replace(", compaction_source_quality)", ")");
  const message = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='dashboard_message_1h'").get() as SchemaObject | undefined;
  if (!message?.sql || normalizedSql(message.sql) !== oldMessageDdl) unavailableSchema();
}

function verifyDashboardSchemaNames(db: AnalyticsDb, tables: readonly string[], indexes: readonly string[], includeGit = true) {
  for (const table of tables) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== (!includeGit && table === "dashboard_collected_1h" ? normalizedSql(currentCollectedDdl()) : expectedDdl(table, "table"))) unavailableSchema();
  }
  for (const index of indexes) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(index, "index")) unavailableSchema();
  }
}

function verifyV8Schema(db: AnalyticsDb) {
  verifyBaseSchema(db, 8);
  verifyFacts(db);
  const oldModel = expectedDdl("analytics_model_call_fact", "table").replace(", check ((status = 'running' and completion_quality = 'unknown') or status != 'running')", "");
  const actualModel = normalizedSql((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_model_call_fact'").get() as SchemaObject | undefined)?.sql ?? null);
  if (actualModel !== oldModel && actualModel !== expectedDdl("analytics_model_call_fact", "table")) unavailableSchema();
  for (const table of ["analytics_producer_slot", "analytics_producer_generation", "analytics_producer_checkpoint", "analytics_event_receipt", "analytics_signal_coverage_gap", "analytics_execution_fact", "analytics_worker_event_fact", "analytics_worker_live_snapshot"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(table, "table")) unavailableSchema();
  }
  verifySignalRows(db);
}

function verifyV7Schema(db: AnalyticsDb) {
  verifyBaseSchema(db, 7);
  verifyFacts(db);
  verifySignalSchema(db, false);
}

function verifyV9Schema(db: AnalyticsDb) {
  verifyBaseSchema(db, 9);
  verifyFacts(db);
  for (const table of ["analytics_producer_slot", "analytics_producer_generation", "analytics_producer_checkpoint", "analytics_event_receipt", "analytics_signal_coverage_gap", "analytics_execution_fact", "analytics_model_call_fact", "analytics_worker_event_fact", "analytics_worker_live_snapshot"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(table, "table")) throw new Error(`signal table ${table}`);
  }
  for (const index of ["idx_analytics_receipt_committed_at", "idx_analytics_receipt_generation_sequence", "idx_analytics_checkpoint_domain_received", "idx_analytics_generation_lifecycle", "idx_analytics_gap_slot_range", "idx_analytics_execution_range", "idx_analytics_execution_open", "idx_analytics_model_range", "idx_analytics_model_open", "idx_analytics_worker_event_range"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(index, "index")) unavailableSchema();
  }
  verifySignalRows(db);
  verifyV9DashboardSchema(db);
}

function verifyV10Schema(db: AnalyticsDb) {
  verifyBaseSchema(db, 10);
  verifyFacts(db);
  verifySignalSchema(db);
  for (const table of ["analytics_dirty_hour", "dashboard_model_1h", "dashboard_model_dimension_1h", "dashboard_tool_1h", "dashboard_collected_1h", "analytics_rollup_hour", "analytics_maintenance_state"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(table, "table")) unavailableSchema();
  }
  verifyOldMessageRollupSchema(db);
  for (const index of ["analytics_dirty_hour_domain_bucket", "analytics_rollup_hour_domain_bucket", "dashboard_model_dimension_1h_bucket", "dashboard_collected_1h_bucket"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(index, "index")) unavailableSchema();
  }
}

function verifyGitSchema(db: AnalyticsDb) {
  for (const table of ["analytics_git_scan", "analytics_git_commit_fact", "analytics_git_membership", "analytics_git_repo_state"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(table, "table")) unavailableSchema();
  }
  for (const index of ["analytics_git_commit_repo_committed", "analytics_git_commit_collected_at", "analytics_git_membership_current", "analytics_git_scan_repo_state"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(index, "index")) unavailableSchema();
  }
}
function verifyCurrentSchema(db: AnalyticsDb) {
  verifyBaseSchema(db, ANALYTICS_SCHEMA_VERSION, true);
  verifyFacts(db);
  verifySignalSchema(db);
  verifyDashboardSchema(db, false);
  const oldTables = db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'analytics_git_*' AND type IN ('table','index')").all();
  if (oldTables.length !== 0) unavailableSchema();
}

function verifyV3Schema(db: AnalyticsDb) {
  verifyBaseSchema(db, 3);
  verifyFacts(db);
}

function hasLegacyV3Watermark(db: AnalyticsDb) {
  const columns: readonly ExpectedColumn[] = [
    { name: "domain", type: "TEXT", notnull: 1, pk: 1 }, { name: "cursor_updated_at", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "cursor_stable_id", type: "TEXT", notnull: 1, pk: 0 }, { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }
  ];
  const actual = db.prepare("PRAGMA table_info(analytics_collector_watermark)").all() as TableColumn[];
  if (actual.length !== columns.length || actual.some((column, index) => column.name !== columns[index]?.name)) return false;
  // A same-version database is only eligible for this destructive cache reset
  // when it is precisely the former collector shape, not merely a table with
  // conveniently similar column names.
  expectColumns(db, "analytics_collector_watermark", columns);
  expectSql(db, "analytics_collector_watermark", ["domain text primary key", "cursor_updated_at integer not null", "cursor_stable_id text not null", "updated_at integer not null"]);
  for (const [table, expected] of Object.entries(FACT_TABLE_COLUMNS).filter(([table]) => table !== "analytics_collector_watermark")) expectColumns(db, table, expected);
  verifyFactRows(db, "analytics_run_fact", ["run_id", "run_kind", "parent_run_id", "display_status", "status_quality", "inferred_evidence_type"], ["created_at", "terminal_at", "source_updated_at", "collected_at"]);
  verifyFactRows(db, "analytics_session_fact", ["session_id", "session_kind"], ["created_at", "source_updated_at", "collected_at"]);
  verifyFactRows(db, "analytics_message_fact", ["message_id", "message_kind", "message_status", "origin_run_id", "compaction_kind", "compaction_source_quality"], ["created_at", "source_updated_at", "collected_at"]);
  verifyFactRows(db, "analytics_tool_fact", ["tool_id", "tool_name", "tool_name_quality", "status"], ["created_at", "started_at", "completed_at", "completed_duration_ms", "source_updated_at", "collected_at"]);
  verifyFactEnumValues(db);
  return true;
}

function verifyV6SignalSchema(db: AnalyticsDb) {
  verifyBaseSchema(db, 6);
  verifyFacts(db);
  // v6 differs from v7 solely by the two control_sequence columns. Compare
  // the complete prior DDL derived from the v7 authority, rather than accepting
  // an arbitrary version-labelled database before migration.
  for (const table of ["analytics_producer_generation", "analytics_producer_checkpoint"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as SchemaObject | undefined;
    const expected = expectedDdl(table, "table").replace(/,\s*control_sequence integer not null(?: default 1)? check \(control_sequence >= 1\)/, "");
    if (!row?.sql || normalizedSql(row.sql) !== expected) unavailableSchema();
  }
  for (const table of ["analytics_producer_slot", "analytics_event_receipt", "analytics_signal_coverage_gap", "analytics_execution_fact", "analytics_model_call_fact", "analytics_worker_event_fact", "analytics_worker_live_snapshot"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as SchemaObject | undefined;
    if (!row?.sql || normalizedSql(row.sql) !== expectedDdl(table, "table")) unavailableSchema();
  }
}

function inspectSchema(db: AnalyticsDb): "new" | "v2" | "v3" | "legacy-v3" | "v4" | "v5" | "v6" | "v7" | "v8" | "v9" | "v10" | "v11" | "v12" | "v13" | "v14" | "v15" | "v16" | "v17" | "v18" | "current" {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') LIMIT 1").all().length === 0) return "new";
  const meta = db.prepare("SELECT schema_version, typeof(schema_version) AS storage_type FROM analytics_schema_meta").all() as Array<{ schema_version: unknown; storage_type: unknown }>;
  if (meta.length !== 1 || !isSafeSqliteInteger(meta[0]?.schema_version, meta[0]?.storage_type)) unavailableSchema();
  if (meta[0]?.schema_version === 2) { verifyBaseSchema(db, 2); return "v2"; }
  if (meta[0]?.schema_version === 3 && hasLegacyV3Watermark(db)) { verifyBaseSchema(db, 3); return "legacy-v3"; }
  if (meta[0]?.schema_version === 3) { verifyV3Schema(db); return "v3"; }
  if (meta[0]?.schema_version === 5) { verifyV5SignalSchema(db); return "v5"; }
  if (meta[0]?.schema_version === 6) { verifyV6SignalSchema(db); return "v6"; }
  if (meta[0]?.schema_version === 7) { verifyV7Schema(db); return "v7"; }
  if (meta[0]?.schema_version === 8) { verifyV8Schema(db); return "v8"; }
  if (meta[0]?.schema_version === 9) { verifyV9Schema(db); return "v9"; }
  if (meta[0]?.schema_version === 10) { verifyV10Schema(db); return "v10"; }
  if (meta[0]?.schema_version === 11) { verifyBaseSchema(db, 11); verifyFacts(db); verifySignalSchema(db, true, true, true, true); verifyDashboardSchema(db); return "v11"; }
  if (meta[0]?.schema_version === 12) { verifyBaseSchema(db, 12); verifyFacts(db); verifySignalSchema(db, true, true, true, true); verifyDashboardSchema(db); return "v12"; }
  if (meta[0]?.schema_version === 13) { verifyBaseSchema(db, 13); verifyFacts(db); verifySignalSchema(db, true, false, true, false); verifyDashboardSchema(db); return "v13"; }
  if (meta[0]?.schema_version === V14_SCHEMA_VERSION) { verifyBaseSchema(db, V14_SCHEMA_VERSION); verifyFacts(db); verifySignalSchema(db); verifyDashboardSchema(db); verifyGitSchema(db); return "v14"; }
  if (meta[0]?.schema_version === V15_SCHEMA_VERSION) { verifyBaseSchema(db, V15_SCHEMA_VERSION, true); verifyFacts(db); verifySignalSchema(db); verifyDashboardSchema(db); verifyGitSchema(db); return "v15"; }
  if (meta[0]?.schema_version === V16_SCHEMA_VERSION) { verifyBaseSchema(db, V16_SCHEMA_VERSION, true); verifyFacts(db); verifySignalSchema(db); verifyDashboardSchema(db); verifyGitSchema(db); return "v16"; }
  if (meta[0]?.schema_version === V17_SCHEMA_VERSION) { verifyBaseSchema(db, V17_SCHEMA_VERSION, true); verifyFacts(db); verifySignalSchema(db, true, false, false, false, true); verifyDashboardSchema(db); verifyGitSchema(db); return "v17"; }
  if (meta[0]?.schema_version === V18_SCHEMA_VERSION) { verifyBaseSchema(db, V18_SCHEMA_VERSION, true); verifyFacts(db); verifySignalSchema(db); verifyDashboardSchema(db); verifyGitSchema(db); return "v18"; }
  if (meta[0]?.schema_version === 4) {
    // Do not treat a relabelled current schema as a migratable legacy store.
    // The v4 execution fact had `state`; v5 has the formal `status` contract.
    const columns = db.prepare("PRAGMA table_info(analytics_execution_fact)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "state") || columns.some((column) => column.name === "status")) unavailableSchema();
    return "v4";
  }
  verifyCurrentSchema(db);
  return "current";
}

function initializeBaseSchema(db: AnalyticsDb, nowMs: number) {
  const initialFactDomains = "[]";
  db.exec(`
    CREATE TABLE analytics_schema_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL);
    CREATE TABLE analytics_domain_state (
      domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN (${expectedList(ANALYTICS_DOMAINS)})), collection_started_at INTEGER,
      reconciled_through INTEGER, rollup_ready_through INTEGER, retention_floor INTEGER,
      status TEXT NOT NULL CHECK (status IN (${DOMAIN_STATUS_SQL})), last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE analytics_domain_config_version (
      collection_config_version TEXT PRIMARY KEY NOT NULL, effective_at INTEGER NOT NULL,
      enabled_fact_domains_json TEXT NOT NULL, changed_at INTEGER NOT NULL
    );
    CREATE TABLE analytics_config_source_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      source_config_version INTEGER NOT NULL CHECK (source_config_version >= 1),
      effective_at INTEGER NOT NULL CHECK (effective_at >= 0),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      canonical_content TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO analytics_schema_meta (singleton, schema_version) VALUES (1, ?)").run(ANALYTICS_SCHEMA_VERSION);
  const insertDomain = db.prepare("INSERT INTO analytics_domain_state (domain, collection_started_at, reconciled_through, rollup_ready_through, retention_floor, status, last_succeeded_at, last_error_code, updated_at) VALUES (?, NULL, NULL, NULL, NULL, 'unavailable', NULL, NULL, ?)");
  for (const domain of ANALYTICS_DOMAINS) insertDomain.run(domain, nowMs);
  db.prepare("INSERT INTO analytics_domain_config_version (collection_config_version, effective_at, enabled_fact_domains_json, changed_at) VALUES ('0000000000000000', 0, ?, 0)").run(initialFactDomains);
}

function initializeNewSchema(db: AnalyticsDb, nowMs: number) {
  db.transaction(() => { initializeBaseSchema(db, nowMs); db.exec(COLLECTOR_TABLE_SQL); db.exec(SIGNAL_TABLE_SQL); db.exec(CURRENT_DASHBOARD_TABLE_SQL); })();
}

function createCollectorSchemaFromV2(db: AnalyticsDb) {
  db.transaction(() => { db.exec(COLLECTOR_TABLE_SQL); rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION); })();
}

function migrateV3Signals(db: AnalyticsDb) {
  db.transaction(() => { db.exec(SIGNAL_TABLE_SQL); rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION); })();
}

function migrateV4Signals(db: AnalyticsDb) {
  // Preserve v4's sanitized Signal cache in transaction-local tables before
  // rebuilding its inadequate schema. The mapped quality values are deliberately
  // conservative: unavailable source fields stay unavailable rather than being
  // invented during migration.
  db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE v4_slot AS SELECT * FROM analytics_producer_slot;
      CREATE TEMP TABLE v4_generation AS SELECT * FROM analytics_producer_generation;
      CREATE TEMP TABLE v4_checkpoint AS SELECT * FROM analytics_producer_checkpoint;
      CREATE TEMP TABLE v4_receipt AS SELECT * FROM analytics_event_receipt;
      CREATE TEMP TABLE v4_gap AS SELECT * FROM analytics_signal_coverage_gap;
      CREATE TEMP TABLE v4_execution AS SELECT * FROM analytics_execution_fact;
      CREATE TEMP TABLE v4_model AS SELECT * FROM analytics_model_call_fact;
      CREATE TEMP TABLE v4_worker_event AS SELECT * FROM analytics_worker_event_fact;
      CREATE TEMP TABLE v4_worker_snapshot AS SELECT * FROM analytics_worker_live_snapshot;
    `);
    db.exec(`DROP TABLE analytics_producer_slot; DROP TABLE analytics_producer_generation; DROP TABLE analytics_producer_checkpoint; DROP TABLE analytics_event_receipt; DROP TABLE analytics_signal_coverage_gap; DROP TABLE analytics_execution_fact; DROP TABLE analytics_model_call_fact; DROP TABLE analytics_worker_event_fact; DROP TABLE analytics_worker_live_snapshot;`);
    db.exec(SIGNAL_TABLE_SQL);
    db.exec(`
      INSERT INTO analytics_producer_slot SELECT domain, producer_namespace, producer_id, expected_enabled, 'legacy-v4', updated_at FROM v4_slot;
      INSERT INTO analytics_producer_generation
        (domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, last_control_received_at, created_at)
      SELECT domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, 1, last_control_received_at, created_at FROM v4_generation;
      INSERT INTO analytics_producer_checkpoint
        (domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, received_at)
      SELECT domain, producer_namespace, producer_id, producer_generation, committed_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, 1, received_at FROM v4_checkpoint;
      INSERT INTO analytics_event_receipt SELECT event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version, CASE event_type WHEN 'worker_restart' THEN 'worker_restart_attempted' ELSE event_type END, subject_identity, fingerprint, received_at, committed_at FROM v4_receipt;
      INSERT INTO analytics_signal_coverage_gap SELECT gap_id, domain, producer_namespace, producer_id, producer_generation, gap_from, gap_to, cause, dropped_since_sequence, recorded_at, closed_at FROM v4_gap;
      INSERT INTO analytics_execution_fact
        (execution_id, run_id, runtime_kind, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
      SELECT execution_id, run_id, 'agent_worker', run_kind, parent_run_id, started_at, started_at, ended_at, effective_ended_at,
        CASE WHEN state='running' THEN 'running' ELSE 'ended' END,
        CASE WHEN ended_at IS NULL THEN 'unknown' ELSE 'observed' END,
        CASE state WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE NULL END,
        collected_at, collected_at, collected_at FROM v4_execution;
      INSERT INTO analytics_model_call_fact
        (model_call_id, execution_id, run_id, attempt_no, provider_id, model_id, started_at, ended_at, status, completion_quality, timeout_kind, input_tokens, output_tokens, total_tokens, total_source, cache_read_tokens, cache_write_tokens, cache_comparable, cache_write_verified, failure_kind, observed_at, updated_at, collected_at)
      SELECT model_call_id, execution_id, run_id, 1, provider_id, model_id, started_at, ended_at, status,
        CASE WHEN ended_at IS NULL THEN 'unknown' ELSE 'observed' END, timeout_kind, input_tokens, output_tokens,
        CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens + output_tokens ELSE NULL END,
        CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 'derived' ELSE 'unavailable' END,
        cache_read_tokens, NULL, 0, 0,
        CASE WHEN status IN ('failed','timed_out','cancelled','other') THEN CASE WHEN status='timed_out' THEN 'timeout' WHEN status='cancelled' THEN 'cancelled' ELSE 'provider' END ELSE NULL END,
        collected_at, collected_at, collected_at FROM v4_model;
      INSERT INTO analytics_worker_event_fact (event_id, occurred_at, event_type, restart_attempt_id, runner_mode, collected_at)
      SELECT event_id, occurred_at, CASE event_type WHEN 'restart' THEN 'restart_attempted' WHEN 'unexpected_exit' THEN 'unexpected_exit' ELSE 'ready' END,
        CASE WHEN event_type='restart' THEN event_id ELSE NULL END, runner_mode, collected_at FROM v4_worker_event;
      INSERT INTO analytics_worker_live_snapshot SELECT runner_mode, snapshot_at, active_count, queue_length, concurrency, last_ready_at, received_at FROM v4_worker_snapshot;
      DROP TABLE v4_slot; DROP TABLE v4_generation; DROP TABLE v4_checkpoint; DROP TABLE v4_receipt; DROP TABLE v4_gap;
      DROP TABLE v4_execution; DROP TABLE v4_model; DROP TABLE v4_worker_event; DROP TABLE v4_worker_snapshot;
    `);
    rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION);
  })();
}

function migrateV15ToV16(db: AnalyticsDb, testFaultAt?: "after_baseline_rewrite") {
  db.transaction(() => {
    const result = db.prepare(
      "UPDATE analytics_domain_config_version SET collection_config_version='0000000000000000', effective_at=0, changed_at=0 WHERE collection_config_version='initial'",
    ).run();
    if (result.changes === 0) {
      const baseline = db.prepare(
        "SELECT COUNT(*) AS count FROM analytics_domain_config_version WHERE collection_config_version='0000000000000000' AND effective_at=0",
      ).get() as { count: number };
      if (baseline.count !== 1) throw new Error("missing v15 initial config baseline");
    } else if (result.changes !== 1) throw new Error("invalid v15 initial config baseline");
    if (testFaultAt === "after_baseline_rewrite") throw new Error("injected v16 migration failure");
    db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(V16_SCHEMA_VERSION);
  })();
}

/**
 * v8 has a pre-dimensional Model cache and a pre-quality Message cache.  Do
 * not expose intermediate v9/v10 layouts: all replacement DDL, cache
 * invalidation and the version flip commit atomically as v11.
 */
function migrateV8ToV11(db: AnalyticsDb, now = Date.now(), testFaultAt?: "after_dashboard_rebuild") {
  db.transaction(() => {
    const hasMarkers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analytics_rollup_hour'").get() !== undefined;
    if (hasMarkers) db.exec("CREATE TEMP TABLE v8_rollup_marker AS SELECT domain,bucket_start FROM analytics_rollup_hour;");
    else db.exec("CREATE TEMP TABLE v8_rollup_marker(domain TEXT NOT NULL, bucket_start INTEGER NOT NULL);");
    // Dashboard tables are replaceable cache data. Rebuilding them is safer
    // than trusting v8's non-zero-only rows as proof of a completed hour.
    db.exec(`DROP TABLE analytics_dirty_hour; DROP TABLE dashboard_model_1h; DROP TABLE dashboard_tool_1h;
      DROP TABLE dashboard_message_1h; DROP TABLE dashboard_collected_1h; DROP TABLE IF EXISTS analytics_rollup_hour; DROP TABLE analytics_maintenance_state;
      DROP TABLE IF EXISTS dashboard_model_dimension_1h;`);
    const currentModelDdl = expectedDdl("analytics_model_call_fact", "table");
    const actualModelDdl = normalizedSql((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_model_call_fact'").get() as SchemaObject | undefined)?.sql ?? null);
    if (actualModelDdl !== currentModelDdl) {
      const modelDdl = rawExpectedDdl("analytics_model_call_fact", "table");
      db.exec(modelDdl.replace("CREATE TABLE analytics_model_call_fact", "CREATE TABLE analytics_model_call_fact_v8_copy"));
      db.exec("INSERT INTO analytics_model_call_fact_v8_copy SELECT * FROM analytics_model_call_fact; DROP TABLE analytics_model_call_fact;");
      // Recreate from the authority rather than ALTER ... RENAME: SQLite adds
      // identifier quotes on rename, which would fail strict DDL verification.
      db.exec(`${modelDdl}; INSERT INTO analytics_model_call_fact SELECT * FROM analytics_model_call_fact_v8_copy; DROP TABLE analytics_model_call_fact_v8_copy;`);
    }
    // Rebuilds and pre-marker v8 stores can both lack these indexes.  Make
    // their presence explicit after the Model table has reached its v11 DDL.
    for (const index of ["idx_analytics_model_range", "idx_analytics_model_open", "idx_analytics_execution_collected_at", "idx_analytics_model_collected_at", "idx_analytics_worker_event_collected_at"]) {
      db.exec(rawExpectedDdl(index, "index").replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS"));
    }
    db.exec(DASHBOARD_TABLE_SQL);
    if (testFaultAt === "after_dashboard_rebuild") throw new Error("injected v8 migration failure");
    const closedTo = Math.floor(now / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const mark = db.prepare("INSERT INTO analytics_dirty_hour(domain, bucket_start, marked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    for (const row of db.prepare("SELECT domain,bucket_start FROM v8_rollup_marker WHERE domain IN ('model','tool','message')").all() as Array<{ domain: "model" | "tool" | "message"; bucket_start: number }>) mark.run(row.domain, row.bucket_start, now);
    for (const [domain, table, field] of [["model", "analytics_model_call_fact", "started_at"], ["tool", "analytics_tool_fact", "created_at"], ["message", "analytics_message_fact", "created_at"]] as const) {
      const row = db.prepare(`SELECT MIN(${field}) AS earliest FROM ${table}`).get() as { earliest: number | null };
      if (row.earliest !== null) {
        const start = Math.max(0, Math.floor(row.earliest / (60 * 60 * 1000)) * 60 * 60 * 1000);
        // Retention bounds this initial cache reconstruction; each later pass is bounded.
        for (let bucket = Math.max(start, closedTo - 400 * 24 * 60 * 60 * 1000); bucket < closedTo; bucket += 60 * 60 * 1000) mark.run(domain, bucket, now);
      }
      db.prepare("UPDATE analytics_domain_state SET rollup_ready_through = NULL, updated_at = ? WHERE domain = ?").run(now, domain);
    }
    db.exec("DROP TABLE v8_rollup_marker;");
    rebuildV11SignalHistoryTables(db);
    db.prepare("UPDATE analytics_schema_meta SET schema_version = 11 WHERE singleton = 1").run();
  })();
}

function migrateV5ToV6(db: AnalyticsDb) {
  db.transaction(() => {
    db.exec("DROP INDEX idx_analytics_receipt_committed_at; DROP INDEX idx_analytics_receipt_generation_sequence;");
    db.exec("ALTER TABLE analytics_producer_slot RENAME TO v5_analytics_producer_slot; ALTER TABLE analytics_event_receipt RENAME TO v5_analytics_event_receipt;");
    db.exec(rawExpectedDdl("analytics_producer_slot", "table"));
    db.exec(rawExpectedDdl("analytics_event_receipt", "table"));
    db.exec(rawExpectedDdl("idx_analytics_receipt_committed_at", "index"));
    db.exec(rawExpectedDdl("idx_analytics_receipt_generation_sequence", "index"));
    db.prepare(`INSERT INTO analytics_producer_slot (domain, producer_namespace, producer_id, expected_enabled, config_version, updated_at)
      SELECT domain, producer_namespace, producer_id, expected_enabled, 'legacy-v5', updated_at FROM v5_analytics_producer_slot`).run();
    db.prepare(`INSERT INTO analytics_event_receipt (event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version, event_type, subject_identity, fingerprint, received_at, committed_at)
      SELECT event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version,
        CASE event_type WHEN 'worker_restart' THEN 'worker_restart_attempted' ELSE event_type END, subject_identity, fingerprint, received_at, committed_at
      FROM v5_analytics_event_receipt`).run();
    db.exec("DROP TABLE v5_analytics_producer_slot; DROP TABLE v5_analytics_event_receipt;");
    rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION);
  })();
}

function migrateV6ToV7(db: AnalyticsDb) {
  // Rebuild only Signal tables inside one transaction: v6 was an internal,
  // uncommitted cache shape and v7 must not accept ambiguous controls.
  db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE v6_generation AS SELECT * FROM analytics_producer_generation;
      CREATE TEMP TABLE v6_checkpoint AS SELECT * FROM analytics_producer_checkpoint;
      DROP TABLE analytics_producer_generation;
      DROP TABLE analytics_producer_checkpoint;
    `);
    db.exec(rawExpectedDdl("analytics_producer_generation", "table"));
    db.exec(rawExpectedDdl("analytics_producer_checkpoint", "table"));
    db.exec(rawExpectedDdl("idx_analytics_checkpoint_domain_received", "index"));
    db.exec(rawExpectedDdl("idx_analytics_generation_lifecycle", "index"));
    db.prepare(`INSERT INTO analytics_producer_generation
      (domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, last_control_received_at, created_at)
      SELECT domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, 1, last_control_received_at, created_at FROM v6_generation`).run();
    db.prepare(`INSERT INTO analytics_producer_checkpoint
      (domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, received_at)
      SELECT domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, 1, received_at FROM v6_checkpoint`).run();
    db.exec("DROP TABLE v6_generation; DROP TABLE v6_checkpoint;");
    rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION);
  })();
}


function migrateV7ToV8(db: AnalyticsDb) {
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS dashboard_model_dimension_1h;");
    db.exec(DASHBOARD_TABLE_SQL);
    for (const index of ["idx_analytics_execution_collected_at", "idx_analytics_model_collected_at", "idx_analytics_worker_event_collected_at"]) {
      db.exec(rawExpectedDdl(index, "index").replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS"));
    }
    rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION);
  })();
}

function migrateLegacyV3(db: AnalyticsDb) {
  // Previous phase-three collector facts were historical backfills. Resetting
  // this Analytics-only cache is safer than retaining data that cannot satisfy
  // the no-backfill and durable-frontier contract.
  db.transaction(() => {
    db.exec(`
      DROP TABLE analytics_collector_watermark;
      DROP TABLE analytics_run_fact;
      DROP TABLE analytics_session_fact;
      DROP TABLE analytics_message_fact;
      DROP TABLE analytics_tool_fact;
      ${COLLECTOR_TABLE_SQL}
    `);
    db.exec(SIGNAL_TABLE_SQL);
    rebuildV11SignalHistoryTables(db); db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(PRE_GIT_SCHEMA_VERSION);
    db.prepare(`UPDATE analytics_domain_state
      SET collection_started_at = NULL, reconciled_through = NULL, status = 'unavailable',
        last_succeeded_at = NULL, last_error_code = NULL, updated_at = ?
      WHERE domain IN ('run', 'session', 'message', 'tool')`).run(Date.now());
  })();
}

function migrateV11ToV12(db: AnalyticsDb) {
  db.transaction(() => {
    // Interrupted pre-release stores may contain these objects with a v11
    // marker. Current-schema verification still rejects a non-authoritative DDL.
    db.exec(GIT_TABLE_SQL.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ").replaceAll("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "));
    db.prepare("UPDATE analytics_schema_meta SET schema_version=? WHERE singleton=1").run(V12_SCHEMA_VERSION);
  })();
}

function migrateV12ToV13(db: AnalyticsDb, testFaultAt?: "after_worker_event_rebuild") {
  db.transaction(() => {
    db.exec(`ALTER TABLE analytics_worker_event_fact RENAME TO v12_analytics_worker_event_fact;
      ALTER TABLE analytics_event_receipt RENAME TO v12_analytics_event_receipt;
      DROP INDEX idx_analytics_worker_event_range; DROP INDEX idx_analytics_worker_event_collected_at;
      DROP INDEX idx_analytics_receipt_committed_at; DROP INDEX idx_analytics_receipt_generation_sequence;`);
    // v13 is the last pre-Fact-identity release.  Rebuild both Fact tables
    // here so the v13 marker always names its actual historical DDL.
    db.exec(`ALTER TABLE analytics_execution_fact RENAME TO v12_analytics_execution_fact;
      ALTER TABLE analytics_model_call_fact RENAME TO v12_analytics_model_call_fact;
      DROP INDEX idx_analytics_execution_range; DROP INDEX idx_analytics_execution_open; DROP INDEX idx_analytics_execution_collected_at;
      DROP INDEX idx_analytics_model_range; DROP INDEX idx_analytics_model_open; DROP INDEX idx_analytics_model_collected_at;`);
    db.exec(legacyFactDdl("analytics_execution_fact")); db.exec(legacyFactDdl("analytics_model_call_fact"));
    for (const index of ["idx_analytics_execution_range", "idx_analytics_execution_open", "idx_analytics_execution_collected_at", "idx_analytics_model_range", "idx_analytics_model_open", "idx_analytics_model_collected_at"] as const) {
      db.exec(legacyFactIndexDdl(index));
    }
    db.exec(rawExpectedDdl("analytics_worker_event_fact", "table"));
    db.exec(rawExpectedDdl("analytics_event_receipt", "table"));
    db.exec(rawExpectedDdl("idx_analytics_worker_event_range", "index"));
    db.exec(rawExpectedDdl("idx_analytics_worker_event_collected_at", "index"));
    db.exec(rawExpectedDdl("idx_analytics_receipt_committed_at", "index"));
    db.exec(rawExpectedDdl("idx_analytics_receipt_generation_sequence", "index"));
    db.prepare(`INSERT INTO analytics_worker_event_fact (event_id, occurred_at, event_type, restart_attempt_id, runner_mode, collected_at)
      SELECT event_id, occurred_at, event_type, restart_attempt_id, runner_mode, collected_at FROM v12_analytics_worker_event_fact`).run();
    db.prepare(`INSERT INTO analytics_event_receipt
      (event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version, event_type, subject_identity, fingerprint, received_at, committed_at)
      SELECT event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version, event_type, subject_identity, fingerprint, received_at, committed_at
      FROM v12_analytics_event_receipt`).run();
    db.exec(`INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
      SELECT execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at FROM v12_analytics_execution_fact;
      INSERT INTO analytics_model_call_fact (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
      SELECT model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at FROM v12_analytics_model_call_fact;`);
    if (testFaultAt === "after_worker_event_rebuild") throw new Error("injected v13 migration failure");
    db.exec("DROP TABLE v12_analytics_worker_event_fact; DROP TABLE v12_analytics_event_receipt; DROP TABLE v12_analytics_execution_fact; DROP TABLE v12_analytics_model_call_fact;");
    db.prepare("UPDATE analytics_schema_meta SET schema_version=? WHERE singleton=1").run(V13_SCHEMA_VERSION);
  })();
}

function migrateV13ToV14(db: AnalyticsDb, testFaultAt?: "after_fact_identity_rebuild") {
  db.transaction(() => {
    db.exec(`ALTER TABLE analytics_execution_fact RENAME TO v13_analytics_execution_fact;
      ALTER TABLE analytics_model_call_fact RENAME TO v13_analytics_model_call_fact;
      DROP INDEX idx_analytics_execution_range; DROP INDEX idx_analytics_execution_open; DROP INDEX idx_analytics_execution_collected_at;
      DROP INDEX idx_analytics_model_range; DROP INDEX idx_analytics_model_open; DROP INDEX idx_analytics_model_collected_at;`);
    for (const table of ["analytics_execution_fact", "analytics_model_call_fact"] as const) db.exec(rawExpectedDdl(table, "table"));
    for (const index of ["idx_analytics_execution_range", "idx_analytics_execution_open", "idx_analytics_execution_collected_at", "idx_analytics_model_range", "idx_analytics_model_open", "idx_analytics_model_collected_at"] as const) db.exec(rawExpectedDdl(index, "index"));
    db.prepare(`INSERT INTO analytics_execution_fact
      (execution_id, run_id, runtime_kind, producer_namespace, producer_id, producer_generation, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
      SELECT execution_id, run_id, runtime_kind, NULL, NULL, NULL, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at FROM v13_analytics_execution_fact`).run();
    db.prepare(`INSERT INTO analytics_model_call_fact
      (model_call_id, execution_id, run_id, attempt_no, producer_namespace, producer_id, producer_generation, provider_id, model_id, started_at, ended_at, status, completion_quality, timeout_kind, input_tokens, output_tokens, total_tokens, total_source, cache_read_tokens, cache_write_tokens, cache_comparable, cache_write_verified, failure_kind, observed_at, updated_at, collected_at)
      SELECT model_call_id, execution_id, run_id, attempt_no, NULL, NULL, NULL, provider_id, model_id, started_at, ended_at, status, completion_quality, timeout_kind, input_tokens, output_tokens, total_tokens, total_source, cache_read_tokens, cache_write_tokens, cache_comparable, cache_write_verified, failure_kind, observed_at, updated_at, collected_at FROM v13_analytics_model_call_fact`).run();
    if (testFaultAt === "after_fact_identity_rebuild") throw new Error("injected v14 migration failure");
    db.exec("DROP TABLE v13_analytics_execution_fact; DROP TABLE v13_analytics_model_call_fact;");
    db.prepare("UPDATE analytics_schema_meta SET schema_version=? WHERE singleton=1").run(V14_SCHEMA_VERSION);
  })();
}

function migrateV14ToV15(db: AnalyticsDb, testFaultAt?: "after_source_control_create") {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS analytics_config_source_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      source_config_version INTEGER NOT NULL CHECK (source_config_version >= 1),
      effective_at INTEGER NOT NULL CHECK (effective_at >= 0),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      canonical_content TEXT NOT NULL
    );`);
    if (testFaultAt === "after_source_control_create") throw new Error("injected v15 migration failure");
    db.prepare("UPDATE analytics_schema_meta SET schema_version = ? WHERE singleton = 1").run(V15_SCHEMA_VERSION);
  })();
}

/**
 * Test-only historical fixture authority.  It deliberately invokes the same
 * release migrations that wrote the historical layouts, so callers get the
 * real v11/v13 tables and indexes (not a current schema with a relabelled
 * metadata row).  Do not use in production startup paths.
 */
export function createHistoricalSchemaForTest(db: AnalyticsDb, version: 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18) {
  // Tests start from a fresh current store; restore the last released domain
  // and collected-cache layout before invoking earlier release migrations.
  if (inspectSchema(db) === "current") db.transaction(() => {
    db.exec(`
      ALTER TABLE analytics_domain_state RENAME TO v19_domain_state;
      CREATE TABLE analytics_domain_state (
        domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN (${expectedList(LEGACY_ANALYTICS_DOMAINS)})), collection_started_at INTEGER,
        reconciled_through INTEGER, rollup_ready_through INTEGER, retention_floor INTEGER,
        status TEXT NOT NULL CHECK (status IN (${DOMAIN_STATUS_SQL})), last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO analytics_domain_state SELECT * FROM v19_domain_state;
      DROP TABLE v19_domain_state;
      ALTER TABLE dashboard_collected_1h RENAME TO v19_collected;
      DROP INDEX dashboard_collected_1h_bucket;
      ${rawExpectedDdl("dashboard_collected_1h", "table")}
      INSERT INTO dashboard_collected_1h SELECT * FROM v19_collected;
      DROP TABLE v19_collected;
      ${rawExpectedDdl("dashboard_collected_1h_bucket", "index")}
      ${GIT_TABLE_SQL}
    `);
    db.prepare("INSERT INTO analytics_domain_state VALUES ('git',NULL,NULL,NULL,NULL,'unavailable',NULL,NULL,0)").run();
    db.prepare("UPDATE analytics_schema_meta SET schema_version=18 WHERE singleton=1").run();
  })();
  if (version === 18) return;
  if (version === 11) {
    rebuildV11SignalHistoryTables(db);
    db.prepare("UPDATE analytics_schema_meta SET schema_version=11 WHERE singleton=1").run();
    return;
  }
  rebuildV11SignalHistoryTables(db);
  db.prepare("UPDATE analytics_schema_meta SET schema_version=11 WHERE singleton=1").run();
  migrateV11ToV12(db);
  if (version === 12) return;
  migrateV12ToV13(db);
  if (version === 13) return;
  migrateV13ToV14(db);
  if (version === 14) return;
  migrateV14ToV15(db);
  if (version === 15) return;
  migrateV15ToV16(db);
  if (version === 16) return;
  migrateV16ToV17(db);
}

/** Opens the isolated Analytics store. Production callers are restricted to the Analytics child process. */
export async function openAnalyticsDb(dataDir: string, nowMs = Date.now(), options?: { testFaultAt?: "v8_after_dashboard_rebuild" | "v13_after_worker_event_rebuild" | "v14_after_fact_identity_rebuild" | "v15_after_source_control_create" | "v16_after_baseline_rewrite" | "v17_after_empty_baseline" | "v18_after_execution_rebuild" | "v19_after_collected_rebuild"; afterFilePinnedForTest?: () => Promise<void> | void }): Promise<AnalyticsDb> {
  const root = await openSecureAnalyticsRoot(dataDir);
  let db: AnalyticsDb | null = null;
  let pinned: FileHandle | null = null;
  try {
    pinned = await root.openRegularFile("analytics.sqlite", true);
    const pinnedStat = await pinned.stat();
    const verifyPinned = async () => {
      const probe = await root.openRegularFile("analytics.sqlite");
      try {
        const current = await probe.stat();
        if (current.dev !== pinnedStat.dev || current.ino !== pinnedStat.ino)
          throw new Error("Analytics SQLite file changed while opening");
      } finally { await probe.close(); }
    };
    await options?.afterFilePinnedForTest?.();
    await verifyPinned();
    db = new Database(root.path("analytics.sqlite"));
    try { await verifyPinned(); }
    catch (error) { db.close(); db = null; throw error; }
    const state = inspectSchema(db);
    if (state === "new") initializeNewSchema(db, nowMs);
    if (state === "v2") createCollectorSchemaFromV2(db);
    if (state === "legacy-v3") migrateLegacyV3(db);
    if (state === "v3") migrateV3Signals(db);
    if (state === "v4") migrateV4Signals(db);
    if (state === "v5") migrateV5ToV6(db);
    if (state === "v6") migrateV6ToV7(db);
    if (state === "v7") migrateV7ToV8(db);
    if (state === "v8") migrateV8ToV11(db, nowMs, options?.testFaultAt === "v8_after_dashboard_rebuild" ? "after_dashboard_rebuild" : undefined);
    if (state === "v9") { migrateV9ToV10(db); migrateV10ToV11(db); }
    if (state === "v10") migrateV10ToV11(db);
    if (inspectSchema(db) === "v11") migrateV11ToV12(db);
    if (inspectSchema(db) === "v12") migrateV12ToV13(db, options?.testFaultAt === "v13_after_worker_event_rebuild" ? "after_worker_event_rebuild" : undefined);
    if (inspectSchema(db) === "v13") migrateV13ToV14(db, options?.testFaultAt === "v14_after_fact_identity_rebuild" ? "after_fact_identity_rebuild" : undefined);
    if (inspectSchema(db) === "v14") migrateV14ToV15(db, options?.testFaultAt === "v15_after_source_control_create" ? "after_source_control_create" : undefined);
    if (inspectSchema(db) === "v15") migrateV15ToV16(db, options?.testFaultAt === "v16_after_baseline_rewrite" ? "after_baseline_rewrite" : undefined);
    if (inspectSchema(db) === "v16") migrateV16ToV17(db, options?.testFaultAt === "v17_after_empty_baseline" ? "after_empty_baseline" : undefined);
    if (inspectSchema(db) === "v17") migrateV17ToV18(db, options?.testFaultAt === "v18_after_execution_rebuild" ? "after_execution_rebuild" : undefined);
    if (inspectSchema(db) === "v18") migrateV18ToV19(db, options?.testFaultAt === "v19_after_collected_rebuild" ? "after_collected_rebuild" : undefined);
    verifyCurrentSchema(db);
    db.pragma("busy_timeout = 1000");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    await root.deleteFile("git-installation-secret");
    databaseRoots.set(db, { root, file: pinned });
    pinned = null;
    return db;
  } catch {
    db?.close();
    await pinned?.close().catch(() => undefined);
    await root.close().catch(() => undefined);
    throw new Error("analytics database unavailable");
  }
}

export function readAnalyticsDomainStates(db: AnalyticsDb): AnalyticsDomainState[] {
  return db.prepare(`SELECT domain, status, collection_started_at, reconciled_through, rollup_ready_through, retention_floor, last_succeeded_at, last_error_code FROM analytics_domain_state ORDER BY domain`).all().map((row) => {
    const value = row as { domain: AnalyticsDomainState["domain"]; status: AnalyticsDomainState["status"]; collection_started_at: number | null; reconciled_through: number | null; rollup_ready_through: number | null; retention_floor: number | null; last_succeeded_at: number | null; last_error_code: string | null };
    return { domain: value.domain, status: value.status, collectionStartedAt: value.collection_started_at, reconciledThrough: value.reconciled_through, rollupReadyThrough: value.rollup_ready_through, retentionFloor: value.retention_floor, lastSucceededAt: value.last_succeeded_at, lastErrorCode: value.last_error_code };
  });
}

export function closeAnalyticsDb(db: AnalyticsDb | null) {
  if (db?.open) db.close();
  const owned = db ? databaseRoots.get(db) : undefined;
  if (db) databaseRoots.delete(db);
  void owned?.file.close().catch(() => undefined);
  void owned?.root.close().catch(() => undefined);
}
