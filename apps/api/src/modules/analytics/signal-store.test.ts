import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  isCanonicalAnalyticsSignal,
  type AnalyticsControlSignal,
  type AnalyticsSignalEvent,
} from "@agent-workbench/shared";
import type { AnalyticsDb } from "./analytics-db.js";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import {
  acceptAnalyticsSignal,
  abandonGeneration,
  analyticsFingerprint,
  diagnoseOutboxCorrupt,
  markStaleGenerations,
  readCurrentFactDomainConfig,
} from "./signal-store.js";

async function dataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "awb-signal-"));
}
function event(
  overrides: Partial<AnalyticsSignalEvent> = {},
): AnalyticsSignalEvent {
  const base = {
    kind: "event" as const,
    domain: "execution" as const,
    producerNamespace: "agent_worker" as const,
    producerId: "agent_runner",
    producerGeneration: "g1",
    sequence: 1,
    eventId: "event-1",
    payloadVersion: 1 as const,
    eventType: "execution_started" as const,
    subjectIdentity: "execution:run-1",
    observedAt: 100,
    payload: {
      executionId: "execution:run-1",
      runId: "run-1",
      runtimeKind: "agent_worker",
      runKind: "user",
      parentRunId: null,
      queuedAt: null,
      startedAt: 100,
      endedAt: null,
      endTimeQuality: "unknown" as const,
      endReason: null,
    },
  };
  const unsigned = { ...base, ...overrides };
  return {
    ...unsigned,
    fingerprint: overrides.fingerprint ?? analyticsFingerprint(unsigned as any),
  } as AnalyticsSignalEvent;
}
function checkpoint(
  overrides: Partial<AnalyticsControlSignal> = {},
): AnalyticsControlSignal {
  const value = {
    kind: "checkpoint",
    domain: "execution",
    producerNamespace: "agent_worker",
    producerId: "agent_runner",
    producerGeneration: "g1",
    sentAt: 200,
    controlSequence: 1,
    finalSequence: null,
    committedSequence: 1,
    maxObservedAt: 200,
    earliestOpenStartedAt: null,
    openExecutionCount: 0,
    openModelCount: 0,
    knownDrop: false,
    droppedSinceSequence: null,
    outboxPending: 0,
    oldestPendingAt: null,
    lossEpoch: 0,
    ...overrides,
  };
  return {
    ...value,
    controlSequence: (overrides as any).controlSequence ?? value.sentAt,
  } as unknown as AnalyticsControlSignal;
}

function enableWorkerFactDomains(db: AnalyticsDb) {
  assert.equal(acceptAnalyticsSignal(db, {
    kind: "expected_slots_config", sentAt: 0, requestId: "test-enable-worker", sourceConfigVersion: 1, effectiveAt: 0,
    enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],
    slots: [
      { domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager" },
      { domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner" },
      { domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner" },
    ],
  }, 0).accepted, true);
}

test("receipt replay is idempotent and conflict leaves facts unchanged", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  const first = event();
  assert.equal(acceptAnalyticsSignal(db, first, 101).accepted, true);
  assert.equal(acceptAnalyticsSignal(db, first, 102).accepted, true);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM analytics_execution_fact")
        .get() as { count: number }
    ).count,
    1,
  );
  const conflict = { ...first, fingerprint: "b".repeat(64) };
  assert.equal(acceptAnalyticsSignal(db, conflict, 103).accepted, false);
  assert.equal(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "degraded",
  );
});

test("source configuration rejects stale, conflicting, and retrospectively effective controls", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 1);
  t.after(() => closeAnalyticsDb(db));
  const slots = [
    { domain: "execution" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
    { domain: "model" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
  ];
  const first = {
    kind: "expected_slots_config" as const, sentAt: 200, effectiveAt: 200,
    requestId: "source-first", sourceConfigVersion: 10,
    enabledFactDomains: ["execution" as const, "model" as const], slots,
  };
  assert.equal(acceptAnalyticsSignal(db, first, 200).accepted, true);
  assert.equal(acceptAnalyticsSignal(db, { ...first, requestId: "source-idempotent" }, 201).accepted, true);
  assert.equal(acceptAnalyticsSignal(db, { ...first, requestId: "source-newer-equivalent", sourceConfigVersion: 11 }, 202).accepted, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_domain_config_version WHERE collection_config_version GLOB '[0-9][0-9]*'").get() as { count: number }).count, 2);
  assert.equal(acceptAnalyticsSignal(db, { ...first, requestId: "source-conflict", enabledFactDomains: ["execution" as const] }, 202).accepted, false);
  assert.equal(acceptAnalyticsSignal(db, { ...first, requestId: "source-old", sourceConfigVersion: 9 }, 203).accepted, false);
  assert.equal(acceptAnalyticsSignal(db, { ...first, requestId: "source-clock-back", sourceConfigVersion: 12, effectiveAt: 199 }, 204).accepted, false);
  assert.equal(acceptAnalyticsSignal(db, { ...first, requestId: "source-same-ms", sourceConfigVersion: 12, enabledFactDomains: ["execution" as const] }, 205).accepted, true);
  assert.deepEqual(
    db.prepare("SELECT source_config_version, effective_at FROM analytics_config_source_control WHERE singleton=1").get(),
    { source_config_version: 12, effective_at: 200 },
  );
});

test("source control survives child restart and retains conflicting-version rejection", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signal = {
    kind: "expected_slots_config" as const, sentAt: 10, effectiveAt: 10,
    requestId: "restart-source", sourceConfigVersion: 1,
    enabledFactDomains: ["execution" as const],
    slots: [
      { domain: "execution" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
      { domain: "model" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
    ],
  };
  const first = await openAnalyticsDb(root, 1);
  assert.equal(acceptAnalyticsSignal(first, signal, 10).accepted, true);
  closeAnalyticsDb(first);
  const restarted = await openAnalyticsDb(root, 11);
  t.after(() => closeAnalyticsDb(restarted));
  assert.equal(acceptAnalyticsSignal(restarted, { ...signal, requestId: "restart-idempotent" }, 11).accepted, true);
  assert.equal(acceptAnalyticsSignal(restarted, {
    ...signal, requestId: "restart-conflict", enabledFactDomains: [],
  }, 12).accepted, false);
  assert.deepEqual(
    restarted.prepare("SELECT source_config_version, effective_at FROM analytics_config_source_control").get(),
    { source_config_version: 1, effective_at: 10 },
  );
});

test("same-effective-time source revision orders after the numeric zero baseline", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 1);
  t.after(() => closeAnalyticsDb(db));
  assert.equal(acceptAnalyticsSignal(db, {
    kind: "expected_slots_config", sentAt: 0, effectiveAt: 0,
    requestId: "zero-time-source", sourceConfigVersion: 1,
    enabledFactDomains: ["execution", "model"],
    slots: [
      { domain: "execution", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
      { domain: "model", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" },
    ],
  }, 0).accepted, true);
  assert.equal(readCurrentFactDomainConfig(db).revision, "0000000000000001");
  assert.deepEqual(
    db.prepare("SELECT collection_config_version FROM analytics_domain_config_version ORDER BY effective_at, CAST(collection_config_version AS INTEGER)").all(),
    [{ collection_config_version: "0000000000000000" }, { collection_config_version: "0000000000000001" }],
  );
});

test("empty baseline accepts Signals as receipts without authorizing Facts", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 1);
  t.after(() => closeAnalyticsDb(db));
  assert.equal(acceptAnalyticsSignal(db, event({ eventId: "empty-baseline-receipt" }), 10).accepted, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_event_receipt WHERE event_id='empty-baseline-receipt'").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_execution_fact").get() as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_config_source_control").get() as { count: number }).count, 0);
});

test("abandoned generation creates an open gap and replacement checkpoint only narrows it", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  acceptAnalyticsSignal(db, checkpoint({ kind: "register", sentAt: 100 }), 100);
  // Establish an authenticated lower bound solely for this signal-domain test.
  db.prepare(
    "UPDATE analytics_domain_state SET reconciled_through=120, collection_started_at=100 WHERE domain='execution'",
  ).run();
  abandonGeneration(db, checkpoint({ sentAt: 150 }) as any, 150);
  assert.deepEqual(
    db
      .prepare(
        "SELECT gap_from, gap_to, cause FROM analytics_signal_coverage_gap",
      )
      .get(),
    { gap_from: 120, gap_to: null, cause: "abandoned_exit" },
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({
      producerGeneration: "g2",
      sentAt: 210,
      committedSequence: 0,
      maxObservedAt: 200,
    }),
    210,
  );
  assert.deepEqual(
    db
      .prepare("SELECT gap_from, gap_to FROM analytics_signal_coverage_gap")
      .get(),
    { gap_from: 120, gap_to: 200 },
  );
});

test("open execution checkpoint cannot close an existing coverage gap", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  db.prepare(
    "UPDATE analytics_domain_state SET reconciled_through=100, collection_started_at=50 WHERE domain='execution'",
  ).run();
  abandonGeneration(db, checkpoint({ sentAt: 120 }) as any, 120);
  acceptAnalyticsSignal(
    db,
    checkpoint({
      producerGeneration: "g2",
      sentAt: 210,
      maxObservedAt: 200,
      earliestOpenStartedAt: 150,
      openExecutionCount: 1,
    }),
    210,
  );
  assert.equal(
    (
      db.prepare("SELECT gap_to FROM analytics_signal_coverage_gap").get() as {
        gap_to: number | null;
      }
    ).gap_to,
    null,
  );
});

test("receipt holes and database-open facts keep signal coverage degraded", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  acceptAnalyticsSignal(db, checkpoint({ kind: "register", sentAt: 100 }), 100);
  acceptAnalyticsSignal(
    db,
    checkpoint({ sentAt: 110, committedSequence: 2, maxObservedAt: 109 }),
    110,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "degraded",
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      event({
        sequence: 1,
        eventId: "hole-1",
        observedAt: 105,
        subjectIdentity: "execution:hole-1",
      }),
      111,
    ).accepted,
    true,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT reconciled_through FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { reconciled_through: number | null }
    ).reconciled_through,
    null,
  );
  acceptAnalyticsSignal(
    db,
    event({
      sequence: 2,
      eventId: "hole-2",
      observedAt: 106,
      subjectIdentity: "execution:hole-2",
    }),
    112,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "degraded",
  );
});

test("replacement only narrows same-slot gaps and execution mirrors agent duration", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  acceptAnalyticsSignal(
    db,
    checkpoint({ kind: "register", sentAt: 100, committedSequence: 0 }),
    100,
  );
  db.prepare(
    "UPDATE analytics_domain_state SET reconciled_through=100, collection_started_at=50 WHERE domain='execution'",
  ).run();
  abandonGeneration(
    db,
    checkpoint({ sentAt: 110, committedSequence: 0 }) as any,
    110,
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({
      producerNamespace: "api_local_fallback",
      producerId: "api_local_fallback",
      producerGeneration: "f1",
      sentAt: 120,
      committedSequence: 0,
      maxObservedAt: 119,
    }),
    120,
  );
  assert.equal(
    (
      db.prepare("SELECT gap_to FROM analytics_signal_coverage_gap").get() as {
        gap_to: number | null;
      }
    ).gap_to,
    null,
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({
      producerGeneration: "g2",
      sentAt: 130,
      committedSequence: 0,
      maxObservedAt: 125,
    }),
    130,
  );
  assert.equal(
    (
      db.prepare("SELECT gap_to FROM analytics_signal_coverage_gap").get() as {
        gap_to: number | null;
      }
    ).gap_to,
    null,
  );
  const execution = db
    .prepare(
      "SELECT status, reconciled_through, last_error_code FROM analytics_domain_state WHERE domain='execution'",
    )
    .get();
  const duration = db
    .prepare(
      "SELECT status, reconciled_through, last_error_code FROM analytics_domain_state WHERE domain='agent_duration'",
    )
    .get();
  assert.deepEqual(duration, execution);
});

test("stale checkpoint recovers its own generation but terminal lifecycle cannot revive", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  acceptAnalyticsSignal(
    db,
    {
      kind: "expected_slots_config",
      sentAt: 90,
      effectiveAt: 90,
      requestId: "slots-90",
      sourceConfigVersion: 90,
      enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],

      slots: [
        {
          domain: "worker",
          producerNamespace: "worker_observer",
          producerId: "process_manager",
        },
        {
          domain: "execution",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
        {
          domain: "model",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
      ],
    },
    90,
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({ kind: "register", sentAt: 100, committedSequence: 0 }),
    100,
  );
  assert.equal(markStaleGenerations(db, 200, 10), 1);
  assert.equal(
    (
      db
        .prepare("SELECT lifecycle FROM analytics_producer_generation")
        .get() as { lifecycle: string }
    ).lifecycle,
    "stale",
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({ sentAt: 205, committedSequence: 0, maxObservedAt: 204 }),
    205,
  );
  assert.equal(
    (
      db
        .prepare("SELECT lifecycle FROM analytics_producer_generation")
        .get() as { lifecycle: string }
    ).lifecycle,
    "registered",
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "closed",
        sentAt: 206,
        committedSequence: 0,
        finalSequence: 0,
      }),
      206,
    ).accepted,
    true,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({ sentAt: 207, committedSequence: 0, maxObservedAt: 206 }),
      207,
    ).accepted,
    false,
  );
  assert.equal(
    (
      db
        .prepare("SELECT lifecycle FROM analytics_producer_generation")
        .get() as { lifecycle: string }
    ).lifecycle,
    "closed",
  );
});

test("runtime slot configuration replaces disabled modes and a late checkpoint cannot clear newer backlog", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  acceptAnalyticsSignal(
    db,
    {
      kind: "expected_slots_config",
      sentAt: 10,
      effectiveAt: 10,
      requestId: "slots-10",
      sourceConfigVersion: 1,
      enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],

      slots: [
        {
          domain: "worker",
          producerNamespace: "worker_observer",
          producerId: "process_manager",
        },
        {
          domain: "execution",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
        {
          domain: "model",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
      ],
    },
    10,
  );
  acceptAnalyticsSignal(
    db,
    {
      kind: "expected_slots_config",
      sentAt: 20,
      effectiveAt: 20,
      requestId: "slots-20",
      sourceConfigVersion: 2,
      enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],

      slots: [
        {
          domain: "execution",
          producerNamespace: "api_local_fallback",
          producerId: "api_local_fallback",
        },
        {
          domain: "model",
          producerNamespace: "api_local_fallback",
          producerId: "api_local_fallback",
        },
      ],
    },
    20,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT expected_enabled FROM analytics_producer_slot WHERE domain='execution' AND producer_namespace='agent_worker'",
        )
        .get() as { expected_enabled: number }
    ).expected_enabled,
    0,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT expected_enabled FROM analytics_producer_slot WHERE domain='execution' AND producer_namespace='api_local_fallback'",
        )
        .get() as { expected_enabled: number }
    ).expected_enabled,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='worker'",
        )
        .get() as { status: string }
    ).status,
    "disabled",
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT last_error_code FROM analytics_domain_state WHERE domain='worker'",
        )
        .get() as { last_error_code: string | null }
    ).last_error_code,
    null,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT enabled_fact_domains_json FROM analytics_domain_config_version WHERE effective_at<=20 ORDER BY effective_at DESC, collection_config_version DESC LIMIT 1",
        )
        .get() as { enabled_fact_domains_json: string }
    ).enabled_fact_domains_json.includes('"worker"'),
    false,
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({ sentAt: 200, outboxPending: 1, oldestPendingAt: 190 } as any),
    200,
  );
  acceptAnalyticsSignal(db, checkpoint({ sentAt: 100 }), 201);
  const row = db
    .prepare(
      "SELECT outbox_pending, oldest_pending_at FROM analytics_producer_checkpoint WHERE domain='execution' AND producer_generation='g1'",
    )
    .get() as { outbox_pending: number; oldest_pending_at: number };
  assert.equal(row.outbox_pending, 1);
  assert.equal(row.oldest_pending_at, 190);
});

test("an older stale or closing generation blocks a newer healthy generation", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  acceptAnalyticsSignal(
    db,
    {
      kind: "expected_slots_config",
      sentAt: 1,
      effectiveAt: 1,
      sourceConfigVersion: 1,
      requestId: "worker-slots",
      enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],

      slots: [
        {
          domain: "worker",
          producerNamespace: "worker_observer",
          producerId: "process_manager",
        },
        {
          domain: "execution",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
        {
          domain: "model",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
      ],
    },
    1,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "register",
        producerGeneration: "old",
        committedSequence: 0,
        maxObservedAt: 10,
        sentAt: 10,
      }),
      10,
    ).accepted,
    true,
  );
  assert.equal(markStaleGenerations(db, 30_000, 10), 1);
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "checkpoint",
        producerGeneration: "new",
        committedSequence: 0,
        maxObservedAt: 30_001,
        sentAt: 30_001,
      }),
      30_001,
    ).accepted,
    true,
  );
  assert.notEqual(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "healthy",
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "closing",
        producerGeneration: "old",
        committedSequence: 0,
        finalSequence: 0,
        maxObservedAt: 30_002,
        sentAt: 30_002,
        controlSequence: 30_002,
      }),
      30_002,
    ).accepted,
    true,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "degraded",
  );
});

test("a worker-unexpected-exit infers only Runs with an open agent-worker execution", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  db.prepare(
    `INSERT INTO analytics_run_fact (run_id, run_kind, parent_run_id, display_status, status_quality, inferred_evidence_type, created_at, terminal_at, source_updated_at, collected_at)
    VALUES ('running-run', 'user', NULL, 'running', 'observed', NULL, 1, NULL, 1, 1), ('unlinked-run', 'user', NULL, 'running', 'observed', NULL, 1, NULL, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO analytics_execution_fact (execution_id, run_id, runtime_kind, producer_namespace, producer_id, producer_generation, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
    VALUES ('open-execution', 'running-run', 'agent_worker', 'agent_worker', 'agent_runner', 'g1', 'user', NULL, NULL, 1, NULL, NULL, 'running', 'unknown', NULL, 1, 1, 1)`,
  ).run();
  const workerExit = event({
    domain: "worker",
    producerNamespace: "worker_observer",
    producerId: "process_manager",
    producerGeneration: "worker-g",
    eventId: "worker-exit",
    eventType: "worker_unexpected_exit",
    subjectIdentity: "worker:unexpected:1",
    payload: {
      occurredAt: 100,
      event: "unexpected_exit",
      restartAttemptId: null,
      runnerMode: "agent_worker",
      targetIdentityQuality: "exact",
      targets: [
        {
          domain: "execution",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
          producerGeneration: "g1",
        },
        {
          domain: "model",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
          producerGeneration: "g1",
        },
        {
          domain: "worker",
          producerNamespace: "worker_observer",
          producerId: "process_manager",
          producerGeneration: "worker-g",
        },
      ],
    },
  } as any);
  assert.equal(acceptAnalyticsSignal(db, workerExit, 100).accepted, true);
  assert.deepEqual(
    db
      .prepare(
        "SELECT run_id, display_status, status_quality, inferred_evidence_type FROM analytics_run_fact ORDER BY run_id",
      )
      .all(),
    [
      {
        run_id: "running-run",
        display_status: "interrupted",
        status_quality: "inferred",
        inferred_evidence_type: "worker_unexpected_exit",
      },
      {
        run_id: "unlinked-run",
        display_status: "running",
        status_quality: "observed",
        inferred_evidence_type: null,
      },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT status, ended_at, effective_ended_at, end_time_quality, end_reason FROM analytics_execution_fact WHERE execution_id='open-execution'").get(),
    { status: "ended", ended_at: 100, effective_ended_at: 100, end_time_quality: "inferred", end_reason: "worker_exit" },
  );
  const observedFinish = event({
    eventId: "open-execution-observed-finish",
    sequence: 1,
    eventType: "execution_finished",
    subjectIdentity: "execution:open-execution",
    payload: {
      executionId: "open-execution", runId: "running-run", runtimeKind: "agent_worker", runKind: "user", parentRunId: null,
      queuedAt: null, startedAt: 1, endedAt: 120, endTimeQuality: "observed", endReason: "completed",
    } as any,
  });
  assert.equal(acceptAnalyticsSignal(db, observedFinish, 120).accepted, true);
  assert.deepEqual(
    db.prepare("SELECT status, ended_at, effective_ended_at, end_time_quality, end_reason FROM analytics_execution_fact WHERE execution_id='open-execution'").get(),
    { status: "ended", ended_at: 120, effective_ended_at: 120, end_time_quality: "observed", end_reason: "completed" },
  );
  const delayedStart = event({
    eventId: "open-execution-delayed-start", sequence: 2, subjectIdentity: "execution:open-execution",
    payload: { executionId: "open-execution", runId: "running-run", runtimeKind: "agent_worker", runKind: "user", parentRunId: null, queuedAt: null, startedAt: 1, endedAt: null, endTimeQuality: "unknown", endReason: null } as any,
  });
  assert.equal(acceptAnalyticsSignal(db, delayedStart, 121).accepted, true);
  assert.deepEqual(
    db.prepare("SELECT status, ended_at, effective_ended_at, end_time_quality, end_reason FROM analytics_execution_fact WHERE execution_id='open-execution'").get(),
    { status: "ended", ended_at: 120, effective_ended_at: 120, end_time_quality: "observed", end_reason: "completed" },
  );
});

test("unexpected exit with an invalid or unknown target never fabricates an execution interval", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  const startedPayload = (executionId: string) => ({
    executionId, runId: "run", runtimeKind: "agent_worker", runKind: "user", parentRunId: null,
    queuedAt: null, startedAt: 100, endedAt: null, endTimeQuality: "unknown", endReason: null,
  });
  assert.equal(acceptAnalyticsSignal(db, event({ eventId: "invalid-time-start", subjectIdentity: "execution:invalid-time", payload: startedPayload("invalid-time") as any }), 100).accepted, true);
  assert.equal(acceptAnalyticsSignal(db, event({ producerGeneration: "g2", eventId: "unknown-target-start", subjectIdentity: "execution:unknown-target", payload: startedPayload("unknown-target") as any }), 100).accepted, true);
  const exit = event({ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: "observer-g", eventId: "invalid-worker-exit", eventType: "worker_unexpected_exit", subjectIdentity: "worker:invalid", payload: {
    occurredAt: 100, event: "unexpected_exit", restartAttemptId: null, runnerMode: "agent_worker", targetIdentityQuality: "exact",
    targets: [{ domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: "g1" }],
  } } as any);
  assert.equal(acceptAnalyticsSignal(db, exit, 100).accepted, true);
  assert.deepEqual(db.prepare("SELECT status,ended_at,effective_ended_at,end_time_quality,end_reason FROM analytics_execution_fact WHERE execution_id='invalid-time'").get(),
    { status: "ended", ended_at: null, effective_ended_at: null, end_time_quality: "unknown", end_reason: "worker_exit" });
  assert.deepEqual(db.prepare("SELECT status FROM analytics_execution_fact WHERE execution_id='unknown-target'").get(), { status: "running" });
  closeAnalyticsDb(db);
  const reopened = await openAnalyticsDb(root, 101);
  t.after(() => closeAnalyticsDb(reopened));
  assert.deepEqual(reopened.prepare("SELECT status,ended_at,effective_ended_at,end_time_quality,end_reason FROM analytics_execution_fact WHERE execution_id='invalid-time'").get(),
    { status: "ended", ended_at: null, effective_ended_at: null, end_time_quality: "unknown", end_reason: "worker_exit" });
});

test("public producers cannot abandon and a clean close cannot erase persisted loss", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  assert.equal(
    isCanonicalAnalyticsSignal({ ...(checkpoint() as any), kind: "abandoned" }),
    false,
  );
  acceptAnalyticsSignal(
    db,
    checkpoint({
      kind: "checkpoint",
      knownDrop: true,
      droppedSinceSequence: 1,
      lossEpoch: 1,
    } as any),
    100,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "closed",
        finalSequence: 0,
        committedSequence: 0,
        knownDrop: false,
        droppedSinceSequence: null,
        sentAt: 101,
      } as any),
      101,
    ).accepted,
    false,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT known_drop FROM analytics_producer_generation WHERE domain='execution' AND producer_generation='g1'",
        )
        .get() as { known_drop: number }
    ).known_drop,
    1,
  );
});

test("formal worker restart event is receipted and preserves the payload attempt identity", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  const base = {
    kind: "event" as const,
    domain: "worker" as const,
    producerNamespace: "worker_observer" as const,
    producerId: "process_manager",
    producerGeneration: "observer-1",
    sequence: 1,
    eventId: "restart-event",
    payloadVersion: 1 as const,
    eventType: "worker_restart_attempted" as const,
    subjectIdentity: "worker:restart:attempt-7",
    observedAt: 100,
    payload: {
      occurredAt: 100,
      event: "restart_attempted",
      restartAttemptId: "attempt-7",
      runnerMode: "agent_worker" as const,
      targetIdentityQuality: "unknown" as const,
      targets: [],
    },
  };
  const signal = {
    ...base,
    fingerprint: analyticsFingerprint(base as any),
  } as AnalyticsSignalEvent;
  assert.equal(acceptAnalyticsSignal(db, signal, 101).accepted, true);
  assert.deepEqual(
    db
      .prepare(
        "SELECT event_type, restart_attempt_id FROM analytics_worker_event_fact WHERE event_id='restart-event'",
      )
      .get(),
    { event_type: "restart_attempted", restart_attempt_id: "attempt-7" },
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT event_type FROM analytics_event_receipt WHERE event_id='restart-event'",
        )
        .get() as { event_type: string }
    ).event_type,
    "worker_restart_attempted",
  );
});

test("terminal model generation accepts a valid delayed outbox fact without reviving completeness", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  const control = checkpoint({
    domain: "model",
    producerGeneration: "terminal-model",
    committedSequence: 0,
    sentAt: 10,
  } as any);
  assert.equal(abandonGeneration(db, control as any, 10), true);
  const before = db
    .prepare(
      "SELECT lifecycle, committed_sequence FROM analytics_producer_generation WHERE domain='model' AND producer_generation='terminal-model'",
    )
    .get();
  const gapsBefore = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM analytics_signal_coverage_gap WHERE domain='model' AND producer_generation='terminal-model'",
      )
      .get() as { count: number }
  ).count;
  const base = {
    kind: "event" as const,
    domain: "model" as const,
    producerNamespace: "agent_worker" as const,
    producerId: "agent_runner",
    producerGeneration: "terminal-model",
    sequence: 1,
    eventId: "delayed-model-event",
    payloadVersion: 1 as const,
    eventType: "model_finished" as const,
    subjectIdentity: "model:delayed",
    observedAt: 20,
    payload: {
      modelCallId: "delayed",
      executionId: "run-1",
      runId: "run-1",
      attemptNo: 1,
      providerId: "provider",
      modelId: "model",
      startedAt: 10,
      endedAt: 20,
      status: "completed" as const,
      completionQuality: "observed" as const,
      timeoutKind: null,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      totalSource: "reported" as const,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheComparable: false,
      cacheWriteVerified: false,
      failureKind: null,
    },
  };
  const delayed = {
    ...base,
    fingerprint: analyticsFingerprint(base as any),
  } as AnalyticsSignalEvent;
  assert.equal(acceptAnalyticsSignal(db, delayed, 30).accepted, true);
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_model_call_fact WHERE model_call_id='delayed'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT lifecycle, committed_sequence FROM analytics_producer_generation WHERE domain='model' AND producer_generation='terminal-model'",
      )
      .get(),
    before,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_signal_coverage_gap WHERE domain='model' AND producer_generation='terminal-model'",
        )
        .get() as { count: number }
    ).count,
    gapsBefore,
  );
});

test("trusted outbox corruption preserves terminal lifecycle and creates a diagnostic gap", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  const model = checkpoint({
    domain: "model",
    producerGeneration: "corrupt-generation",
    sentAt: 100,
    controlSequence: 2,
    committedSequence: 0,
  });
  acceptAnalyticsSignal(db, model, 100);
  db.prepare(
    "UPDATE analytics_domain_state SET collection_started_at=50, reconciled_through=100 WHERE domain='model'",
  ).run();
  assert.equal(abandonGeneration(db, model as any, 110), true);
  assert.equal(
    diagnoseOutboxCorrupt(db, {
      producerNamespace: "agent_worker",
      producerId: "agent_runner",
      producerGeneration: "corrupt-generation",
      recordedAt: 120,
    }),
    true,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT lifecycle, known_drop FROM analytics_producer_generation WHERE producer_generation='corrupt-generation'",
      )
      .get(),
    { lifecycle: "abandoned", known_drop: 1 },
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT cause FROM analytics_signal_coverage_gap WHERE producer_generation='corrupt-generation'",
      )
      .get(),
    { cause: "outbox_corrupt" },
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT status, last_error_code FROM analytics_domain_state WHERE domain='model'",
      )
      .get(),
    { status: "degraded", last_error_code: "SIGNAL_OUTBOX_CORRUPT" },
  );
});

test("older or conflicting control sequence cannot regress lifecycle", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "checkpoint",
        controlSequence: 2,
        sentAt: 200,
        committedSequence: 0,
      }),
      200,
    ).accepted,
    true,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "closing",
        controlSequence: 1,
        sentAt: 201,
        committedSequence: 0,
        finalSequence: 0,
      }),
      201,
    ).accepted,
    false,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "closed",
        controlSequence: 1,
        sentAt: 202,
        committedSequence: 0,
        finalSequence: 0,
      }),
      202,
    ).accepted,
    false,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "checkpoint",
        controlSequence: 2,
        sentAt: 200,
        committedSequence: 0,
      }),
      203,
    ).accepted,
    true,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "checkpoint",
        controlSequence: 2,
        sentAt: 200,
        committedSequence: 1,
      }),
      204,
    ).accepted,
    false,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT lifecycle, control_sequence FROM analytics_producer_generation",
      )
      .get(),
    { lifecycle: "registered", control_sequence: 2 },
  );
});

test("obsolete or conflicting controls have no side effects before close validation", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  const current = checkpoint({
    controlSequence: 2,
    sentAt: 200,
    committedSequence: 0,
  });
  assert.equal(acceptAnalyticsSignal(db, current, 200).accepted, true);
  const generationBefore = db
    .prepare(
      "SELECT * FROM analytics_producer_generation WHERE domain='execution' AND producer_generation='g1'",
    )
    .get();
  const domainBefore = db
    .prepare(
      "SELECT status, last_error_code, reconciled_through, collection_started_at FROM analytics_domain_state WHERE domain='execution'",
    )
    .get();

  assert.equal(acceptAnalyticsSignal(db, current, 201).accepted, true);
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM analytics_producer_generation WHERE domain='execution' AND producer_generation='g1'",
      )
      .get(),
    generationBefore,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT status, last_error_code, reconciled_through, collection_started_at FROM analytics_domain_state WHERE domain='execution'",
      )
      .get(),
    domainBefore,
  );

  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({ controlSequence: 2, sentAt: 200, openExecutionCount: 1 }),
      202,
    ).accepted,
    false,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM analytics_producer_generation WHERE domain='execution' AND producer_generation='g1'",
      )
      .get(),
    generationBefore,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT status, last_error_code, reconciled_through, collection_started_at FROM analytics_domain_state WHERE domain='execution'",
      )
      .get(),
    domainBefore,
  );

  const obsoleteInvalidClose = checkpoint({
    kind: "closed",
    controlSequence: 1,
    sentAt: 203,
    finalSequence: 0,
    committedSequence: 0,
    knownDrop: true,
  });
  assert.equal(
    acceptAnalyticsSignal(db, obsoleteInvalidClose, 203).accepted,
    false,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM analytics_producer_generation WHERE domain='execution' AND producer_generation='g1'",
      )
      .get(),
    generationBefore,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT status, last_error_code, reconciled_through, collection_started_at FROM analytics_domain_state WHERE domain='execution'",
      )
      .get(),
    domainBefore,
  );
});

test("an old-generation unknown open Fact blocks replacement gap closure", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  acceptAnalyticsSignal(
    db,
    {
      kind: "expected_slots_config",
      sentAt: 1,
      effectiveAt: 1,
      sourceConfigVersion: 1,
      requestId: "generation-slots",
      enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],

      slots: [
        {
          domain: "worker",
          producerNamespace: "worker_observer",
          producerId: "process_manager",
        },
        {
          domain: "execution",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
        {
          domain: "model",
          producerNamespace: "agent_worker",
          producerId: "agent_runner",
        },
      ],
    },
    1,
  );
  const first = event({
    producerGeneration: "g-old",
    eventId: "old-open",
    subjectIdentity: "execution:old",
    payload: {
      executionId: "old",
      runId: "old-run",
      runtimeKind: "agent_worker",
      runKind: "user",
      parentRunId: null,
      queuedAt: null,
      startedAt: 10,
      endedAt: null,
      endTimeQuality: "unknown",
      endReason: null,
    },
  } as any);
  assert.equal(acceptAnalyticsSignal(db, first, 10).accepted, true);
  assert.deepEqual(
    db
      .prepare(
        "SELECT producer_namespace, producer_id, producer_generation FROM analytics_execution_fact WHERE execution_id='old'",
      )
      .get(),
    {
      producer_namespace: "agent_worker",
      producer_id: "agent_runner",
      producer_generation: "g-old",
    },
  );
  abandonGeneration(
    db,
    checkpoint({
      producerGeneration: "g-old",
      committedSequence: 1,
      maxObservedAt: 10,
      sentAt: 11,
    }) as any,
    11,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      checkpoint({
        producerGeneration: "g-new",
        committedSequence: 0,
        maxObservedAt: 20,
        sentAt: 20,
      }),
      20,
    ).accepted,
    true,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "degraded",
  );
  assert.equal(
    (
      db.prepare(
        "SELECT gap_to FROM analytics_signal_coverage_gap WHERE domain='execution' AND producer_generation='g-old'",
      ).get() as { gap_to: number | null }
    ).gap_to,
    null,
  );
});

test("an old running Model started before T blocks replacement certification and gap closure", async (t) => {
  const root = await dataDir(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50); t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  acceptAnalyticsSignal(db, checkpoint({ domain: "model", producerGeneration: "old-model", sentAt: 10, committedSequence: 0, maxObservedAt: 10 } as any), 10);
  abandonGeneration(db, checkpoint({ domain: "model", producerGeneration: "old-model", sentAt: 11, committedSequence: 0, maxObservedAt: 10 } as any) as any, 11);
  db.prepare(`INSERT INTO analytics_model_call_fact (model_call_id, execution_id, run_id, attempt_no, producer_namespace, producer_id, producer_generation, provider_id, model_id, started_at, ended_at, status, completion_quality, timeout_kind, input_tokens, output_tokens, total_tokens, total_source, cache_read_tokens, cache_write_tokens, cache_comparable, cache_write_verified, failure_kind, observed_at, updated_at, collected_at)
    VALUES ('open-model', 'e', 'r', 1, 'agent_worker', 'agent_runner', 'old-model', 'p', 'm', 10, NULL, 'running', 'unknown', NULL, NULL, NULL, NULL, 'unavailable', NULL, NULL, 0, 0, NULL, 10, 10, 10)`).run();
  acceptAnalyticsSignal(db, checkpoint({ domain: "model", producerGeneration: "new-model", sentAt: 30, committedSequence: 0, maxObservedAt: 20 } as any), 30);
  assert.deepEqual(db.prepare("SELECT status, last_error_code FROM analytics_domain_state WHERE domain='model'").get(), { status: "degraded", last_error_code: "SIGNAL_OPEN_FACT_INCONSISTENT" });
  assert.equal((db.prepare("SELECT gap_to FROM analytics_signal_coverage_gap WHERE domain='model' AND producer_generation='old-model'").get() as { gap_to: number | null }).gap_to, null);
});

test("a reliable inferred worker-exit Execution permits replacement certification and closes its gap at T", async (t) => {
  const root = await dataDir(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50); t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  acceptAnalyticsSignal(db, checkpoint({ producerGeneration: "old-execution", sentAt: 10, committedSequence: 0, maxObservedAt: 10 } as any), 10);
  abandonGeneration(db, checkpoint({ producerGeneration: "old-execution", sentAt: 11, committedSequence: 0, maxObservedAt: 10 } as any) as any, 11);
  db.prepare(`INSERT INTO analytics_execution_fact (execution_id, run_id, runtime_kind, producer_namespace, producer_id, producer_generation, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
    VALUES ('inferred-execution', 'r', 'agent_worker', 'agent_worker', 'agent_runner', 'old-execution', 'user', NULL, NULL, 10, 15, 15, 'ended', 'inferred', 'worker_exit', 15, 15, 15)`).run();
  acceptAnalyticsSignal(db, checkpoint({ producerGeneration: "new-execution", sentAt: 30, committedSequence: 0, maxObservedAt: 20 } as any), 30);
  assert.equal((db.prepare("SELECT status FROM analytics_domain_state WHERE domain='execution'").get() as { status: string }).status, "healthy");
  assert.equal((db.prepare("SELECT gap_to FROM analytics_signal_coverage_gap WHERE domain='execution' AND producer_generation='old-execution'").get() as { gap_to: number | null }).gap_to, 20);
});

test("an open Fact in a different producer slot does not block the replacement slot", async (t) => {
  const root = await dataDir(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50); t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  acceptAnalyticsSignal(db, checkpoint({ producerGeneration: "old-slot", sentAt: 10, committedSequence: 0, maxObservedAt: 10 } as any), 10);
  abandonGeneration(db, checkpoint({ producerGeneration: "old-slot", sentAt: 11, committedSequence: 0, maxObservedAt: 10 } as any) as any, 11);
  db.prepare(`INSERT INTO analytics_execution_fact (execution_id, run_id, runtime_kind, producer_namespace, producer_id, producer_generation, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
    VALUES ('other-slot', 'r', 'api_local_fallback', 'api_local_fallback', 'api_local_fallback', 'local-open', 'user', NULL, NULL, 10, NULL, NULL, 'running', 'unknown', NULL, 10, 10, 10)`).run();
  acceptAnalyticsSignal(db, checkpoint({ producerGeneration: "new-slot", sentAt: 30, committedSequence: 0, maxObservedAt: 20 } as any), 30);
  assert.equal((db.prepare("SELECT status FROM analytics_domain_state WHERE domain='execution'").get() as { status: string }).status, "healthy");
  assert.equal((db.prepare("SELECT gap_to FROM analytics_signal_coverage_gap WHERE domain='execution' AND producer_generation='old-slot'").get() as { gap_to: number | null }).gap_to, 20);
});

test("agent_duration inherits execution state, watermark, error and replacement gap exactly", async (t) => {
  const root = await dataDir(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50); t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  acceptAnalyticsSignal(db, checkpoint({ producerGeneration: "duration-old", sentAt: 10, committedSequence: 0, maxObservedAt: 10 } as any), 10);
  abandonGeneration(db, checkpoint({ producerGeneration: "duration-old", sentAt: 11, committedSequence: 0, maxObservedAt: 10 } as any) as any, 11);
  acceptAnalyticsSignal(db, checkpoint({ producerGeneration: "duration-new", sentAt: 30, committedSequence: 0, maxObservedAt: 20 } as any), 30);
  assert.deepEqual(
    db.prepare("SELECT status, reconciled_through, last_error_code FROM analytics_domain_state WHERE domain='agent_duration'").get(),
    db.prepare("SELECT status, reconciled_through, last_error_code FROM analytics_domain_state WHERE domain='execution'").get(),
  );
  // agent_duration is a derived execution projection, not a second signal
  // producer domain: it must not create an independently mutable gap row.
  assert.deepEqual(db.prepare("SELECT gap_from, gap_to, cause FROM analytics_signal_coverage_gap WHERE domain='agent_duration'").all(), []);
  assert.deepEqual(db.prepare("SELECT gap_from, gap_to, cause FROM analytics_signal_coverage_gap WHERE domain='execution'").all(), [
    { gap_from: 10, gap_to: 20, cause: "abandoned_exit" },
  ]);
});

test("late lifecycle evidence abandons only explicit exit targets and unknown identity never abandons replacements", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 1);
  t.after(() => closeAnalyticsDb(db));
  enableWorkerFactDomains(db);
  for (const generation of ["exited", "replacement"])
    acceptAnalyticsSignal(
      db,
      checkpoint({
        producerGeneration: generation,
        sentAt: generation === "exited" ? 10 : 20,
        maxObservedAt: 20,
      } as any),
      20,
    );
  const makeExit = (
    eventId: string,
    quality: "exact" | "unknown",
    targets: unknown[],
  ) => {
    const base = {
      kind: "event" as const,
      domain: "worker" as const,
      producerNamespace: "worker_observer" as const,
      producerId: "process_manager",
      producerGeneration: "observer-replay",
      sequence: eventId === "exact-exit" ? 1 : 2,
      eventId,
      payloadVersion: 1 as const,
      eventType: "worker_unexpected_exit" as const,
      subjectIdentity: `worker:${eventId}`,
      observedAt: 30,
      payload: {
        occurredAt: 10,
        event: "unexpected_exit",
        restartAttemptId: null,
        runnerMode: "agent_worker" as const,
        targetIdentityQuality: quality,
        targets,
      },
    };
    return {
      ...base,
      fingerprint: analyticsFingerprint(base as any),
    } as AnalyticsSignalEvent;
  };
  acceptAnalyticsSignal(
    db,
    makeExit("exact-exit", "exact", [
      {
        domain: "execution",
        producerNamespace: "agent_worker",
        producerId: "agent_runner",
        producerGeneration: "exited",
      },
    ]),
    30,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT producer_generation,lifecycle FROM analytics_producer_generation WHERE domain='execution' ORDER BY producer_generation",
      )
      .all(),
    [
      { producer_generation: "exited", lifecycle: "abandoned" },
      { producer_generation: "replacement", lifecycle: "registered" },
    ],
  );
  acceptAnalyticsSignal(db, makeExit("unknown-exit", "unknown", []), 31);
  assert.equal(
    (
      db
        .prepare(
          "SELECT lifecycle FROM analytics_producer_generation WHERE domain='execution' AND producer_generation='replacement'",
        )
        .get() as { lifecycle: string }
    ).lifecycle,
    "registered",
  );
  assert.ok(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_signal_coverage_gap WHERE domain='worker' AND cause='abandoned_exit'",
        )
        .get() as { count: number }
    ).count > 0,
  );
});

test("legacy NULL open execution and model Facts block certification until same-id terminal evidence backfills identity", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 1);
  t.after(() => closeAnalyticsDb(db));
  db.exec(`INSERT INTO analytics_execution_fact (execution_id,run_id,runtime_kind,producer_namespace,producer_id,producer_generation,run_kind,parent_run_id,queued_at,started_at,ended_at,effective_ended_at,status,end_time_quality,end_reason,observed_at,updated_at,collected_at) VALUES ('legacy-exec','run','agent_worker',NULL,NULL,NULL,'user',NULL,NULL,1,NULL,NULL,'running','unknown',NULL,1,1,1);
    INSERT INTO analytics_model_call_fact (model_call_id,execution_id,run_id,attempt_no,producer_namespace,producer_id,producer_generation,provider_id,model_id,started_at,ended_at,status,completion_quality,timeout_kind,input_tokens,output_tokens,total_tokens,total_source,cache_read_tokens,cache_write_tokens,cache_comparable,cache_write_verified,failure_kind,observed_at,updated_at,collected_at) VALUES ('legacy-model','legacy-exec','run',1,NULL,NULL,NULL,'p','m',1,NULL,'running','unknown',NULL,NULL,NULL,NULL,'unavailable',NULL,NULL,0,0,NULL,1,1,1);`);
  assert.equal(
    acceptAnalyticsSignal(
      db,
      {
        kind: "expected_slots_config",
        sentAt: 10,
        effectiveAt: 10,
        requestId: "slots",
        sourceConfigVersion: 10,
        enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker", "git"],

        slots: [
          {
            domain: "worker",
            producerNamespace: "worker_observer",
            producerId: "process_manager",
          },
          {
            domain: "execution",
            producerNamespace: "agent_worker",
            producerId: "agent_runner",
          },
          {
            domain: "model",
            producerNamespace: "agent_worker",
            producerId: "agent_runner",
          },
        ],
      },
      10,
    ).accepted,
    true,
  );
  for (const domain of ["execution", "model", "worker"] as const)
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "register",
        domain,
        producerNamespace:
          domain === "worker" ? "worker_observer" : "agent_worker",
        producerId: domain === "worker" ? "process_manager" : "agent_runner",
        producerGeneration: `g-${domain}`,
        sentAt: 11,
        controlSequence: 1,
        committedSequence: 0,
      }),
      11,
    );
  for (const domain of ["execution", "model"] as const) {
    assert.equal(
      acceptAnalyticsSignal(
        db,
        checkpoint({
          kind: "checkpoint",
          domain,
          producerGeneration: `g-${domain}`,
          sentAt: 20,
          controlSequence: 2,
          committedSequence: 0,
        }),
        20,
      ).accepted,
      true,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT status,last_error_code FROM analytics_domain_state WHERE domain=?",
        )
        .get(domain),
      {
        status: "degraded",
        last_error_code: "SIGNAL_OPEN_FACT_IDENTITY_UNKNOWN",
      },
    );
  }
  const terminalExecution = event({
    producerGeneration: "g-execution",
    eventId: "legacy-exec-terminal",
    sequence: 1,
    eventType: "execution_finished",
    subjectIdentity: "execution:legacy-exec",
    payload: {
      executionId: "legacy-exec",
      runId: "run",
      runtimeKind: "agent_worker",
      runKind: "user",
      parentRunId: null,
      queuedAt: null,
      startedAt: 1,
      endedAt: 2,
      endTimeQuality: "observed",
      endReason: "completed",
    } as any,
  });
  assert.equal(acceptAnalyticsSignal(db, terminalExecution, 21).accepted, true);
  const modelBase: any = {
    kind: "event",
    domain: "model",
    producerNamespace: "agent_worker",
    producerId: "agent_runner",
    producerGeneration: "g-model",
    eventId: "legacy-model-terminal",
    sequence: 1,
    payloadVersion: 1,
    eventType: "model_finished",
    subjectIdentity: "model:legacy-model",
    observedAt: 22,
    payload: {
      modelCallId: "legacy-model",
      executionId: "legacy-exec",
      runId: "run",
      attemptNo: 1,
      providerId: "p",
      modelId: "m",
      startedAt: 1,
      endedAt: 2,
      status: "completed",
      completionQuality: "observed",
      timeoutKind: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      totalSource: "unavailable",
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheComparable: false,
      cacheWriteVerified: false,
      failureKind: null,
    },
  };
  const { analyticsFingerprint } = await import("./signal-store.js");
  assert.equal(
    acceptAnalyticsSignal(
      db,
      { ...modelBase, fingerprint: analyticsFingerprint(modelBase) },
      22,
    ).accepted,
    true,
  );
  for (const domain of ["execution", "model"] as const) {
    acceptAnalyticsSignal(
      db,
      checkpoint({
        kind: "checkpoint",
        domain,
        producerGeneration: `g-${domain}`,
        sentAt: 30,
        controlSequence: 3,
        committedSequence: 1,
      }),
      30,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT last_error_code FROM analytics_domain_state WHERE domain=?",
          )
          .get(domain) as { last_error_code: string | null }
      ).last_error_code,
      null,
    );
  }
});

test("configuration epochs are monotonic, normalized, and disabled signals retain only receipts", async (t) => {
  const root = await dataDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = await openAnalyticsDb(root, 50);
  t.after(() => closeAnalyticsDb(db));
  const slots = [
    {
      domain: "worker" as const,
      producerNamespace: "worker_observer" as const,
      producerId: "process_manager",
    },
    {
      domain: "execution" as const,
      producerNamespace: "agent_worker" as const,
      producerId: "agent_runner",
    },
    {
      domain: "model" as const,
      producerNamespace: "agent_worker" as const,
      producerId: "agent_runner",
    },
  ];
  const first = {
    kind: "expected_slots_config" as const,
    sentAt: 100,
    effectiveAt: 100,
    requestId: "config-1",
    sourceConfigVersion: 1,
    enabledFactDomains: ["execution" as const, "worker" as const],
    slots,
  };
  assert.equal(acceptAnalyticsSignal(db, first, 100).accepted, true);
  db.prepare(
    "UPDATE analytics_domain_state SET collection_started_at=90, reconciled_through=99 WHERE domain='execution'",
  ).run();
  assert.equal(
    acceptAnalyticsSignal(db, { ...first, requestId: "config-1-replay" }, 101)
      .accepted,
    true,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      {
        ...first,
        requestId: "config-1-conflict",
        enabledFactDomains: ["model" as const],
      },
      102,
    ).accepted,
    false,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      {
        ...first,
        requestId: "config-old",
        sourceConfigVersion: 0,
        enabledFactDomains: [],
      },
      103,
    ).accepted,
    false,
  );
  const disabled = {
    ...first,
    requestId: "config-2",
    sentAt: 110,
    effectiveAt: 110,
    sourceConfigVersion: 2,
    enabledFactDomains: [] as Array<"execution" | "worker">,
  };
  assert.equal(acceptAnalyticsSignal(db, disabled, 110).accepted, true);
  assert.deepEqual(
    db
      .prepare(
        "SELECT status, collection_started_at, reconciled_through FROM analytics_domain_state WHERE domain='execution'",
      )
      .get(),
    { status: "disabled", collection_started_at: 90, reconciled_through: 99 },
  );
  const disabledEvent = event({
    eventId: "disabled-event",
    sequence: 1,
    observedAt: 120,
  });
  assert.equal(acceptAnalyticsSignal(db, disabledEvent, 120).accepted, true);
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_event_receipt WHERE event_id='disabled-event'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_execution_fact WHERE execution_id='execution:run-1'",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.equal(
    acceptAnalyticsSignal(
      db,
      {
        ...first,
        requestId: "config-3",
        sentAt: 110,
        effectiveAt: 110,
        sourceConfigVersion: 3,
        enabledFactDomains: ["execution" as const],
      },
      121,
    ).accepted,
    true,
  );
  assert.notEqual(
    (
      db
        .prepare(
          "SELECT status FROM analytics_domain_state WHERE domain='execution'",
        )
        .get() as { status: string }
    ).status,
    "disabled",
  );
  const normalized = db
    .prepare(
      "SELECT enabled_fact_domains_json FROM analytics_domain_config_version WHERE collection_config_version='0000000000000001'",
    )
    .get() as { enabled_fact_domains_json: string };
  assert.deepEqual(JSON.parse(normalized.enabled_fact_domains_json), [
    "execution",
    "worker",
  ]);
  assert.deepEqual(
    db
      .prepare(
        "SELECT collection_config_version, effective_at FROM analytics_domain_config_version WHERE collection_config_version GLOB '[0-9][0-9]*' ORDER BY collection_config_version",
      )
      .all(),
    [
      { collection_config_version: "0000000000000000", effective_at: 0 },
      { collection_config_version: "0000000000000001", effective_at: 100 },
      { collection_config_version: "0000000000000002", effective_at: 110 },
      { collection_config_version: "0000000000000003", effective_at: 110 },
    ],
  );
});
