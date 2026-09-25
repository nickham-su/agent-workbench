import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { DashboardQuerySuccessResponseSchema } from "@agent-workbench/shared";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { queryDashboard } from "./analytics-dashboard-query.js";
import {
  HOUR_MS,
  markDirtyHour,
  planUtcHourSources,
  rebuildCollectedRollup,
  rebuildDirtyRollups,
} from "./analytics-rollups.js";
import { applyAnalyticsRetention } from "./analytics-maintenance.js";

async function database() {
  const root = await mkdtemp(join(tmpdir(), "awb-dashboard-query-"));
  return openAnalyticsDb(root, 1_000);
}

test("dashboard query keeps unknown zero unavailable and returns a contract-valid 200 response", async () => {
  const db = await database();
  try {
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 0, to: 1_000 },
      1_000,
    );
    assert.equal(response.kind, "success");
    assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
    assert.equal(response.data.agent.metrics.runCount.status, "unavailable");
    assert.equal(response.data.overview.totalTokens.status, "unavailable");
  } finally {
    closeAnalyticsDb(db);
  }
});

test("cache coverage and hits use only verified provider-specific denominators in Fact and rollup paths", async () => {
  const db = await database();
  try {
    const hour = HOUR_MS;
    db.prepare("UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=?, rollup_ready_through=? WHERE domain='model'").run(4 * hour, 4 * hour);
    db.prepare("UPDATE analytics_domain_config_version SET enabled_fact_domains_json='[\"model\"]' WHERE collection_config_version='0000000000000000'").run();
    const insert = db.prepare(`INSERT INTO analytics_model_call_fact
      (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at,cache_input_tokens)
      VALUES (?,'exec','run',1,?,?,?,?,'completed','observed',NULL,?,?,?,'reported',?,NULL,?,0,NULL,?,?,?,?)`);
    const add = (id: string, provider: string, started: number, input: number, read: number | null, denominator: number | null) =>
      insert.run(id, provider, id, started, started + 5, input, 10, input + 10, read, denominator === null ? 0 : 1, started + 5, started + 5, started + 5, denominator);
    add("openai", "openai", hour + 100, 1_000, 900, 1_000);
    add("anthropic", "anthropic", hour + 200, 100, 900, 1_050);
    add("zero-hit", "openai", hour + 300, 100, 0, 100);
    add("unknown", "compatible", hour + 400, 100, 200, null);
    add("zero-input", "openai", 2 * hour + 100, 0, 0, 0);
    const request = { rangeKind: "custom" as const, timezone: "UTC", from: hour, to: 2 * hour };
    const values = () => {
      const response = queryDashboard(db, request, 4 * hour + 1);
      assert.equal(response.kind, "success");
      assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
      const byModel = response.data.model.byModel;
      assert.equal(byModel.status, "available");
      const unknown = byModel.data.find((row) => row.model === "unknown");
      assert.equal(unknown?.cacheReadTokens, null, "observed reads without a denominator do not inflate the comparable total");
      assert.equal(unknown?.cacheHitRate, null);
      return {
        coverage: response.data.model.metrics.inputCacheCoverage.value?.ratio,
        count: response.data.model.metrics.cacheComparableCount.value,
        reads: response.data.model.metrics.cacheReadTokens.value?.count,
        hit: response.data.overview.cacheHitRate.value?.ratio,
        trend: response.data.model.trends.cacheHitRate.data?.map((point) => point.ratio),
      };
    };
    const before = values();
    assert.equal(before.coverage, 3 / 4);
    assert.equal(before.count, 3);
    assert.equal(before.reads, 1_800);
    assert.equal(before.hit, 1_800 / 2_150);
    assert.ok(before.trend?.includes(1_800 / 2_150));
    for (const started of [hour + 100, 2 * hour + 100]) markDirtyHour(db, "model", started, 4 * hour);
    rebuildDirtyRollups(db, 4 * hour + 1);
    assert.deepEqual(values(), before, "hourly cache and Fact agree");
    const zero = queryDashboard(db, { rangeKind: "custom", timezone: "UTC", from: 2 * hour, to: 3 * hour }, 4 * hour + 1);
    assert.equal(zero.kind, "success");
    assert.equal(zero.data.model.metrics.inputCacheCoverage.value?.ratio, 1);
    assert.equal(zero.data.overview.cacheHitRate.value?.ratio, null, "0/0 is unknown, not a miss");
    db.prepare("UPDATE analytics_model_call_fact SET cache_read_tokens=5000 WHERE model_call_id='openai'").run();
    markDirtyHour(db, "model", hour + 100, 4 * hour);
    const invalidRate = () => {
      const response = queryDashboard(db, request, 4 * hour + 1);
      assert.equal(response.kind, "success");
      assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
      assert.equal(response.data.overview.cacheHitRate.value?.ratio, null, "invalid aggregate is not a >100% cache rate");
      assert.equal(response.data.model.byModel.data?.find((row) => row.model === "openai")?.cacheHitRate, null);
    };
    invalidRate();
    rebuildDirtyRollups(db, 4 * hour + 1);
    invalidRate();
  } finally {
    closeAnalyticsDb(db);
  }
});

test("monitoring volume retains an earlier enabled segment after disable and re-enable", async () => {
  const db = await database();
  try {
    db.prepare("DELETE FROM analytics_domain_config_version").run();
    const config = db.prepare(`INSERT INTO analytics_domain_config_version
      (collection_config_version,effective_at,enabled_fact_domains_json,changed_at) VALUES(?,?,?,?)`);
    config.run("0000000000000001", 1_000, '["run"]', 1_000);
    config.run("0000000000000002", 1_200, "[]", 1_200);
    config.run("0000000000000003", 1_300, '["run"]', 1_300);
    db.prepare(
      `UPDATE analytics_domain_state SET
      status='unavailable', collection_started_at=1_000,
      reconciled_through=1_150, last_succeeded_at=1_150
      WHERE domain='run'`,
    ).run();
    db.prepare(
      `INSERT INTO analytics_run_fact
      (run_id,run_kind,parent_run_id,display_status,status_quality,inferred_evidence_type,created_at,terminal_at,source_updated_at,collected_at)
      VALUES('historic-run','user',NULL,'completed','observed',NULL,1_100,1_100,1_100,1_100)`,
    ).run();

    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 1_050, to: 1_150 },
      1_400,
    );
    assert.equal(response.kind, "success");
    const volume = response.data.overview.monitoringVolume;
    assert.equal(volume.status, "available");
    assert.deepEqual(volume.requiredDomains, ["run"]);
    assert.equal(volume.value?.collectionConfigVersion, "0000000000000003");
    assert.deepEqual(volume.value?.configuredDomainsAtAsOf, ["run"]);
    assert.equal(volume.value?.configurationChangedWithinRange, false);
  } finally {
    closeAnalyticsDb(db);
  }
});

test("Health 每个 slot 展示全部 nonterminal generations，并保留旧 stale 与新 healthy 的诊断", async () => {
  const db = await database();
  try {
    db.prepare(
      `INSERT INTO analytics_producer_slot(domain,producer_namespace,producer_id,expected_enabled,config_version,updated_at)
      VALUES ('execution','agent_worker','agent_runner',1,'1',1)`,
    ).run();
    const generation = db.prepare(`INSERT INTO analytics_producer_generation
      (domain,producer_namespace,producer_id,producer_generation,lifecycle,final_sequence,committed_sequence,max_observed_at,earliest_open_started_at,known_drop,dropped_since_sequence,outbox_pending,oldest_pending_at,loss_epoch,control_sequence,last_control_received_at,created_at)
      VALUES ('execution','agent_worker','agent_runner',?, ?,NULL,0,100,NULL,0,NULL,0,NULL,0,1,100,?)`);
    generation.run("old-stale", "stale", 10);
    generation.run("new-healthy", "registered", 20);
    const checkpoint = db.prepare(`INSERT INTO analytics_producer_checkpoint
      (domain,producer_namespace,producer_id,producer_generation,last_sequence,max_observed_at,earliest_open_started_at,open_execution_count,open_model_count,known_drop,dropped_since_sequence,outbox_pending,oldest_pending_at,loss_epoch,control_sequence,received_at)
      VALUES ('execution','agent_worker','agent_runner',?,0,100,NULL,0,0,0,NULL,0,NULL,0,1,?)`);
    checkpoint.run("old-stale", 100);
    checkpoint.run("new-healthy", 1_000);
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 0, to: 1_000 },
      1_000,
    );
    assert.equal(response.kind, "success");
    const row = response.data.exceptions.domainHealth.data!.find(
      (item) => item.domain === "execution",
    )!;
    assert.equal(row.expectedSlotCount, 1);
    assert.equal(row.activeGenerationCount, 2);
    assert.deepEqual(row.slots.map((slot) => slot.producerGeneration).sort(), [
      "new-healthy",
      "old-stale",
    ]);
    assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
  } finally {
    closeAnalyticsDb(db);
  }
});

test("dashboard query exposes certified Model aggregates without changing unavailable domains", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=1000 WHERE domain='model'",
    ).run();
    db.prepare(
      `INSERT INTO analytics_model_call_fact(model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
      VALUES ('model-1','execution-1','run-1',1,'provider','model',100,300,'completed','observed',NULL,4,6,10,'reported',2,NULL,1,0,NULL,300,300,300)`,
    ).run();
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 0, to: 1_000 },
      1_000,
    );
    assert.equal(response.kind, "success");
    assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
    assert.deepEqual(response.data.model.metrics.requestCount.value, 1);
    assert.deepEqual(
      response.data.model.metrics.completedAverageDuration.value,
      { durationMs: 200, reliableSampleCount: 1 },
    );
    assert.equal(response.data.agent.metrics.runCount.status, "unavailable");
  } finally {
    closeAnalyticsDb(db);
  }
});

test("overview total Token uses the Model metric's reported/derived samples and local DST buckets", async () => {
  const db = await database();
  try {
    const from = Date.parse("2025-03-09T06:00:00Z");
    const to = from + 4 * HOUR_MS;
    db.prepare("UPDATE analytics_domain_state SET status='healthy',collection_started_at=?,reconciled_through=? WHERE domain='model'").run(from, to);
    const insert = db.prepare(`INSERT INTO analytics_model_call_fact
      (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
      VALUES (?, 'execution','run',1,'provider','model',?,?,'completed','observed',NULL,?,?,?, ?,NULL,NULL,0,0,NULL,?,?,?)`);
    const put = (id: string, at: number, input: number | null, output: number | null, total: number | null, source: string) =>
      insert.run(id, at, at + 1, input, output, total, source, at + 1, at + 1, at + 1);
    put("reported", from, null, null, 12, "reported");
    put("derived", from + HOUR_MS, 2, 6, 8, "derived");
    put("mixed-unknown", from + HOUR_MS + 1, null, null, null, "unavailable");
    put("unknown", from + 2 * HOUR_MS, null, null, null, "unavailable");
    put("outside", to, 10, 10, 20, "reported");
    const result = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(result.kind, "success");
    assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, result));
    assert.deepEqual(result.data.overview.totalTokens, result.data.model.metrics.totalTokens);
    assert.equal(result.data.overview.totalTokens.status, "available");
    assert.deepEqual(result.data.overview.totalTokens.value, { count: null }, "known usage cannot masquerade as a complete total");
    assert.equal(result.data.overview.totalTokens.comparison.status, "previous_not_covered");
    const trend = result.data.overviewTrends.totalTokens;
    assert.equal(trend.status, "available");
    const bucketFor = (at: number) => trend.data?.find((point) => point.from <= at && point.to > at);
    assert.equal(bucketFor(from)?.count, 12);
    assert.equal(bucketFor(from + HOUR_MS)?.count, null, "a bucket with both known and unknown usage is unknown");
    assert.equal(bucketFor(from + 2 * HOUR_MS)?.count, null, "a bucket with only unknown usage is unknown");
    assert.equal(bucketFor(from + 3 * HOUR_MS)?.count, 0, "an empty covered bucket is an observed zero");
    const springHours = trend.data?.map((point) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(point.from)) ?? [];
    assert.equal(springHours.includes("02"), false);

    for (const at of [from, from + HOUR_MS, from + 2 * HOUR_MS]) markDirtyHour(db, "model", at, to);
    rebuildDirtyRollups(db, to + HOUR_MS);
    assert.deepEqual(db.prepare("SELECT request_count,total_reported_count,total_derived_count FROM dashboard_model_dimension_1h WHERE bucket_start=?").get(from + HOUR_MS),
      { request_count: 2, total_reported_count: 0, total_derived_count: 1 });
    const cached = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(cached.kind, "success");
    assert.deepEqual(cached.data.overview.totalTokens.value, { count: null });
    assert.equal(cached.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + HOUR_MS && point.to > from + HOUR_MS)?.count, null);

    db.prepare("UPDATE analytics_domain_state SET status='degraded' WHERE domain='model'").run();
    const partial = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(partial.kind, "success");
    assert.equal(partial.data.overview.totalTokens.status, "partial");
    assert.equal(partial.data.overviewTrends.totalTokens.status, "partial");
    assert.deepEqual(partial.data.overview.totalTokens.value, { count: null });
    assert.equal(partial.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + 3 * HOUR_MS && point.to > from + 3 * HOUR_MS)?.count, null,
      "do not certify an empty bucket while the domain is degraded");
    db.prepare("UPDATE analytics_domain_state SET status='healthy' WHERE domain='model'").run();

    db.prepare("UPDATE analytics_model_call_fact SET total_tokens=0,total_source='reported' WHERE model_call_id IN ('mixed-unknown','unknown')").run();
    markDirtyHour(db, "model", from + HOUR_MS, to);
    markDirtyHour(db, "model", from + 2 * HOUR_MS, to);
    const allKnown = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(allKnown.kind, "success");
    assert.deepEqual(allKnown.data.overview.totalTokens.value, { count: 20 });
    assert.deepEqual(allKnown.data.model.metrics.totalTokens.value, { count: 20 });
    assert.equal(allKnown.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + HOUR_MS && point.to > from + HOUR_MS)?.count, 8);
    assert.equal(allKnown.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + 2 * HOUR_MS && point.to > from + 2 * HOUR_MS)?.count, 0);

    db.prepare("UPDATE analytics_domain_state SET reconciled_through=? WHERE domain='model'").run(from + 2 * HOUR_MS);
    const incompleteCoverage = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(incompleteCoverage.kind, "success");
    assert.equal(incompleteCoverage.data.overview.totalTokens.status, "partial");
    assert.equal(incompleteCoverage.data.overviewTrends.totalTokens.status, "partial");
    assert.equal(incompleteCoverage.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + 3 * HOUR_MS && point.to > from + 3 * HOUR_MS)?.count, null);
    db.prepare("UPDATE analytics_domain_state SET reconciled_through=? WHERE domain='model'").run(to);

    db.prepare("DELETE FROM analytics_model_call_fact WHERE model_call_id IN ('reported','derived')").run();
    markDirtyHour(db, "model", from, to);
    const zeroUsage = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(zeroUsage.kind, "success");
    assert.deepEqual(zeroUsage.data.overview.totalTokens.value, { count: 0 });

    db.prepare("UPDATE analytics_model_call_fact SET total_tokens=NULL,total_source='unavailable' WHERE model_call_id IN ('mixed-unknown','unknown')").run();
    const noUsage = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(noUsage.kind, "success");
    assert.deepEqual(noUsage.data.overview.totalTokens.value, { count: null });
    assert.equal(noUsage.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + HOUR_MS && point.to > from + HOUR_MS)?.count, null);
    assert.equal(noUsage.data.overviewTrends.totalTokens.data?.find((point) => point.from <= from + 3 * HOUR_MS && point.to > from + 3 * HOUR_MS)?.count, 0);

    db.prepare("DELETE FROM analytics_model_call_fact WHERE model_call_id IN ('mixed-unknown','unknown')").run();
    const noCalls = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(noCalls.kind, "success");
    assert.deepEqual(noCalls.data.overview.totalTokens.value, { count: 0 });
    assert.equal(noCalls.data.overviewTrends.totalTokens.data?.every((point) => point.count === 0), true);
    db.prepare("UPDATE analytics_domain_state SET status='degraded' WHERE domain='model'").run();
    const unverifiedZero = queryDashboard(db, { rangeKind: "custom", timezone: "America/New_York", from, to }, to);
    assert.equal(unverifiedZero.kind, "success");
    assert.equal(unverifiedZero.data.overview.totalTokens.status, "unavailable");
    assert.equal(unverifiedZero.data.overview.totalTokens.value, null);
    assert.equal(unverifiedZero.data.overviewTrends.totalTokens.status, "unavailable");
  } finally {
    closeAnalyticsDb(db);
  }
});

test("dirty Model hour reads facts until a successful replacement makes the rollup ready", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=999999999, rollup_ready_through=0 WHERE domain='model'",
    ).run();
    db.prepare(
      `INSERT INTO analytics_model_call_fact(model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
      VALUES ('m','e','r',1,'p','m',0,100,'completed','observed',NULL,1,2,3,'reported',NULL,NULL,0,0,NULL,100,100,100)`,
    ).run();
    markDirtyHour(db, "model", 0, 100);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM analytics_dirty_hour")
          .get() as { count: number }
      ).count,
      1,
    );
    rebuildDirtyRollups(db, 3_600_000 + 1);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM analytics_dirty_hour")
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT request_count FROM dashboard_model_1h WHERE bucket_start=0",
          )
          .get() as { request_count: number }
      ).request_count,
      1,
    );
    db.prepare(
      "INSERT INTO analytics_tool_fact VALUES('t','shell','known','completed',0,0,10,10,10,10)",
    ).run();
    db.prepare(
      "INSERT INTO analytics_message_fact VALUES('msg','user','completed',NULL,NULL,'not_applicable',0,0,0)",
    ).run();
    markDirtyHour(db, "tool", 0, 100);
    markDirtyHour(db, "message", 0, 100);
    rebuildDirtyRollups(db, HOUR_MS + 1);
    assert.deepEqual(
      db
        .prepare(
          "SELECT call_count FROM dashboard_tool_1h WHERE bucket_start=0",
        )
        .get(),
      { call_count: 1 },
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT message_count FROM dashboard_message_1h WHERE bucket_start=0",
        )
        .get(),
      { message_count: 1 },
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM analytics_rollup_hour WHERE bucket_start=0",
          )
          .get() as { count: number }
      ).count,
      3,
    );
  } finally {
    closeAnalyticsDb(db);
  }
});

test("Message cards, trends, distribution and compaction use one hourly Fact/Rollup source", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=?, rollup_ready_through=0 WHERE domain IN ('message','run')",
    ).run(2 * HOUR_MS);
    db.prepare(
      "INSERT INTO analytics_message_fact VALUES('u','user','completed',NULL,NULL,'not_applicable',100,100,100)",
    ).run();
    db.prepare(
      "INSERT INTO analytics_message_fact VALUES('c','compaction','completed',NULL,'manual','known',200,200,200)",
    ).run();
    markDirtyHour(db, "message", 0, 100);
    rebuildDirtyRollups(db, HOUR_MS + 1);
    // The certified replacement remains authoritative even after Facts change.
    db.prepare("DELETE FROM analytics_message_fact").run();
    let response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 0, to: HOUR_MS },
      2 * HOUR_MS,
    );
    assert.equal(response.kind, "success");
    assert.equal(response.data.agent.metrics.userMessageCount.value, 1);
    assert.equal(response.data.agent.metrics.manualCompactionCount.value, 1);
    assert.deepEqual(response.data.agent.messageTypeDistribution.data, [
      { type: "compaction", count: 1 },
      { type: "user", count: 1 },
    ]);
    // A dirty hour invalidates every Message resource's cached source together.
    db.prepare(
      "INSERT INTO analytics_message_fact VALUES('u2','user','completed',NULL,NULL,'not_applicable',100,100,100)",
    ).run();
    db.prepare(
      "INSERT INTO analytics_message_fact VALUES('u3','user','completed',NULL,NULL,'not_applicable',200,200,200)",
    ).run();
    markDirtyHour(db, "message", 0, 100);
    response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 0, to: HOUR_MS },
      2 * HOUR_MS,
    );
    assert.equal(response.kind, "success");
    assert.equal(response.data.agent.metrics.userMessageCount.value, 2);
    assert.deepEqual(response.data.agent.messageTypeDistribution.data, [
      { type: "user", count: 2 },
    ]);
  } finally {
    closeAnalyticsDb(db);
  }
});

test("hour source planner never crosses dirty or missing-rollup holes", () => {
  const plan = planUtcHourSources({
    domain: "tool",
    from: 0,
    to: 3 * HOUR_MS,
    rollupReadyThrough: 3 * HOUR_MS,
    dirtyHours: new Set([HOUR_MS]),
    rebuiltHours: new Set([0, 2 * HOUR_MS]),
    coverageEstablished: () => true,
  });
  assert.deepEqual(
    plan.map((entry) => entry.source),
    ["rollup", "fact", "fact"],
  );
  const partial = planUtcHourSources({
    domain: "message",
    from: 1,
    to: HOUR_MS + 1,
    rollupReadyThrough: 2 * HOUR_MS,
    dirtyHours: new Set(),
    rebuiltHours: new Set([0, HOUR_MS]),
    coverageEstablished: () => true,
  });
  assert.deepEqual(
    partial.map((entry) => entry.source),
    ["fact", "fact"],
  );
});

test("collected replacement is exact for partial hours, zero Git, and stopped-child catch-up", async () => {
  const db = await database();
  try {
    db.prepare(
      "INSERT INTO analytics_run_fact(run_id,run_kind,parent_run_id,display_status,status_quality,inferred_evidence_type,created_at,terminal_at,source_updated_at,collected_at) VALUES('r','user',NULL,'completed','observed',NULL,1,1,1,100)",
    ).run();
    rebuildCollectedRollup(db, 0, 3 * HOUR_MS, 3 * HOUR_MS);
    assert.deepEqual(
      db
        .prepare(
          "SELECT fact_count FROM dashboard_collected_1h WHERE bucket_start=0 AND domain='run'",
        )
        .get(),
      { fact_count: 1 },
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT fact_count FROM dashboard_collected_1h WHERE bucket_start=? AND domain='model'",
        )
        .get(2 * HOUR_MS),
      { fact_count: 0 },
    );
    db.prepare("DELETE FROM analytics_run_fact").run();
    rebuildCollectedRollup(db, 0, HOUR_MS, 4 * HOUR_MS);
    assert.deepEqual(
      db
        .prepare(
          "SELECT fact_count FROM dashboard_collected_1h WHERE bucket_start=0 AND domain='run'",
        )
        .get(),
      { fact_count: 0 },
    );
  } finally {
    closeAnalyticsDb(db);
  }
});

test("duration trend splits a reliable top-level execution across every hour", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy',collection_started_at=0,reconciled_through=? WHERE domain IN ('execution','agent_duration')",
    ).run(3 * HOUR_MS);
    db.prepare(
      `INSERT INTO analytics_execution_fact
      (execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
      VALUES ('e','r','agent_worker','user',NULL,0,1800000,9000000,9000000,'ended','inferred','worker_exit',1,1,1)`,
    ).run();
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 0, to: 3 * HOUR_MS },
      3 * HOUR_MS,
    );
    assert.equal(response.kind, "success");
    assert.equal(response.data.agent.metrics.totalDuration.value, 7_200_000);
    assert.deepEqual(
      response.data.agent.trends.totalDuration.data?.map(
        (point) => point.durationMs,
      ),
      [1_800_000, 3_600_000, 1_800_000],
    );
  } finally {
    closeAnalyticsDb(db);
  }
});

test("comparison uses the equal previous window and never divides by zero", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=2000 WHERE domain='run'",
    ).run();
    const insert =
      db.prepare(`INSERT INTO analytics_run_fact(run_id,run_kind,parent_run_id,display_status,status_quality,inferred_evidence_type,created_at,terminal_at,source_updated_at,collected_at)
      VALUES(?, 'user', NULL, 'completed', 'observed', NULL, ?, ?, ?, ?)`);
    insert.run("previous", 500, 500, 500, 500);
    insert.run("current-1", 1100, 1100, 1100, 1100);
    insert.run("current-2", 1200, 1200, 1200, 1200);
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 1000, to: 2000 },
      2000,
    );
    assert.equal(response.kind, "success");
    assert.deepEqual(response.data.agent.metrics.runCount.comparison, {
      status: "available",
      delta: 1,
      kind: "relative",
    });
    assert.deepEqual(response.data.agent.runTerminalDistribution.comparison, {
      status: "not_applicable",
      delta: null,
      kind: null,
    });
    assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
  } finally {
    closeAnalyticsDb(db);
  }
});

test("ratio and average comparisons use range aggregates without exposing them in the DTO", async () => {
  const db = await database();
  try {
    const hour = 3_600_000;
    db.prepare("UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=? WHERE domain='model'").run(3 * hour);
    db.prepare("UPDATE analytics_domain_config_version SET enabled_fact_domains_json='[\"model\"]' WHERE collection_config_version='0000000000000000'").run();
    const insert = db.prepare(`INSERT INTO analytics_model_call_fact
      (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at,cache_input_tokens)
      VALUES (?,?,?,1,'provider','model',?,?,?,'observed',NULL,?,0,?,'reported',?,NULL,1,0,NULL,?,?,?,?)`);
    const add = (id: string, status: "completed" | "failed", startedAt: number, duration: number, input: number, cacheRead: number) =>
      insert.run(id, `execution:${id}`, `run:${id}`, startedAt, startedAt + duration, status, input, input, cacheRead, startedAt + duration, startedAt + duration, startedAt + duration, input);
    // Previous range has a real zero timeout/cache ratio and a 50 ms duration baseline.
    add("previous-failed", "failed", 100, 1, 100, 0);
    add("previous-duration", "completed", 200, 50, 100, 0);
    // Current: the rates span uneven buckets; duration is 1×100 ms + 100×10 ms.
    add("current-long", "completed", hour + 100, 100, 100, 100);
    for (let index = 0; index < 100; index++)
      add(`current-short-${index}`, "completed", hour + 1_000 + index, 10, 100, 0);
    for (let index = 0; index < 100; index++)
      add(`current-failed-${index}`, "failed", hour + 2_000 + index, 1, 100, 0);
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: hour + 1, to: 2 * hour - 1 },
      3 * hour,
    );
    assert.equal(response.kind, "success");
    const currentSuccess = 101 / 201;
    const currentCache = 100 / 20_100;
    assert.deepEqual(response.data.model.metrics.timeoutRate.comparison, {
      status: "available", delta: 0, kind: "percentage_points",
    }, "a previous observed zero is not a zero denominator");
    assert.deepEqual(response.data.model.metrics.successRate.comparison, {
      status: "available", delta: currentSuccess - 0.5, kind: "percentage_points",
    });
    assert.deepEqual(response.data.model.metrics.completedAverageDuration.comparison, {
      status: "available", delta: ((1_100 / 101) - 50) / 50, kind: "relative",
    });
    assert.deepEqual(response.data.overview.cacheHitRate.comparison, {
      status: "available", delta: currentCache, kind: "percentage_points",
    });
    assert.deepEqual(response.data.model.trends.cacheHitRate.comparison, {
      status: "available", delta: currentCache, kind: "percentage_points",
    });
    assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes('"numerator"'), false);
    assert.equal(serialized.includes('"denominator"'), false);
    assert.equal(serialized.includes('"samples"'), false);
  } finally {
    closeAnalyticsDb(db);
  }
});

test("primary and subtask Run definitions exclude compaction and parented user Runs", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=2000 WHERE domain='run'",
    ).run();
    const insert =
      db.prepare(`INSERT INTO analytics_run_fact(run_id,run_kind,parent_run_id,display_status,status_quality,inferred_evidence_type,created_at,terminal_at,source_updated_at,collected_at)
      VALUES(?, ?, ?, 'completed', 'observed', NULL, 1100, 1100, 1100, 1100)`);
    insert.run("top-user", "user", null);
    insert.run("manual-compaction", "manual_compaction", null);
    insert.run("subtask", "subtask", "top-user");
    insert.run("parented-user", "user", "top-user");
    const response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 1000, to: 2000 },
      2000,
    );
    assert.equal(response.kind, "success");
    assert.equal(response.data.agent.metrics.primaryRunCount.value, 1);
    assert.equal(response.data.agent.metrics.subtaskRunCount.value, 1);
    assert.deepEqual(
      response.data.agent.trends.primaryRunCount.data?.map(
        (point) => point.count,
      ),
      [1],
    );
    assert.deepEqual(
      response.data.agent.trends.subtaskRunCount.data?.map(
        (point) => point.count,
      ),
      [1],
    );
    assert.equal(
      response.data.agent.runTypeDistribution.data?.find(
        (row) => row.kind === "primary",
      )?.count,
      1,
    );
    assert.equal(
      response.data.agent.runTypeDistribution.data?.find(
        (row) => row.kind === "subtask",
      )?.count,
      1,
    );
  } finally {
    closeAnalyticsDb(db);
  }
});

test("comparison keeps partial and realtime resources non-comparable and handles a zero baseline", async () => {
  const db = await database();
  try {
    db.prepare(
      "UPDATE analytics_domain_state SET status='healthy', collection_started_at=0, reconciled_through=? WHERE domain='run'",
    ).run(2_000);
    db.prepare(
      "INSERT INTO analytics_run_fact VALUES('current','user',NULL,'completed','observed',NULL,1100,1100,1100,1100)",
    ).run();
    let response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 1000, to: 2000 },
      2000,
    );
    assert.equal(response.kind, "success");
    assert.deepEqual(response.data.agent.metrics.runCount.comparison, {
      status: "previous_zero",
      delta: null,
      kind: null,
    });
    db.prepare(
      "UPDATE analytics_domain_state SET status='stale' WHERE domain='run'",
    ).run();
    response = queryDashboard(
      db,
      { rangeKind: "custom", timezone: "UTC", from: 1000, to: 2000 },
      2000,
    );
    assert.equal(response.kind, "success");
    assert.equal(response.data.agent.metrics.runCount.status, "partial");
    assert.deepEqual(response.data.agent.metrics.runCount.comparison, {
      status: "previous_not_covered",
      delta: null,
      kind: null,
    });
    response = queryDashboard(
      db,
      { rangeKind: "preset_90d", timezone: "UTC" },
      200 * 24 * HOUR_MS,
    );
    assert.equal(response.kind, "success");
    assert.deepEqual(response.data.exceptions.domainHealth.comparison, {
      status: "not_applicable",
      delta: null,
      kind: null,
    });
    assert.deepEqual(response.data.exceptions.workerLiveSnapshot.comparison, {
      status: "not_applicable",
      delta: null,
      kind: null,
    });
  } finally {
    closeAnalyticsDb(db);
  }
});

test("retention keeps open signal facts while pruning completed facts and receipt buckets", async () => {
  const db = await database();
  try {
    db.prepare(
      `INSERT INTO analytics_execution_fact(execution_id,run_id,runtime_kind,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
      VALUES ('open','r','agent_worker','main',NULL,0,0,NULL,NULL,'running','unknown',NULL,0,0,0),('done','r','agent_worker','main',NULL,0,0,1,1,'ended','observed','completed',1,1,0)`,
    ).run();
    db.prepare(
      `INSERT INTO analytics_model_call_fact(model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
      VALUES ('observed','e','r',1,'p','m',0,1,'completed','observed',NULL,NULL,NULL,NULL,'unavailable',NULL,NULL,0,0,NULL,1,1,0),('unknown','e','r',2,'p','m',0,1,'failed','unknown',NULL,NULL,NULL,NULL,'unavailable',NULL,NULL,0,0,'provider',1,1,0)`,
    ).run();
    applyAnalyticsRetention(db, 1_000, 10);
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM analytics_execution_fact WHERE execution_id='open'",
        )
        .get(),
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM analytics_execution_fact WHERE execution_id='done'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM analytics_model_call_fact WHERE model_call_id='observed'",
        )
        .get(),
      undefined,
    );
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM analytics_model_call_fact WHERE model_call_id='unknown'",
        )
        .get(),
    );
  } finally {
    closeAnalyticsDb(db);
  }
});
