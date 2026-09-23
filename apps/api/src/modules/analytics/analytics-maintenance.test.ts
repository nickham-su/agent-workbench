import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { applyAnalyticsRetention } from "./analytics-maintenance.js";
import { abandonGeneration, acceptAnalyticsSignal, analyticsFingerprint } from "./signal-store.js";

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-analytics-retention-"));
  const db = await openAnalyticsDb(dataDir, 1);
  return { dataDir, db };
}

function event() {
  const unsigned = { kind: "event" as const, domain: "execution" as const, producerNamespace: "agent_worker" as const, producerId: "agent_runner", producerGeneration: "receipt-generation", sequence: 1, eventId: "receipt-event", payloadVersion: 1 as const, eventType: "execution_finished" as const, subjectIdentity: "execution:receipt", observedAt: 100, payload: { executionId: "execution:receipt", runId: "run:receipt", runtimeKind: "agent_worker", runKind: "user", parentRunId: null, queuedAt: null, startedAt: 100, endedAt: 101, endTimeQuality: "observed" as const, endReason: "other" as const } };
  return { ...unsigned, fingerprint: analyticsFingerprint(unsigned) };
}

function checkpoint() {
  return { kind: "checkpoint" as const, domain: "execution" as const, producerNamespace: "agent_worker" as const, producerId: "agent_runner", producerGeneration: "receipt-generation", sentAt: 1_000, controlSequence: 2, finalSequence: null, committedSequence: 1, maxObservedAt: 1_000, earliestOpenStartedAt: null, openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0 };
}

test("M6: active receipt prefix survives retention, remains continuous, then terminal cleanup removes it", async (t) => {
  const { dataDir, db } = await fixture();
  t.after(async () => { closeAnalyticsDb(db); await fs.rm(dataDir, { recursive: true, force: true }); });
  acceptAnalyticsSignal(db, { kind: "expected_slots_config", sentAt: 1, effectiveAt: 1, sourceConfigVersion: 1, enabledFactDomains: ["execution"], requestId: "receipt-slots", slots: [{ domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner" }] }, 1);
  acceptAnalyticsSignal(db, event(), 100);
  acceptAnalyticsSignal(db, checkpoint(), 1_000);
  applyAnalyticsRetention(db, 1_000, 100);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_event_receipt").get() as { count: number }).count, 1);
  assert.deepEqual(db.prepare("SELECT sequence FROM analytics_event_receipt WHERE producer_generation='receipt-generation'").all(), [{ sequence: 1 }],
    "active receipt prefix remains contiguous after retention");

  abandonGeneration(db, checkpoint(), 1_001);
  applyAnalyticsRetention(db, 1_002, 100);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_event_receipt").get() as { count: number }).count, 0);
});

test("retention treats a valid inferred execution end as terminal but retains unknown timing", async (t) => {
  const { dataDir, db } = await fixture();
  t.after(async () => { closeAnalyticsDb(db); await fs.rm(dataDir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,producer_namespace,producer_id,producer_generation,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at)
    VALUES ('inferred-old','run','agent_worker','agent_worker','worker','g','user',NULL,NULL,1,2,2,'ended','inferred','worker_exit',2,2,2),
      ('unknown-old','run','agent_worker','agent_worker','worker','g2','user',NULL,NULL,1,NULL,NULL,'ended','unknown','worker_exit',2,2,2)`);
  applyAnalyticsRetention(db, 1_000, 100);
  assert.deepEqual(db.prepare("SELECT execution_id FROM analytics_execution_fact ORDER BY execution_id").all(), [{ execution_id: "unknown-old" }]);
});
