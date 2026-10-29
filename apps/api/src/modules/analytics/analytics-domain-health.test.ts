import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { DashboardQuerySuccessResponseSchema } from "@agent-workbench/shared";
import { closeAnalyticsDb, openAnalyticsDb, type AnalyticsDb } from "./analytics-db.js";
import { queryDashboard } from "./analytics-dashboard-query.js";

const NOW = 120_000;
const emptyCollection = {
  lastActivityAt: null as number | null,
  freshSlotCount: 0,
  staleSlotCount: 0,
  missingGenerationSlotCount: 0,
  missingCheckpointSlotCount: 0,
  closingSlotCount: 0,
};

async function database(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "awb-current-collection-"));
  const db = await openAnalyticsDb(root, 1_000);
  t.after(async () => {
    closeAnalyticsDb(db);
    await rm(root, { recursive: true, force: true });
  });
  return db;
}

type SlotInput = {
  domain?: "execution" | "model" | "worker";
  producer?: "agent_worker" | "api_local_fallback";
  generation?: string;
  lifecycle?: "registered" | "stale" | "closing" | "closed" | "abandoned";
  checkpointAt?: number | null;
  createdAt?: number;
  expected?: boolean;
};
function slot(db: AnalyticsDb, input: SlotInput) {
  const domain = input.domain ?? "execution";
  const namespace = domain === "worker" ? "worker_observer" : input.producer ?? "agent_worker";
  const id = domain === "worker" ? "process_manager" : namespace === "api_local_fallback" ? "api_local_fallback" : "agent_runner";
  db.prepare(`INSERT INTO analytics_producer_slot
    (domain,producer_namespace,producer_id,expected_enabled,config_version,updated_at)
    VALUES(?,?,?,?, '1',1) ON CONFLICT(domain,producer_namespace,producer_id) DO NOTHING`)
    .run(domain, namespace, id, input.expected === false ? 0 : 1);
  if (!input.generation) return;
  db.prepare(`INSERT INTO analytics_producer_generation
    (domain,producer_namespace,producer_id,producer_generation,lifecycle,final_sequence,committed_sequence,max_observed_at,earliest_open_started_at,known_drop,dropped_since_sequence,outbox_pending,oldest_pending_at,loss_epoch,control_sequence,last_control_received_at,created_at)
    VALUES(?,?,?,?,?,NULL,0,NULL,NULL,0,NULL,0,NULL,0,1,?,?)`)
    .run(domain, namespace, id, input.generation, input.lifecycle ?? "registered", input.checkpointAt ?? 1, input.createdAt ?? 1);
  if (input.checkpointAt == null) return;
  db.prepare(`INSERT INTO analytics_producer_checkpoint
    (domain,producer_namespace,producer_id,producer_generation,last_sequence,max_observed_at,earliest_open_started_at,open_execution_count,open_model_count,known_drop,dropped_since_sequence,outbox_pending,oldest_pending_at,loss_epoch,control_sequence,received_at)
    VALUES(?,?,?,?,0,NULL,NULL,0,0,0,NULL,0,NULL,0,1,?)`)
    .run(domain, namespace, id, input.generation, input.checkpointAt);
}
function response(db: AnalyticsDb) {
  const result = queryDashboard(db, { rangeKind: "custom", timezone: "UTC", from: 0, to: NOW }, NOW);
  assert.equal(result.kind, "success");
  assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, result));
  return result;
}
function health(db: AnalyticsDb, domain = "execution") {
  return response(db).data.exceptions.domainHealth.data!.find((row) => row.domain === domain)!;
}

const cases: Array<{
  name: string;
  slots: SlotInput[];
  status: "healthy" | "stale" | "degraded" | "disabled";
  collection: Partial<typeof emptyCollection>;
  disabled?: boolean;
}> = [
  { name: "fresh registered candidate", slots: [{ generation: "running", checkpointAt: NOW }], status: "healthy", collection: { freshSlotCount: 1, lastActivityAt: NOW } },
  { name: "15s stale lifecycle still has a fresh 60s collection checkpoint", slots: [{ generation: "running", lifecycle: "stale", checkpointAt: NOW - 16_000 }], status: "healthy", collection: { freshSlotCount: 1, lastActivityAt: NOW - 16_000 } },
  { name: "exact 60s boundary is fresh", slots: [{ generation: "running", checkpointAt: NOW - 60_000 }], status: "healthy", collection: { freshSlotCount: 1, lastActivityAt: NOW - 60_000 } },
  { name: "over 60s is stale", slots: [{ generation: "running", checkpointAt: NOW - 60_001 }], status: "stale", collection: { staleSlotCount: 1, lastActivityAt: NOW - 60_001 } },
  { name: "zero timestamp remains a recorded stale activity", slots: [{ generation: "old", checkpointAt: 0 }], status: "stale", collection: { staleSlotCount: 1, lastActivityAt: 0 } },
  { name: "future checkpoint cannot prove collection now", slots: [{ generation: "future", checkpointAt: NOW + 1 }], status: "degraded", collection: { missingCheckpointSlotCount: 1 } },
  { name: "registered without a checkpoint", slots: [{ generation: "missing" }], status: "degraded", collection: { missingCheckpointSlotCount: 1 } },
  { name: "stale lifecycle without a checkpoint", slots: [{ generation: "missing", lifecycle: "stale" }], status: "degraded", collection: { missingCheckpointSlotCount: 1 } },
  { name: "closing cannot provide collection health or activity time", slots: [{ generation: "stopping", lifecycle: "closing", checkpointAt: NOW }], status: "degraded", collection: { closingSlotCount: 1 } },
  { name: "closed does not provide collection health", slots: [{ generation: "closed", lifecycle: "closed", checkpointAt: NOW }], status: "degraded", collection: { missingGenerationSlotCount: 1 } },
  { name: "abandoned does not provide collection health", slots: [{ generation: "abandoned", lifecycle: "abandoned", checkpointAt: NOW }], status: "degraded", collection: { missingGenerationSlotCount: 1 } },
  { name: "expected slot without generation", slots: [{}], status: "degraded", collection: { missingGenerationSlotCount: 1 } },
  { name: "zero expected slots is not vacuously healthy", slots: [], status: "degraded", collection: {} },
  { name: "non-expected slot is ignored", slots: [{ generation: "ignored", checkpointAt: NOW, expected: false }], status: "degraded", collection: {} },
  { name: "one fresh generation covers its slot despite old stale and newer closing generations", slots: [{ generation: "old", lifecycle: "stale", checkpointAt: 1 }, { generation: "fresh", checkpointAt: NOW - 5, createdAt: 2 }, { generation: "new-stopping", lifecycle: "closing", checkpointAt: NOW, createdAt: 3 }], status: "healthy", collection: { freshSlotCount: 1, lastActivityAt: NOW - 5 } },
  { name: "two fresh generations count as one fresh slot", slots: [{ generation: "first", checkpointAt: NOW - 1 }, { generation: "second", checkpointAt: NOW }], status: "healthy", collection: { freshSlotCount: 1, lastActivityAt: NOW } },
  { name: "every expected slot needs coverage", slots: [{ generation: "fresh", checkpointAt: NOW }, { producer: "api_local_fallback" }], status: "degraded", collection: { freshSlotCount: 1, missingGenerationSlotCount: 1, lastActivityAt: NOW } },
  { name: "all expected slots with fresh candidates are healthy", slots: [{ generation: "fresh", checkpointAt: NOW - 20_000 }, { producer: "api_local_fallback", generation: "fallback", checkpointAt: NOW - 2 }], status: "healthy", collection: { freshSlotCount: 2, lastActivityAt: NOW - 2 } },
  { name: "missing slot takes precedence over a stale slot", slots: [{ generation: "old", checkpointAt: 1 }, { producer: "api_local_fallback" }], status: "degraded", collection: { staleSlotCount: 1, missingGenerationSlotCount: 1, lastActivityAt: 1 } },
  { name: "expired and checkpoint-less candidates in one slot remain stale", slots: [{ generation: "expired", checkpointAt: 1 }, { generation: "new-without-checkpoint" }], status: "stale", collection: { staleSlotCount: 1, lastActivityAt: 1 } },
  { name: "disabled domain cannot be revived by a fresh checkpoint", slots: [{ generation: "fresh", checkpointAt: NOW }], status: "disabled", disabled: true, collection: { freshSlotCount: 1, lastActivityAt: NOW } },
];
for (const scenario of cases) {
  test(`current collection: ${scenario.name}`, async (t) => {
    const db = await database(t);
    db.prepare("UPDATE analytics_domain_state SET status=? WHERE domain='execution'").run(scenario.disabled ? "disabled" : "stale");
    for (const input of scenario.slots) slot(db, input);
    const row = health(db);
    assert.equal(row.status, scenario.status);
    assert.deepEqual(row.collection, { ...emptyCollection, ...scenario.collection });
    const collection = row.collection!;
    assert.equal(collection.freshSlotCount + collection.staleSlotCount + collection.missingGenerationSlotCount + collection.missingCheckpointSlotCount + collection.closingSlotCount, row.expectedSlotCount);
  });
}

test("current collection: healthy summary leaves stale state, historical gaps and metric completeness unchanged", async (t) => {
  const db = await database(t);
  db.prepare("UPDATE analytics_domain_state SET status='stale',collection_started_at=0,reconciled_through=?,last_succeeded_at=1 WHERE domain='model'").run(NOW);
  slot(db, { domain: "model", generation: "old", lifecycle: "stale", checkpointAt: 1 });
  slot(db, { domain: "model", generation: "fresh", checkpointAt: NOW - 5 });
  slot(db, { domain: "model", generation: "closing", lifecycle: "closing", checkpointAt: NOW });
  db.prepare(`INSERT INTO analytics_signal_coverage_gap
    (gap_id,domain,producer_namespace,producer_id,producer_generation,gap_from,gap_to,cause,dropped_since_sequence,recorded_at,closed_at)
    VALUES('old-gap','model','agent_worker','agent_runner','old',0,NULL,'abandoned_exit',NULL,1,NULL)`).run();
  db.prepare(`INSERT INTO analytics_model_call_fact
    (model_call_id,execution_id,run_id,attempt_no,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at)
    VALUES('model-call','execution','run',1,'provider','model',1,2,'completed','observed',NULL,4,6,10,'reported',NULL,NULL,0,0,NULL,2,2,2)`).run();
  const statesBefore = db.prepare("SELECT * FROM analytics_domain_state").all();
  const generationsBefore = db.prepare("SELECT * FROM analytics_producer_generation").all();
  const gapsBefore = db.prepare("SELECT * FROM analytics_signal_coverage_gap").all();
  const result = response(db);
  const row = result.data.exceptions.domainHealth.data!.find((item) => item.domain === "model")!;
  assert.equal(row.status, "healthy");
  assert.equal(row.collection?.lastActivityAt, NOW - 5);
  assert.equal(row.lastSucceededAt, 1);
  assert.equal(row.expectedSlotCount, 1);
  assert.equal(row.activeGenerationCount, 3);
  assert.equal(row.slots.length, 3);
  assert.equal(row.coverageGaps.openCount, 1);
  assert.equal(result.data.overview.modelRequests.dataIncomplete, true);
  assert.equal(result.data.overview.modelRequests.status, "partial");
  assert.equal(result.data.overview.modelRequests.value, 1);
  if (result.data.overview.modelRequests.status === "partial")
    assert.equal(result.data.overview.modelRequests.partialReason, "collector_degraded");
  assert.deepEqual(db.prepare("SELECT * FROM analytics_domain_state").all(), statesBefore);
  assert.deepEqual(db.prepare("SELECT * FROM analytics_producer_generation").all(), generationsBefore);
  assert.deepEqual(db.prepare("SELECT * FROM analytics_signal_coverage_gap").all(), gapsBefore);
});

test("current collection: agent_duration mirrors execution diagnostics without rewriting its historical fields", async (t) => {
  const db = await database(t);
  db.prepare("UPDATE analytics_domain_state SET status='stale',last_succeeded_at=7 WHERE domain='agent_duration'").run();
  slot(db, { generation: "fresh", checkpointAt: NOW });
  const rows = response(db).data.exceptions.domainHealth.data!;
  const execution = rows.find((row) => row.domain === "execution")!;
  const duration = rows.find((row) => row.domain === "agent_duration")!;
  assert.equal(duration.status, "healthy");
  assert.deepEqual(duration.collection, execution.collection);
  assert.equal(duration.expectedSlotCount, 0);
  assert.equal(duration.activeGenerationCount, 0);
  assert.deepEqual(duration.slots, []);
  assert.equal(duration.lastSucceededAt, 7);
  db.prepare("UPDATE analytics_domain_state SET status='disabled' WHERE domain='agent_duration'").run();
  assert.equal(health(db, "agent_duration").status, "disabled");
  db.prepare("UPDATE analytics_domain_state SET status='stale' WHERE domain='agent_duration'").run();
  db.prepare("UPDATE analytics_domain_state SET status='disabled' WHERE domain='execution'").run();
  assert.equal(health(db, "agent_duration").status, "disabled");
});

test("current collection: business collector domain statuses remain authoritative", async (t) => {
  const db = await database(t);
  const statuses = { run: "stale", session: "degraded", message: "disabled", tool: "unavailable" } as const;
  for (const [domain, status] of Object.entries(statuses)) {
    db.prepare("UPDATE analytics_domain_state SET status=?,last_succeeded_at=? WHERE domain=?").run(status, NOW, domain);
  }
  const rows = response(db).data.exceptions.domainHealth.data!;
  for (const [domain, status] of Object.entries(statuses)) {
    const row = rows.find((item) => item.domain === domain)!;
    assert.equal(row.status, status);
    assert.equal(row.lastSucceededAt, NOW);
    assert.equal(row.collection, undefined);
  }
});

test("current collection: model and worker use the same per-slot activity projection", async (t) => {
  const db = await database(t);
  for (const domain of ["model", "worker"] as const) {
    db.prepare("UPDATE analytics_domain_state SET status='stale' WHERE domain=?").run(domain);
    slot(db, { domain, generation: "stale", lifecycle: "stale", checkpointAt: 1 });
    slot(db, { domain, generation: "fresh", checkpointAt: NOW });
    const row = health(db, domain);
    assert.equal(row.status, "healthy");
    assert.deepEqual(row.collection, { ...emptyCollection, freshSlotCount: 1, lastActivityAt: NOW });
  }
});
