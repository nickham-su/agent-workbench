import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyticsDbPath, analyticsGitInstallationSecretPath, analyticsModelOutboxRoot } from "../../infra/fs/paths.js";
import { ANALYTICS_SCHEMA_VERSION, closeAnalyticsDb, createHistoricalSchemaForTest, openAnalyticsDb, readAnalyticsDomainStates } from "./analytics-db.js";
import { queryDashboard } from "./analytics-dashboard-query.js";

async function tempDataDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("Analytics SQLite root replacement fails closed without creating an external DB", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-root-anchor-");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-analytics-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const db = await openAnalyticsDb(dataDir, 1);
  t.after(() => closeAnalyticsDb(db));
  const logical = path.join(dataDir, "analytics");
  const original = path.join(dataDir, "analytics-original");
  await fs.rename(logical, original);
  await fs.symlink(outside, logical);
  assert.throws(() => db.exec("CREATE TABLE anchored_after_replace (value INTEGER)"));
  assert.deepEqual(await fs.readdir(outside), []);
});

test("Analytics SQLite final-file symlink is rejected before SQLite can open its target", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-final-symlink-");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-analytics-final-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dataDir, "analytics"));
  const target = path.join(outside, "target.sqlite");
  new Database(target).close();
  const before = await fs.readFile(target);
  await fs.symlink(target, path.join(dataDir, "analytics", "analytics.sqlite"));
  await assert.rejects(() => openAnalyticsDb(dataDir, 1));
  assert.deepEqual(await fs.readFile(target), before);
});

test("SQLite pinned-file verification rejects a post-pin symlink swap without creating its target", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-pin-swap-");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-analytics-pin-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const logical = path.join(dataDir, "analytics", "analytics.sqlite");
  const target = path.join(outside, "not-created.sqlite");
  await assert.rejects(() => openAnalyticsDb(dataDir, 1, {
    afterFilePinnedForTest: async () => {
      await fs.rename(logical, `${logical}.held`);
      await fs.symlink(target, logical);
    },
  }));
  assert.equal(await fs.stat(target).then(() => true, () => false), false);
});

async function createV6SignalFixture(dataDir: string) {
  const current = await openAnalyticsDb(dataDir, 10);
  current.prepare(`INSERT INTO analytics_producer_generation
    (domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, last_control_received_at, created_at)
    VALUES ('model', 'agent_worker', 'agent_runner', 'v6-generation', 'closed', 1, 1, 100, NULL, 0, NULL, 0, NULL, 0, 2, 100, 10)`).run();
  current.prepare(`INSERT INTO analytics_producer_checkpoint
    (domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, received_at)
    VALUES ('model', 'agent_worker', 'agent_runner', 'v6-generation', 1, 100, NULL, 0, 0, 0, NULL, 0, NULL, 0, 2, 100)`).run();
  current.prepare(`INSERT INTO analytics_event_receipt
    (event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version, event_type, subject_identity, fingerprint, received_at, committed_at)
    VALUES ('v6-receipt', 'agent_worker', 'agent_runner', 'v6-generation', 1, 1, 'model_finished', 'model:v6', ?, 100, 100)`).run("a".repeat(64));
  current.prepare(`INSERT INTO analytics_execution_fact
    (execution_id, run_id, runtime_kind, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
    VALUES ('v6-execution', 'v6-run', 'agent_worker', 'user', NULL, NULL, 10, 20, 20, 'ended', 'observed', 'completed', 20, 20, 20)`).run();
  current.prepare(`INSERT INTO analytics_model_call_fact
    (model_call_id, execution_id, run_id, attempt_no, provider_id, model_id, started_at, ended_at, status, completion_quality, timeout_kind, input_tokens, output_tokens, total_tokens, total_source, cache_read_tokens, cache_write_tokens, cache_comparable, cache_write_verified, failure_kind, observed_at, updated_at, collected_at)
    VALUES ('v6-model', 'v6-execution', 'v6-run', 1, 'provider', 'model', 10, 20, 'completed', 'observed', NULL, 2, 3, 5, 'reported', NULL, NULL, 0, 0, NULL, 20, 20, 20)`).run();
  current.prepare(`INSERT INTO analytics_worker_event_fact (event_id, occurred_at, event_type, restart_attempt_id, runner_mode, collected_at)
    VALUES ('v6-worker', 20, 'restart_succeeded', 'attempt-v6', 'agent_worker', 20)`).run();
  closeAnalyticsDb(current);

  const legacy = new Database(analyticsDbPath(dataDir));
  const generationSql = (legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_producer_generation'").get() as { sql: string }).sql
    .replace(", control_sequence INTEGER NOT NULL DEFAULT 1 CHECK (control_sequence >= 1)", "");
  const checkpointSql = (legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_producer_checkpoint'").get() as { sql: string }).sql
    .replace(", control_sequence INTEGER NOT NULL CHECK (control_sequence >= 1)", "");
  legacy.exec(`DROP INDEX idx_analytics_checkpoint_domain_received; DROP INDEX idx_analytics_generation_lifecycle;
    ALTER TABLE analytics_producer_generation RENAME TO v7_generation;
    ALTER TABLE analytics_producer_checkpoint RENAME TO v7_checkpoint;
    ${generationSql}; ${checkpointSql};
    CREATE INDEX idx_analytics_checkpoint_domain_received ON analytics_producer_checkpoint(domain, received_at);
    CREATE INDEX idx_analytics_generation_lifecycle ON analytics_producer_generation(domain, lifecycle, last_control_received_at);
    INSERT INTO analytics_producer_generation (domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, last_control_received_at, created_at)
      SELECT domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, last_control_received_at, created_at FROM v7_generation;
    INSERT INTO analytics_producer_checkpoint (domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, received_at)
      SELECT domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, received_at FROM v7_checkpoint;
    DROP TABLE v7_generation; DROP TABLE v7_checkpoint;
    UPDATE analytics_schema_meta SET schema_version=6;`);
  legacy.close();
}

test("analytics database initializes formal state/config and collector fact tables with nullable collection state", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-db-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 123);
  t.after(() => closeAnalyticsDb(db));

  assert.equal(analyticsDbPath(dataDir).endsWith(path.join("analytics", "analytics.sqlite")), true);
  assert.equal(analyticsGitInstallationSecretPath(dataDir).endsWith(path.join("analytics", "git-installation-secret")), true);
  assert.equal(analyticsModelOutboxRoot(dataDir).endsWith(path.join("analytics", "model-outbox")), true);
  assert.equal((db.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.deepEqual(readAnalyticsDomainStates(db).map((state) => state.domain), ["agent_duration", "execution", "git", "message", "model", "run", "session", "tool", "worker"]);
  assert.equal(readAnalyticsDomainStates(db).every((state) => state.status === "unavailable" && state.collectionStartedAt === null && state.lastErrorCode === null), true);
  assert.deepEqual(
    JSON.parse((db.prepare("SELECT enabled_fact_domains_json FROM analytics_domain_config_version").get() as { enabled_fact_domains_json: string }).enabled_fact_domains_json),
    []
  );
  assert.deepEqual(db.prepare("SELECT collection_config_version, effective_at, changed_at FROM analytics_domain_config_version").get(), { collection_config_version: "0000000000000000", effective_at: 0, changed_at: 0 });
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => (row as { name: string }).name),
    ["analytics_collector_watermark", "analytics_config_source_control", "analytics_dirty_hour", "analytics_domain_config_version", "analytics_domain_state", "analytics_event_receipt", "analytics_execution_fact", "analytics_git_commit_fact", "analytics_git_membership", "analytics_git_repo_state", "analytics_git_scan", "analytics_maintenance_state", "analytics_message_fact", "analytics_model_call_fact", "analytics_producer_checkpoint", "analytics_producer_generation", "analytics_producer_slot", "analytics_rollup_hour", "analytics_run_fact", "analytics_schema_meta", "analytics_session_fact", "analytics_signal_coverage_gap", "analytics_tool_fact", "analytics_worker_event_fact", "analytics_worker_live_snapshot", "dashboard_collected_1h", "dashboard_message_1h", "dashboard_model_1h", "dashboard_model_dimension_1h", "dashboard_tool_1h"]
  );
  assert.deepEqual((db.prepare("PRAGMA table_info(analytics_collector_watermark)").all() as Array<{ name: string }>).map((column) => column.name), [
    "domain", "initial_anchor", "initial_floor_updated_at", "initial_floor_stable_id", "durable_updated_at", "durable_stable_id",
    "scan_anchor", "cycle_cursor_updated_at", "cycle_cursor_stable_id", "cycle_state", "reconciled_through", "updated_at"
  ]);
  for (const [index, columns] of [
    ["analytics_run_fact_created_run_id", ["created_at", "run_id"]], ["analytics_run_fact_collected_at", ["collected_at"]],
    ["analytics_session_fact_created_session_id", ["created_at", "session_id"]], ["analytics_session_fact_collected_at", ["collected_at"]],
    ["analytics_message_fact_created_kind_status_compaction", ["created_at", "message_kind", "message_status", "compaction_kind"]], ["analytics_message_fact_collected_at", ["collected_at"]],
    ["analytics_tool_fact_created_tool_name_status", ["created_at", "tool_name", "status"]], ["analytics_tool_fact_collected_at", ["collected_at"]],
    ["idx_analytics_execution_collected_at", ["collected_at"]], ["idx_analytics_model_collected_at", ["collected_at"]], ["idx_analytics_worker_event_collected_at", ["collected_at"]]
  ] as const) assert.deepEqual((db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((column) => column.name), columns, index);
});

test("current v18 fails closed for a persisted running Execution with inferred quality", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v18-invalid-running-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const current = await openAnalyticsDb(dataDir, 1);
  closeAnalyticsDb(current);
  const corrupted = new Database(analyticsDbPath(dataDir));
  corrupted.exec(`PRAGMA ignore_check_constraints=ON;
    INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,producer_namespace,producer_id,producer_generation,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
    VALUES ('invalid-running','run','agent_worker','agent_worker','worker','generation','user',NULL,NULL,1,NULL,NULL,'running','inferred',NULL,1,1,1);
    PRAGMA ignore_check_constraints=OFF;`);
  corrupted.close();
  await assert.rejects(() => openAnalyticsDb(dataDir, 2), /analytics database unavailable/);
});

test("current v18 fails closed for persisted Execution rows with either single terminal timestamp", async (t) => {
  const cases = [
    { name: "ended_at only", status: "running", quality: "unknown", endedAt: 2, effectiveEndedAt: null, reason: null },
    { name: "effective_ended_at only", status: "ended", quality: "unknown", endedAt: null, effectiveEndedAt: 2, reason: "worker_exit" },
  ] as const;
  for (const [index, invalid] of cases.entries()) {
    const dataDir = await tempDataDir(`awb-analytics-v18-invalid-${index}-`);
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const current = await openAnalyticsDb(dataDir, 1);
    closeAnalyticsDb(current);
    const corrupted = new Database(analyticsDbPath(dataDir));
    corrupted.exec("PRAGMA ignore_check_constraints=ON;");
    corrupted.prepare(
      `INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,producer_namespace,producer_id,producer_generation,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
      VALUES (?, 'run', 'agent_worker', 'agent_worker', 'worker', 'generation', 'user', NULL, NULL, 1, ?, ?, ?, ?, ?, 1, 1, 1)`,
    ).run(`invalid-single-time-${index}`, invalid.endedAt, invalid.effectiveEndedAt, invalid.status, invalid.quality, invalid.reason);
    corrupted.exec("PRAGMA ignore_check_constraints=OFF;");
    corrupted.close();
    await assert.rejects(() => openAnalyticsDb(dataDir, 2), /analytics database unavailable/, invalid.name);
  }
});

test("v14 source-control migration preserves configuration history", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v14-source-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const legacy = await openAnalyticsDb(dataDir, 10);
  legacy.prepare("INSERT INTO analytics_domain_config_version (collection_config_version, effective_at, enabled_fact_domains_json, changed_at) VALUES ('0000000000000001', 11, '[\"execution\"]', 11)").run();
  legacy.exec("UPDATE analytics_domain_config_version SET collection_config_version='initial', effective_at=10, changed_at=10, enabled_fact_domains_json='[\"run\",\"session\",\"message\",\"tool\",\"execution\",\"model\",\"worker\",\"git\"]' WHERE collection_config_version='0000000000000000'; DROP TABLE analytics_config_source_control; UPDATE analytics_schema_meta SET schema_version=14 WHERE singleton=1;");
  closeAnalyticsDb(legacy);
  await assert.rejects(() => openAnalyticsDb(dataDir, 20, { testFaultAt: "v15_after_source_control_create" }));
  const rolledBack = new Database(analyticsDbPath(dataDir));
  assert.equal((rolledBack.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 14);
  assert.equal((rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='analytics_config_source_control'").get() as { count: number }).count, 0);
  rolledBack.close();
  await assert.rejects(() => openAnalyticsDb(dataDir, 20, { testFaultAt: "v16_after_baseline_rewrite" }));
  const v15 = new Database(analyticsDbPath(dataDir));
  assert.equal((v15.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 15);
  assert.deepEqual(v15.prepare("SELECT collection_config_version, effective_at FROM analytics_domain_config_version WHERE collection_config_version='initial'").get(), { collection_config_version: "initial", effective_at: 10 });
  v15.close();
  await assert.rejects(() => openAnalyticsDb(dataDir, 20, { testFaultAt: "v17_after_empty_baseline" }));
  const v16 = new Database(analyticsDbPath(dataDir));
  assert.equal((v16.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 16);
  assert.deepEqual(v16.prepare("SELECT enabled_fact_domains_json FROM analytics_domain_config_version WHERE collection_config_version='0000000000000000'").get(), {
    enabled_fact_domains_json: "[\"run\",\"session\",\"message\",\"tool\",\"execution\",\"model\",\"worker\",\"git\"]",
  });
  v16.close();
  const migrated = await openAnalyticsDb(dataDir, 20);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='analytics_config_source_control'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT enabled_fact_domains_json FROM analytics_domain_config_version WHERE collection_config_version='0000000000000001'").get() as { enabled_fact_domains_json: string }).enabled_fact_domains_json, '["execution"]');
  assert.deepEqual(migrated.prepare("SELECT collection_config_version, effective_at, changed_at FROM analytics_domain_config_version WHERE collection_config_version='0000000000000000'").get(), { collection_config_version: "0000000000000000", effective_at: 0, changed_at: 0 });
  assert.deepEqual(migrated.prepare("SELECT enabled_fact_domains_json FROM analytics_domain_config_version WHERE collection_config_version='0000000000000000'").get(), { enabled_fact_domains_json: "[]" });
});

test("collected-at dashboard Fact predicates use their bounded indexes", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-collected-plan-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 1);
  t.after(() => closeAnalyticsDb(db));
  for (const [table, index] of [["analytics_execution_fact", "idx_analytics_execution_collected_at"], ["analytics_model_call_fact", "idx_analytics_model_collected_at"], ["analytics_worker_event_fact", "idx_analytics_worker_event_collected_at"]] as const) {
    const detail = (db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${table} WHERE collected_at>=? AND collected_at<?`).all(0, 1) as Array<{ detail: string }>).map((row) => row.detail).join(" ").toLowerCase();
    assert.match(detail, new RegExp(index.toLowerCase()));
  }
});

test("complete stage-two Analytics schema migrates transactionally to collector facts", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v2-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const first = await openAnalyticsDb(dataDir, 123);
  first.exec(`
    DROP TABLE analytics_collector_watermark;
    DROP TABLE analytics_run_fact;
    DROP TABLE analytics_session_fact;
    DROP TABLE analytics_message_fact;
    DROP TABLE analytics_tool_fact;
  `);
  first.prepare("UPDATE analytics_schema_meta SET schema_version = 2").run();
  closeAnalyticsDb(first);

  const migrated = await openAnalyticsDb(dataDir, 456);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_collector_watermark").get() as { count: number }).count, 0);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_run_fact").get() as { count: number }).count, 0);
});

test("v7 store migrates dashboard aggregate metadata without rewriting facts", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v7-dashboard-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const current = await openAnalyticsDb(dataDir, 123);
  current.prepare("INSERT INTO analytics_run_fact(run_id, run_kind, parent_run_id, display_status, status_quality, inferred_evidence_type, created_at, terminal_at, source_updated_at, collected_at) VALUES ('preserved','user',NULL,'completed','observed',NULL,1,1,1,1)").run();
  current.exec(`DROP TABLE analytics_dirty_hour; DROP TABLE dashboard_model_1h; DROP TABLE dashboard_tool_1h; DROP TABLE dashboard_message_1h; DROP TABLE dashboard_collected_1h; DROP TABLE analytics_rollup_hour; DROP TABLE analytics_maintenance_state;`);
  current.prepare("UPDATE analytics_schema_meta SET schema_version = 7").run();
  closeAnalyticsDb(current);

  const migrated = await openAnalyticsDb(dataDir, 456);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analytics_dirty_hour'").get());
  assert.deepEqual(migrated.prepare("SELECT run_id FROM analytics_run_fact").all(), [{ run_id: "preserved" }]);
});

test("v9 Model cache migration invalidates legacy markers and preserves Dashboard Fact values", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v9-model-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 10);
  db.prepare("UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=?, rollup_ready_through=? WHERE domain='model'").run(3_600_000, 3_600_000);
  db.prepare(`INSERT INTO analytics_model_call_fact(model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
    VALUES ('legacy-model','e','r',1,'p','m',0,10,'completed','observed',NULL,2,3,5,'reported',NULL,NULL,0,0,NULL,10,10,10)`).run();
  db.prepare("INSERT INTO dashboard_model_1h VALUES(0,99,99,0,0,0,0,0,0,0,0)").run();
  db.prepare("INSERT INTO analytics_rollup_hour VALUES('model',0,10)").run();
  // Construct the authenticated v9 layout: no Model dimension/indexes and
  // the pre-v11 Message cache shape.
  db.exec(`DROP TABLE dashboard_model_dimension_1h;
    DROP INDEX idx_analytics_execution_collected_at; DROP INDEX idx_analytics_model_collected_at; DROP INDEX idx_analytics_worker_event_collected_at;
    DROP TABLE dashboard_message_1h;
    CREATE TABLE dashboard_message_1h (
      bucket_start INTEGER NOT NULL CHECK (bucket_start >= 0),
      message_kind TEXT NOT NULL CHECK (message_kind IN ('user', 'assistant', 'runtime', 'system', 'compaction')),
      message_status TEXT NOT NULL,
      compaction_kind TEXT,
      message_count INTEGER NOT NULL CHECK (message_count >= 0),
      PRIMARY KEY (bucket_start, message_kind, message_status, compaction_kind)
    );`);
  db.prepare("UPDATE analytics_schema_meta SET schema_version=9").run();
  closeAnalyticsDb(db);

  const migrated = await openAnalyticsDb(dataDir, 3_600_001);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal(migrated.prepare("SELECT 1 FROM analytics_rollup_hour WHERE domain='model' AND bucket_start=0").get(), undefined);
  assert.ok(migrated.prepare("SELECT 1 FROM analytics_dirty_hour WHERE domain='model' AND bucket_start=0").get());
  assert.equal((migrated.prepare("SELECT rollup_ready_through FROM analytics_domain_state WHERE domain='model'").get() as { rollup_ready_through: number | null }).rollup_ready_through, null);
  const response = queryDashboard(migrated, { rangeKind: "custom", timezone: "UTC", from: 0, to: 3_600_000 }, 3_600_001);
  assert.equal(response.kind, "success");
  assert.equal(response.data.model.metrics.requestCount.value, 1);
});

async function createHistoricalV8Fixture(dataDir: string, withMarkers: boolean) {
  const db = await openAnalyticsDb(dataDir, 10);
  db.prepare("UPDATE analytics_domain_state SET rollup_ready_through=? WHERE domain IN ('model','tool','message')").run(3_600_000);
  db.prepare(`INSERT INTO analytics_model_call_fact(model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
    VALUES ('v8-model','e','r',1,'p','m',0,10,'completed','observed',NULL,2,3,5,'reported',NULL,NULL,0,0,NULL,10,10,10)`).run();
  db.prepare("INSERT INTO analytics_tool_fact VALUES('v8-tool','shell','known','completed',0,0,1,1,1,1)").run();
  db.prepare("INSERT INTO analytics_message_fact VALUES('v8-message','user','completed',NULL,NULL,'not_applicable',0,0,0)").run();
  if (withMarkers) for (const domain of ['model', 'tool', 'message']) db.prepare("INSERT INTO analytics_rollup_hour VALUES(?,?,10)").run(domain, 0);
  closeAnalyticsDb(db);

  const legacy = new Database(analyticsDbPath(dataDir));
  const oldModel = (legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_model_call_fact'").get() as { sql: string }).sql
    .replace(/,\s*check \(\(status\s*=\s*'running'\s+and\s+completion_quality\s*=\s*'unknown'\)\s+or\s+status\s*!=\s*'running'\)/i, "");
  const oldMessageRollup = (legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='dashboard_message_1h'").get() as { sql: string }).sql
    .replace(", compaction_source_quality TEXT NOT NULL CHECK (compaction_source_quality IN ('known', 'unknown', 'not_applicable'))", "")
    .replace(", compaction_source_quality)", ")");
  legacy.exec(`DROP INDEX idx_analytics_model_collected_at;
    DROP INDEX idx_analytics_execution_collected_at; DROP INDEX idx_analytics_worker_event_collected_at;
    ALTER TABLE analytics_model_call_fact RENAME TO historical_model;
    ${oldModel}; INSERT INTO analytics_model_call_fact SELECT * FROM historical_model; DROP TABLE historical_model;
    DROP TABLE dashboard_model_dimension_1h; DROP TABLE dashboard_message_1h; ${oldMessageRollup};
    ${withMarkers ? "" : "DROP TABLE analytics_rollup_hour;"}
    UPDATE analytics_schema_meta SET schema_version=8;`);
  legacy.close();
}

test("v8 migrates atomically to v11, invalidates all certified rollups, and preserves Facts", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v8-direct-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 10);
  db.prepare("UPDATE analytics_domain_state SET rollup_ready_through=? WHERE domain IN ('model','tool','message')").run(3_600_000);
  db.prepare(`INSERT INTO analytics_model_call_fact(model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
    VALUES ('v8-model','e','r',1,'p','m',0,10,'completed','observed',NULL,2,3,5,'reported',NULL,NULL,0,0,NULL,10,10,10)`).run();
  db.prepare("INSERT INTO analytics_tool_fact VALUES('v8-tool','shell','known','completed',0,0,1,1,1,1)").run();
  db.prepare("INSERT INTO analytics_message_fact VALUES('v8-message','user','completed',NULL,NULL,'not_applicable',0,0,0)").run();
  for (const domain of ['model', 'tool', 'message']) db.prepare("INSERT INTO analytics_rollup_hour VALUES(?,?,10)").run(domain, 0);
  db.exec("DROP TABLE dashboard_model_dimension_1h;");
  db.prepare("UPDATE analytics_schema_meta SET schema_version=8").run();
  closeAnalyticsDb(db);

  const migrated = await openAnalyticsDb(dataDir, 3_600_001);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_rollup_hour WHERE domain IN ('model','tool','message')").get() as { count: number }).count, 0);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_dirty_hour WHERE domain IN ('model','tool','message') AND bucket_start=0").get() as { count: number }).count, 3);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_domain_state WHERE domain IN ('model','tool','message') AND rollup_ready_through IS NULL").get() as { count: number }).count, 3);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_model_call_fact WHERE model_call_id='v8-model'").get() as { count: number }).count, 1);
});

for (const withMarkers of [true, false]) test(`historical pre-marker v8 ${withMarkers ? "with markers" : "without markers"} migrates from Facts`, async (t) => {
  const dataDir = await tempDataDir(`awb-analytics-v8-historical-${withMarkers ? "markers" : "no-markers"}-`);
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  await createHistoricalV8Fixture(dataDir, withMarkers);

  const migrated = await openAnalyticsDb(dataDir, 3_600_001);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_model_call_fact WHERE model_call_id='v8-model'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_tool_fact WHERE tool_id='v8-tool'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_message_fact WHERE message_id='v8-message'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_dirty_hour WHERE domain IN ('model','tool','message') AND bucket_start=0").get() as { count: number }).count, 3);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_domain_state WHERE domain IN ('model','tool','message') AND rollup_ready_through IS NULL").get() as { count: number }).count, 3);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_rollup_hour WHERE domain IN ('model','tool','message')").get() as { count: number }).count, 0);
  const dashboard = queryDashboard(migrated, { rangeKind: "custom", timezone: "UTC", from: 0, to: 3_600_000 }, 3_600_001);
  assert.equal(dashboard.kind, "success");
  assert.equal(dashboard.data.model.metrics.requestCount.value, 1);
});

test("injected v8 migration failure rolls back completely and a retry succeeds", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v8-fault-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  await createHistoricalV8Fixture(dataDir, false);
  await assert.rejects(() => openAnalyticsDb(dataDir, 3_600_001, { testFaultAt: "v8_after_dashboard_rebuild" }));

  const afterFailure = new Database(analyticsDbPath(dataDir), { readonly: true });
  assert.equal((afterFailure.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 8);
  assert.equal(afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analytics_rollup_hour'").get(), undefined);
  assert.ok(afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_message_1h'").get());
  afterFailure.close();

  const retried = await openAnalyticsDb(dataDir, 3_600_001);
  t.after(() => closeAnalyticsDb(retried));
  assert.equal((retried.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal((retried.prepare("SELECT COUNT(*) AS count FROM analytics_model_call_fact WHERE model_call_id='v8-model'").get() as { count: number }).count, 1);
});

test("invalid v8 layout fails closed without leaving a mixed migration schema", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v8-atomic-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 10);
  db.prepare("UPDATE analytics_schema_meta SET schema_version=8").run();
  db.exec("DROP TABLE dashboard_model_dimension_1h; DROP TABLE analytics_model_call_fact;");
  closeAnalyticsDb(db);
  await assert.rejects(() => openAnalyticsDb(dataDir, 3_600_001));
  const after = new Database(analyticsDbPath(dataDir), { readonly: true });
  assert.equal((after.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 8);
  assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_model_1h'").get() !== undefined, true);
  after.close();
});

test("incompatible Analytics schema is rejected before DDL changes", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-schema-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(analyticsDbPath(dataDir)), { recursive: true });
  const seed = new Database(analyticsDbPath(dataDir));
  seed.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sentinel VALUES (1, 'unchanged');");
  const before = seed.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  seed.close();

  await assert.rejects(() => openAnalyticsDb(dataDir));

  const afterDb = new Database(analyticsDbPath(dataDir), { readonly: true });
  const after = afterDb.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.deepEqual(after, before);
  assert.deepEqual(afterDb.prepare("SELECT * FROM sentinel").all(), [{ id: 1, value: "unchanged" }]);
  afterDb.close();
});

test("version mismatch is rejected before any Analytics DDL or metadata rewrite", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-version-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir);
  db.prepare("UPDATE analytics_schema_meta SET schema_version = ?").run(ANALYTICS_SCHEMA_VERSION + 1);
  const before = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const versionBefore = db.prepare("SELECT schema_version FROM analytics_schema_meta").get();
  closeAnalyticsDb(db);

  await assert.rejects(() => openAnalyticsDb(dataDir));

  const afterDb = new Database(analyticsDbPath(dataDir), { readonly: true });
  assert.deepEqual(afterDb.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), before);
  assert.deepEqual(afterDb.prepare("SELECT schema_version FROM analytics_schema_meta").get(), versionBefore);
  afterDb.close();
});

async function createDamagedCurrentDb(mutate: (db: Database.Database) => void) {
  const dataDir = await tempDataDir("awb-analytics-current-damage-");
  const valid = await openAnalyticsDb(dataDir);
  closeAnalyticsDb(valid);
  const damaged = new Database(analyticsDbPath(dataDir));
  mutate(damaged);
  damaged.close();
  return dataDir;
}

function replaceDomainStateTable(db: Database.Database, columns: string) {
  db.exec(`
    BEGIN;
    CREATE TABLE analytics_domain_state_damaged (${columns});
    INSERT INTO analytics_domain_state_damaged SELECT * FROM analytics_domain_state;
    DROP TABLE analytics_domain_state;
    ALTER TABLE analytics_domain_state_damaged RENAME TO analytics_domain_state;
    COMMIT;
  `);
}

function replaceConfigTable(db: Database.Database, columns: string) {
  db.exec(`
    BEGIN;
    CREATE TABLE analytics_domain_config_version_damaged (${columns});
    INSERT INTO analytics_domain_config_version_damaged SELECT * FROM analytics_domain_config_version;
    DROP TABLE analytics_domain_config_version;
    ALTER TABLE analytics_domain_config_version_damaged RENAME TO analytics_domain_config_version;
    COMMIT;
  `);
}

function snapshotPersistentState(dataDir: string) {
  const db = new Database(analyticsDbPath(dataDir), { readonly: true });
  try {
    const tableNames = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    const rows = (table: string, orderBy: string) => tableNames.has(table)
      ? db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()
      : null;
    return {
      journalMode: (db.pragma("journal_mode", { simple: true }) as string).toLowerCase(),
       objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
       meta: rows("analytics_schema_meta", "singleton"),
       domains: rows("analytics_domain_state", "domain"),
       configs: rows("analytics_domain_config_version", "collection_config_version"),
       watermarks: rows("analytics_collector_watermark", "domain"),
       runFacts: rows("analytics_run_fact", "run_id"), sessionFacts: rows("analytics_session_fact", "session_id"),
       messageFacts: rows("analytics_message_fact", "message_id"), toolFacts: rows("analytics_tool_fact", "tool_id")
     };
  } finally {
    db.close();
  }
}

function removeCreateTableCheck(db: Database.Database, table: string, fragment: string) {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
  assert.equal(current.sql.includes(fragment), true, `missing expected test fragment: ${fragment}`);
  const indexes: Record<string, string[]> = {
    analytics_run_fact: ["CREATE INDEX analytics_run_fact_created_run_id ON analytics_run_fact(created_at, run_id)", "CREATE INDEX analytics_run_fact_collected_at ON analytics_run_fact(collected_at)"],
    analytics_message_fact: ["CREATE INDEX analytics_message_fact_created_kind_status_compaction ON analytics_message_fact(created_at, message_kind, message_status, compaction_kind)", "CREATE INDEX analytics_message_fact_collected_at ON analytics_message_fact(collected_at)"],
    analytics_tool_fact: ["CREATE INDEX analytics_tool_fact_created_tool_name_status ON analytics_tool_fact(created_at, tool_name, status)", "CREATE INDEX analytics_tool_fact_collected_at ON analytics_tool_fact(collected_at)"]
  };
  const damaged = `${table}_damaged`;
  const create = current.sql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${damaged}`).replace(fragment, "");
  db.exec(`BEGIN; ${create}; INSERT INTO ${damaged} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${damaged} RENAME TO ${table}; ${indexes[table]?.join(";")}; COMMIT;`);
}

test("same-version structural or configuration damage fails closed without WAL/DDL changes", async (t) => {
  const cases: Array<{ name: string; mutate: (db: Database.Database) => void }> = [
    { name: "missing config table", mutate: (db) => db.exec("DROP TABLE analytics_domain_config_version") },
    { name: "missing domain table", mutate: (db) => db.exec("DROP TABLE analytics_domain_state") },
    { name: "missing dashboard rollup table", mutate: (db) => db.exec("DROP TABLE dashboard_model_1h") },
    { name: "missing fixed domain", mutate: (db) => db.prepare("DELETE FROM analytics_domain_state WHERE domain = 'git'").run() },
    { name: "invalid config JSON", mutate: (db) => db.prepare("UPDATE analytics_domain_config_version SET enabled_fact_domains_json = 'not-json'").run() },
    { name: "agent duration in fact config", mutate: (db) => db.prepare("UPDATE analytics_domain_config_version SET enabled_fact_domains_json = ?").run(JSON.stringify(["run", "session", "message", "tool", "execution", "model", "worker", "agent_duration"])) },
    { name: "missing required column", mutate: (db) => db.exec("ALTER TABLE analytics_domain_state DROP COLUMN last_error_code") },
    {
      name: "missing domain/status constraints",
      mutate: (db) => db.exec(`
        BEGIN;
        CREATE TABLE analytics_domain_state_damaged (
          domain TEXT PRIMARY KEY NOT NULL,
          collection_started_at INTEGER, reconciled_through INTEGER, rollup_ready_through INTEGER,
          retention_floor INTEGER, status TEXT NOT NULL, last_succeeded_at INTEGER,
          last_error_code TEXT, updated_at INTEGER NOT NULL
        );
        INSERT INTO analytics_domain_state_damaged SELECT * FROM analytics_domain_state;
        DROP TABLE analytics_domain_state;
        ALTER TABLE analytics_domain_state_damaged RENAME TO analytics_domain_state;
        COMMIT;
      `)
    },
    {
      name: "time column declared as TEXT",
      mutate: (db) => replaceDomainStateTable(db, `
        domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN ('model', 'run', 'execution', 'agent_duration', 'tool', 'message', 'session', 'worker', 'git')),
        collection_started_at TEXT, reconciled_through INTEGER, rollup_ready_through INTEGER,
        retention_floor INTEGER, status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'stale', 'unavailable', 'disabled')),
        last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER NOT NULL
      `)
    },
    {
      name: "status declared as BLOB",
      mutate: (db) => replaceDomainStateTable(db, `
        domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN ('model', 'run', 'execution', 'agent_duration', 'tool', 'message', 'session', 'worker', 'git')),
        collection_started_at INTEGER, reconciled_through INTEGER, rollup_ready_through INTEGER,
        retention_floor INTEGER, status BLOB NOT NULL CHECK (status IN ('healthy', 'degraded', 'stale', 'unavailable', 'disabled')),
        last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER NOT NULL
      `)
    },
    {
      name: "status is nullable",
      mutate: (db) => replaceDomainStateTable(db, `
        domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN ('model', 'run', 'execution', 'agent_duration', 'tool', 'message', 'session', 'worker', 'git')),
        collection_started_at INTEGER, reconciled_through INTEGER, rollup_ready_through INTEGER,
        retention_floor INTEGER, status TEXT CHECK (status IN ('healthy', 'degraded', 'stale', 'unavailable', 'disabled')),
        last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER NOT NULL
      `)
    },
    {
      name: "config primary key changed",
      mutate: (db) => replaceConfigTable(db, `
        collection_config_version TEXT NOT NULL UNIQUE,
        effective_at INTEGER NOT NULL,
        enabled_fact_domains_json TEXT NOT NULL,
        changed_at INTEGER NOT NULL
      `)
    },
    {
      name: "updated_at is nullable",
      mutate: (db) => replaceDomainStateTable(db, `
        domain TEXT PRIMARY KEY NOT NULL CHECK (domain IN ('model', 'run', 'execution', 'agent_duration', 'tool', 'message', 'session', 'worker', 'git')),
        collection_started_at INTEGER, reconciled_through INTEGER, rollup_ready_through INTEGER,
        retention_floor INTEGER, status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'stale', 'unavailable', 'disabled')),
        last_succeeded_at INTEGER, last_error_code TEXT, updated_at INTEGER
      `)
    },
    { name: "stored time is TEXT", mutate: (db) => db.prepare("UPDATE analytics_domain_state SET updated_at = 'not-a-unix-ms' WHERE domain = 'model'").run() }
  ];

  for (const current of cases) {
    const dataDir = await createDamagedCurrentDb(current.mutate);
    t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
    const before = snapshotPersistentState(dataDir);
    await assert.rejects(() => openAnalyticsDb(dataDir), current.name);
    assert.deepEqual(snapshotPersistentState(dataDir), before, current.name);
  }
});

test("collector v3 constraints, index order, stored types and persisted enums fail closed without mutation", async (t) => {
  const cases: Array<{ name: string; mutate: (db: Database.Database) => void }> = [
    { name: "missing collector index", mutate: (db) => db.exec("DROP INDEX analytics_run_fact_created_run_id") },
    { name: "wrong collector index order", mutate: (db) => db.exec("DROP INDEX analytics_tool_fact_created_tool_name_status; CREATE INDEX analytics_tool_fact_created_tool_name_status ON analytics_tool_fact(created_at, status, tool_name)") },
    { name: "missing watermark state check", mutate: (db) => db.exec(`CREATE TABLE watermark_bad (domain TEXT PRIMARY KEY NOT NULL, initial_anchor INTEGER NOT NULL, initial_floor_updated_at INTEGER NOT NULL, initial_floor_stable_id TEXT NOT NULL, durable_updated_at INTEGER NOT NULL, durable_stable_id TEXT NOT NULL, scan_anchor INTEGER, cycle_cursor_updated_at INTEGER, cycle_cursor_stable_id TEXT, cycle_state TEXT NOT NULL, reconciled_through INTEGER, updated_at INTEGER NOT NULL); INSERT INTO watermark_bad SELECT * FROM analytics_collector_watermark; DROP TABLE analytics_collector_watermark; ALTER TABLE watermark_bad RENAME TO analytics_collector_watermark`) },
    { name: "empty Run table missing non-negative time check", mutate: (db) => removeCreateTableCheck(db, "analytics_run_fact", " CHECK (created_at >= 0)") },
    { name: "empty Message table missing status check", mutate: (db) => removeCreateTableCheck(db, "analytics_message_fact", " CHECK (message_status IN ('streaming', 'completed', 'failed', 'cancelled', 'superseded'))") },
    { name: "empty Message table missing compaction invariant", mutate: (db) => removeCreateTableCheck(db, "analytics_message_fact", ",\n    CHECK ((compaction_kind IS NOT NULL AND compaction_source_quality = 'known') OR (compaction_kind IS NULL AND compaction_source_quality IN ('unknown', 'not_applicable')))") },
    { name: "empty Tool table missing status check", mutate: (db) => removeCreateTableCheck(db, "analytics_tool_fact", " CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'))") },
    { name: "empty Tool table missing duration invariant", mutate: (db) => removeCreateTableCheck(db, "analytics_tool_fact", ",\n    CHECK (completed_duration_ms IS NULL OR (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at AND completed_duration_ms = completed_at - started_at))") },
    { name: "invalid persisted fact enum", mutate: (db) => { db.pragma("ignore_check_constraints = ON"); db.prepare("INSERT INTO analytics_run_fact VALUES ('bad-enum', 'invalid', NULL, 'running', 'observed', NULL, 1, NULL, 1, 1)").run(); db.pragma("ignore_check_constraints = OFF"); } },
    { name: "invalid persisted Fact integer storage", mutate: (db) => { db.pragma("ignore_check_constraints = ON"); db.prepare("INSERT INTO analytics_session_fact VALUES ('bad-type', 'primary', 'not-a-ms', 1, 1)").run(); db.pragma("ignore_check_constraints = OFF"); } },
    { name: "invalid persisted watermark state", mutate: (db) => { db.pragma("ignore_check_constraints = ON"); db.prepare("INSERT INTO analytics_collector_watermark VALUES ('run', 1, 0, '', 0, '', NULL, NULL, NULL, 'bad-state', NULL, 1)").run(); db.pragma("ignore_check_constraints = OFF"); } }
  ];
  for (const current of cases) {
    const dataDir = await createDamagedCurrentDb(current.mutate);
    t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
    const before = snapshotPersistentState(dataDir);
    await assert.rejects(() => openAnalyticsDb(dataDir), current.name);
    assert.deepEqual(snapshotPersistentState(dataDir), before, current.name);
  }
});

test("v5 signal rows with invalid storage or cross-column values fail closed before WAL", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v5-corrupt-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 10);
  closeAnalyticsDb(db);
  const file = analyticsDbPath(dataDir);
  const corrupt = new Database(file);
  corrupt.pragma("ignore_check_constraints = ON");
  corrupt.prepare(`INSERT INTO analytics_producer_generation
    (domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, last_control_received_at, created_at)
    VALUES ('execution', 'agent_worker', 'agent_runner', 'bad', 'registered', 1, 2, NULL, NULL, 0, NULL, 0, NULL, 0, 1, 1)`).run();
  corrupt.close();
  const before = await fs.readFile(file);
  await assert.rejects(() => openAnalyticsDb(dataDir), /analytics database unavailable/);
  assert.deepEqual(await fs.readFile(file), before);
});

test("formal v4 signal cache migrates forward to v5 without touching collector facts", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v4-migration-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const current = await openAnalyticsDb(dataDir, 10);
  current.prepare("INSERT INTO analytics_session_fact (session_id, session_kind, created_at, source_updated_at, collected_at) VALUES ('kept', 'primary', 1, 1, 1)").run();
  closeAnalyticsDb(current);
  const legacy = new Database(analyticsDbPath(dataDir));
  legacy.exec(`
    DROP TABLE analytics_producer_slot; DROP TABLE analytics_producer_generation; DROP TABLE analytics_producer_checkpoint;
    DROP TABLE analytics_event_receipt; DROP TABLE analytics_signal_coverage_gap; DROP TABLE analytics_execution_fact;
    DROP TABLE analytics_model_call_fact; DROP TABLE analytics_worker_event_fact; DROP TABLE analytics_worker_live_snapshot;
    CREATE TABLE analytics_producer_slot (domain TEXT, producer_namespace TEXT, producer_id TEXT, expected_enabled INTEGER, updated_at INTEGER);
    CREATE TABLE analytics_producer_generation (domain TEXT, producer_namespace TEXT, producer_id TEXT, producer_generation TEXT, lifecycle TEXT, final_sequence INTEGER, committed_sequence INTEGER, max_observed_at INTEGER, earliest_open_started_at INTEGER, known_drop INTEGER, dropped_since_sequence INTEGER, outbox_pending INTEGER, oldest_pending_at INTEGER, loss_epoch INTEGER, last_control_received_at INTEGER, created_at INTEGER);
    CREATE TABLE analytics_producer_checkpoint (domain TEXT, producer_namespace TEXT, producer_id TEXT, producer_generation TEXT, committed_sequence INTEGER, max_observed_at INTEGER, earliest_open_started_at INTEGER, open_execution_count INTEGER, open_model_count INTEGER, known_drop INTEGER, dropped_since_sequence INTEGER, outbox_pending INTEGER, oldest_pending_at INTEGER, loss_epoch INTEGER, received_at INTEGER);
    CREATE TABLE analytics_event_receipt (event_id TEXT, producer_namespace TEXT, producer_id TEXT, producer_generation TEXT, sequence INTEGER, payload_version INTEGER, event_type TEXT, subject_identity TEXT, fingerprint TEXT, received_at INTEGER, committed_at INTEGER);
    CREATE TABLE analytics_signal_coverage_gap (gap_id TEXT, domain TEXT, producer_namespace TEXT, producer_id TEXT, producer_generation TEXT, gap_from INTEGER, gap_to INTEGER, cause TEXT, dropped_since_sequence INTEGER, recorded_at INTEGER, closed_at INTEGER);
    CREATE TABLE analytics_execution_fact (execution_id TEXT, run_id TEXT, run_kind TEXT, parent_run_id TEXT, started_at INTEGER, ended_at INTEGER, effective_ended_at INTEGER, state TEXT, collected_at INTEGER);
    CREATE TABLE analytics_model_call_fact (model_call_id TEXT, execution_id TEXT, run_id TEXT, provider_id TEXT, model_id TEXT, started_at INTEGER, ended_at INTEGER, status TEXT, timeout_kind TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, collected_at INTEGER);
    CREATE TABLE analytics_worker_event_fact (event_id TEXT, occurred_at INTEGER, event_type TEXT, runner_mode TEXT, collected_at INTEGER);
    CREATE TABLE analytics_worker_live_snapshot (runner_mode TEXT, snapshot_at INTEGER, active_count INTEGER, queue_length INTEGER, concurrency INTEGER, last_ready_at INTEGER, received_at INTEGER);
    UPDATE analytics_schema_meta SET schema_version=4;
  `);
  legacy.close();
  const migrated = await openAnalyticsDb(dataDir, 20); t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id='kept'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_execution_fact").get() as { count: number }).count, 0);
});

test("v6 to v7 migration preserves persisted signal generations, checkpoints, receipts and formal facts", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v6-migration-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  await createV6SignalFixture(dataDir);
  const migrated = await openAnalyticsDb(dataDir, 200);
  t.after(() => closeAnalyticsDb(migrated));

  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.deepEqual(migrated.prepare("SELECT lifecycle, known_drop, committed_sequence, control_sequence FROM analytics_producer_generation WHERE producer_generation='v6-generation'").get(), {
    lifecycle: "closed", known_drop: 0, committed_sequence: 1, control_sequence: 1,
  });
  assert.deepEqual(migrated.prepare("SELECT last_sequence, known_drop, control_sequence FROM analytics_producer_checkpoint WHERE producer_generation='v6-generation'").get(), {
    last_sequence: 1, known_drop: 0, control_sequence: 1,
  });
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_event_receipt WHERE event_id='v6-receipt'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_execution_fact WHERE execution_id='v6-execution'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM analytics_model_call_fact WHERE model_call_id='v6-model'").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT restart_attempt_id FROM analytics_worker_event_fact WHERE event_id='v6-worker'").get() as { restart_attempt_id: string }).restart_attempt_id, "attempt-v6");
});

test("invalid v6 signal structure fails closed before migration", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v6-invalid-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  await createV6SignalFixture(dataDir);
  const file = analyticsDbPath(dataDir);
  const legacy = new Database(file);
  legacy.exec("DROP TABLE analytics_producer_checkpoint");
  legacy.close();
  const before = await fs.readFile(file);
  await assert.rejects(() => openAnalyticsDb(dataDir, 201), /analytics database unavailable/);
  assert.deepEqual(await fs.readFile(file), before);
});

test("v12 worker-event migration is atomic and admits controlled-stop evidence", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v12-");
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const current = await openAnalyticsDb(dataDir, 100);
  closeAnalyticsDb(current);
  const legacy = new Database(analyticsDbPath(dataDir));
  createHistoricalSchemaForTest(legacy as any, 12);
  legacy.close();
  await assert.rejects(() => openAnalyticsDb(dataDir, 101, { testFaultAt: "v13_after_worker_event_rebuild" }));
  const afterFailure = new Database(analyticsDbPath(dataDir), { readonly: true });
  assert.equal((afterFailure.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 12);
  assert.equal(String((afterFailure.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_worker_event_fact'").get() as { sql: string }).sql).includes("controlled_stop"), false);
  afterFailure.close();
  const migrated = await openAnalyticsDb(dataDir, 102);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal(String((migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_worker_event_fact'").get() as { sql: string }).sql).includes("controlled_stop"), true);
});

for (const version of [11, 12, 13] as const) test(`real v${version} historical fixture has no later DDL and migrates to v14`, async (t) => {
  const dataDir = await tempDataDir(`awb-analytics-v${version}-fixture-`);
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const seed = await openAnalyticsDb(dataDir, 1); closeAnalyticsDb(seed);
  const fixture = new Database(analyticsDbPath(dataDir));
  createHistoricalSchemaForTest(fixture as any, version);
  const executionSql = String((fixture.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_execution_fact'").get() as { sql: string }).sql);
  const modelSql = String((fixture.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_model_call_fact'").get() as { sql: string }).sql);
  const workerSql = String((fixture.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_worker_event_fact'").get() as { sql: string }).sql);
  assert.equal(executionSql.includes("producer_namespace"), false);
  assert.equal(modelSql.includes("producer_namespace"), false);
  assert.equal(workerSql.includes("controlled_stop"), version === 13);
  assert.equal((fixture.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, version);
  fixture.exec(`INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at) VALUES ('historical-execution','run','agent_worker','user',NULL,NULL,1,NULL,NULL,'running','unknown',NULL,1,1,1);
    INSERT INTO analytics_model_call_fact (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at) VALUES ('historical-model','historical-execution','run',1,'p','m',1,NULL,'running','unknown',NULL,NULL,NULL,NULL,'unavailable',NULL,NULL,0,0,NULL,1,1,1);`);
  fixture.close();
  const migrated = await openAnalyticsDb(dataDir, 2); t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  assert.equal(String((migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_execution_fact'").get() as { sql: string }).sql).includes("producer_namespace"), true);
  assert.deepEqual(migrated.prepare("SELECT producer_namespace,producer_id,producer_generation FROM analytics_execution_fact WHERE execution_id='historical-execution'").get(), { producer_namespace: null, producer_id: null, producer_generation: null });
  assert.deepEqual(migrated.prepare("SELECT producer_namespace,producer_id,producer_generation FROM analytics_model_call_fact WHERE model_call_id='historical-model'").get(), { producer_namespace: null, producer_id: null, producer_generation: null });
});

for (const version of [11, 12, 13, 14, 15, 16, 17] as const) test(`historical v${version} migrates through the complete chain to v18`, async (t) => {
  const dataDir = await tempDataDir(`awb-analytics-v${version}-to-v18-`);
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const seed = await openAnalyticsDb(dataDir, 1);
  closeAnalyticsDb(seed);
  const fixture = new Database(analyticsDbPath(dataDir));
  createHistoricalSchemaForTest(fixture as any, version);
  assert.equal((fixture.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, version);
  fixture.close();
  const migrated = await openAnalyticsDb(dataDir, 2);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, ANALYTICS_SCHEMA_VERSION);
  const executionSql = String((migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_execution_fact'").get() as { sql: string }).sql);
  assert.equal(executionSql.includes("'inferred'"), true);
  assert.equal(executionSql.includes("'worker_exit'"), true);
  assert.deepEqual((migrated.prepare("PRAGMA index_info(idx_analytics_execution_open)").all() as Array<{ name: string }>).map((column) => column.name), ["producer_namespace", "producer_id", "producer_generation", "status", "started_at"]);
});

test("v17 to v18 execution rebuild rolls back atomically", async (t) => {
  const dataDir = await tempDataDir("awb-analytics-v17-v18-rollback-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const seed = await openAnalyticsDb(dataDir, 1);
  closeAnalyticsDb(seed);
  const fixture = new Database(analyticsDbPath(dataDir));
  createHistoricalSchemaForTest(fixture as any, 17);
  fixture.close();
  await assert.rejects(() => openAnalyticsDb(dataDir, 2, { testFaultAt: "v18_after_execution_rebuild" }));
  const rolledBack = new Database(analyticsDbPath(dataDir));
  assert.equal((rolledBack.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 17);
  rolledBack.close();
  const migrated = await openAnalyticsDb(dataDir, 3);
  t.after(() => closeAnalyticsDb(migrated));
  assert.equal((migrated.prepare("SELECT schema_version FROM analytics_schema_meta").get() as { schema_version: number }).schema_version, 18);
});
