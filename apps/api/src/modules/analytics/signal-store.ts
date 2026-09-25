import { createHash, randomUUID } from "node:crypto";
import {
  isCanonicalAnalyticsSignal,
  type AnalyticsControlSignal,
  type AnalyticsExpectedSlotsConfigSignal,
  type AnalyticsGenerationControlSignal,
  type AnalyticsSignal,
  type AnalyticsSignalEvent,
  type AnalyticsSignalResult,
} from "@agent-workbench/shared";
import type { AnalyticsDb } from "./analytics-db.js";
import { markDirtyHour } from "./analytics-rollups.js";

const SIGNAL_DOMAINS = new Set(["execution", "model", "worker"]);
const ALLOWED_SLOTS = new Set([
  "execution:agent_worker:agent_runner",
  "model:agent_worker:agent_runner",
  "execution:api_local_fallback:api_local_fallback",
  "model:api_local_fallback:api_local_fallback",
  "worker:worker_observer:process_manager",
]);
const TERMINAL_LIFECYCLES = new Set(["closed", "abandoned"]);
const FACT_DOMAINS = [
  "run",
  "session",
  "message",
  "tool",
  "execution",
  "model",
  "worker",
] as const;
type FactDomain = (typeof FACT_DOMAINS)[number];
type Domain = "execution" | "model" | "worker";
type GenerationControl = AnalyticsGenerationControlSignal;
type GenerationRow = {
  lifecycle: "registered" | "closing" | "closed" | "stale" | "abandoned";
  final_sequence: number | null;
  committed_sequence: number;
  max_observed_at: number | null;
  earliest_open_started_at: number | null;
  known_drop: number;
  dropped_since_sequence: number | null;
  outbox_pending: number;
  oldest_pending_at: number | null;
  loss_epoch: number;
  control_sequence: number;
  last_control_received_at: number;
  received_at: number;
};
type CheckpointRow = {
  last_sequence: number;
  max_observed_at: number | null;
  earliest_open_started_at: number | null;
  open_execution_count: number;
  open_model_count: number;
  known_drop: number;
  outbox_pending: number;
  dropped_since_sequence: number | null;
  oldest_pending_at: number | null;
  loss_epoch: number;
  control_sequence: number;
  received_at: number;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};
const eventFingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const slotKey = (domain: string, namespace: string, producerId: string) =>
  `${domain}:${namespace}:${producerId}`;
const stateDomains = (domain: Domain) =>
  domain === "execution"
    ? (["execution", "agent_duration"] as const)
    : ([domain] as const);
const identity = (signal: AnalyticsSignalEvent | GenerationControl) =>
  [
    signal.domain,
    signal.producerNamespace,
    signal.producerId,
    signal.producerGeneration,
  ] as const;

function setDomainState(
  db: AnalyticsDb,
  domain: Domain,
  status: "healthy" | "degraded" | "stale" | "unavailable" | "disabled",
  code: string | null,
  now: number,
  reconciledThrough?: number,
) {
  for (const target of stateDomains(domain)) {
    db.prepare(
      `UPDATE analytics_domain_state
      SET status=?, last_error_code=?,
          reconciled_through=CASE WHEN ? IS NULL THEN reconciled_through WHEN reconciled_through IS NULL OR reconciled_through < ? THEN ? ELSE reconciled_through END,
          last_succeeded_at=CASE WHEN ? = 'healthy' THEN ? ELSE last_succeeded_at END, updated_at=?
      WHERE domain=?`,
    ).run(
      status,
      code,
      reconciledThrough ?? null,
      reconciledThrough ?? null,
      reconciledThrough ?? null,
      status,
      now,
      now,
      target,
    );
  }
  if (domain === "execution") mirrorExecutionState(db);
}

function markCollectionStarted(db: AnalyticsDb, domain: Domain, at: number) {
  for (const target of stateDomains(domain))
    db.prepare(
      "UPDATE analytics_domain_state SET collection_started_at=COALESCE(collection_started_at, ?) WHERE domain=?",
    ).run(at, target);
}

function mirrorExecutionState(db: AnalyticsDb) {
  db.prepare(
    `UPDATE analytics_domain_state AS duration SET
    collection_started_at=(SELECT collection_started_at FROM analytics_domain_state WHERE domain='execution'),
    reconciled_through=(SELECT reconciled_through FROM analytics_domain_state WHERE domain='execution'),
    rollup_ready_through=(SELECT rollup_ready_through FROM analytics_domain_state WHERE domain='execution'),
    retention_floor=(SELECT retention_floor FROM analytics_domain_state WHERE domain='execution'),
    status=(SELECT status FROM analytics_domain_state WHERE domain='execution'),
    last_succeeded_at=(SELECT last_succeeded_at FROM analytics_domain_state WHERE domain='execution'),
    last_error_code=(SELECT last_error_code FROM analytics_domain_state WHERE domain='execution'),
    updated_at=(SELECT updated_at FROM analytics_domain_state WHERE domain='execution')
    WHERE duration.domain='agent_duration'`,
  ).run();
}

export type CurrentFactDomainConfig = {
  enabled: ReadonlySet<FactDomain>;
  effectiveAt: number;
  revision: string;
};

export function readCurrentFactDomainConfig(
  db: AnalyticsDb,
): CurrentFactDomainConfig {
  const row = db
    .prepare(
      `SELECT enabled_fact_domains_json, effective_at, collection_config_version FROM analytics_domain_config_version
    ORDER BY CAST(collection_config_version AS INTEGER) DESC LIMIT 1`,
    )
    .get() as
    | {
        enabled_fact_domains_json: string;
        effective_at: number;
        collection_config_version: string;
      }
    | undefined;
  if (!row)
    return { enabled: new Set(), effectiveAt: 0, revision: "0000000000000000" };
  try {
    const values = JSON.parse(row.enabled_fact_domains_json);
    if (
      !Array.isArray(values) ||
      values.some((value) => !FACT_DOMAINS.includes(value))
    )
      return {
        enabled: new Set(),
        effectiveAt: row.effective_at,
        revision: row.collection_config_version,
      };
    return {
      enabled: new Set(values as FactDomain[]),
      effectiveAt: row.effective_at,
      revision: row.collection_config_version,
    };
  } catch {
    return {
      enabled: new Set(),
      effectiveAt: row.effective_at,
      revision: row.collection_config_version,
    };
  }
}

export function readCurrentEnabledFactDomains(
  db: AnalyticsDb,
): ReadonlySet<FactDomain> {
  return readCurrentFactDomainConfig(db).enabled;
}

function isSignalDomainEnabled(db: AnalyticsDb, domain: Domain) {
  return readCurrentEnabledFactDomains(db).has(domain);
}

function replaceExpectedSlots(
  db: AnalyticsDb,
  signal: AnalyticsExpectedSlotsConfigSignal,
) {
  const requested = signal.enabledFactDomains;
  if (
    requested.some((domain) => !FACT_DOMAINS.includes(domain)) ||
    new Set(requested).size !== requested.length ||
    !Number.isSafeInteger(signal.sourceConfigVersion) ||
    signal.sourceConfigVersion < 1 ||
    !Number.isSafeInteger(signal.effectiveAt) ||
    signal.effectiveAt < 0
  ) return false;
  const existing = db
    .prepare(
      "SELECT domain, producer_namespace, producer_id FROM analytics_producer_slot WHERE expected_enabled=1 ORDER BY domain, producer_namespace, producer_id",
    )
    .all();
  const incoming = [...signal.slots].sort((a, b) =>
    `${a.domain}:${a.producerNamespace}:${a.producerId}`.localeCompare(
      `${b.domain}:${b.producerNamespace}:${b.producerId}`,
    ),
  );
  const normalizedIncoming = incoming.map((slot) => ({
    domain: slot.domain,
    producer_namespace: slot.producerNamespace,
    producer_id: slot.producerId,
  }));
  const slotDomains = new Set(incoming.map((slot) => slot.domain));
  // Worker facts have no producer in local fallback mode. Normalization is child
  // owned so a caller cannot make Dashboard expect an impossible slot.
  const factDomains = [...new Set(requested)]
    .filter((domain): domain is FactDomain => domain !== "worker" || slotDomains.has("worker"))
    .sort();
  const canonicalContent = canonicalJson({
    effectiveAt: signal.effectiveAt,
    enabledFactDomains: factDomains,
    slots: normalizedIncoming,
  });
  const contentHash = eventFingerprint(canonicalContent);
  const source = db.prepare(
    "SELECT source_config_version, effective_at, content_hash, canonical_content FROM analytics_config_source_control WHERE singleton=1",
  ).get() as { source_config_version: number; effective_at: number; content_hash: string; canonical_content: string } | undefined;
  if (source) {
    if (signal.sourceConfigVersion < source.source_config_version) return false;
    if (signal.sourceConfigVersion === source.source_config_version)
      return source.effective_at === signal.effectiveAt &&
        source.content_hash === contentHash &&
        source.canonical_content === canonicalContent;
    // A newly ordered source config cannot be made retrospectively effective.
    if (signal.effectiveAt < source.effective_at) return false;
  }
  const current = db
    .prepare(
      `SELECT collection_config_version, enabled_fact_domains_json FROM analytics_domain_config_version
      ORDER BY CAST(collection_config_version AS INTEGER) DESC LIMIT 1`,
    )
    .get() as { collection_config_version: string; enabled_fact_domains_json: string } | undefined;
  // Source revisions carry ordering independently from collection revisions.
  // A different source revision with identical normalized content advances the
  // source control only; it has no prospective collection side effects.
  if (current && current.enabled_fact_domains_json === JSON.stringify(factDomains) && canonicalJson(existing) === canonicalJson(normalizedIncoming)) {
    db.prepare(`INSERT INTO analytics_config_source_control
      (singleton, source_config_version, effective_at, content_hash, canonical_content)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET source_config_version=excluded.source_config_version,
        effective_at=excluded.effective_at, content_hash=excluded.content_hash,
        canonical_content=excluded.canonical_content`).run(
      signal.sourceConfigVersion, signal.effectiveAt, contentHash, canonicalContent,
    );
    return true;
  }
  const maxRevision = db
    .prepare(
      `SELECT MAX(CAST(collection_config_version AS INTEGER)) AS value
      FROM analytics_domain_config_version`,
    )
    .get() as { value: number | null };
  const nextRevision = (maxRevision.value ?? 0) + 1;
  if (!Number.isSafeInteger(nextRevision)) return false;
  const revision = String(nextRevision).padStart(16, "0");
  db.prepare(
    "UPDATE analytics_producer_slot SET expected_enabled=0, config_version=?, updated_at=? WHERE expected_enabled=1",
  ).run(revision, signal.effectiveAt);
  const insert = db.prepare(`INSERT INTO analytics_producer_slot (domain, producer_namespace, producer_id, expected_enabled, config_version, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(domain, producer_namespace, producer_id) DO UPDATE SET
      expected_enabled=1, config_version=excluded.config_version, updated_at=excluded.updated_at`);
  for (const slot of incoming)
    insert.run(slot.domain, slot.producerNamespace, slot.producerId, revision, signal.effectiveAt);
  for (const domain of FACT_DOMAINS) {
    const enabled = factDomains.includes(domain);
    if (!enabled) {
      // Config changes are prospective. Historic coverage remains available for
      // old enabled segments and must never be erased on disable.
      db.prepare(
        "UPDATE analytics_domain_state SET status='disabled', last_error_code=NULL, updated_at=? WHERE domain=?",
      ).run(signal.effectiveAt, domain);
      if (domain === "execution") mirrorExecutionState(db);
      if (["run", "session", "message", "tool"].includes(domain))
        db.prepare("DELETE FROM analytics_collector_watermark WHERE domain=?").run(domain);
    } else {
      db.prepare(
        "UPDATE analytics_domain_state SET status='unavailable', last_error_code=NULL, updated_at=? WHERE domain=? AND status='disabled'",
      ).run(signal.effectiveAt, domain);
      if (domain === "execution") mirrorExecutionState(db);
    }
  }
  db.prepare(`INSERT INTO analytics_domain_config_version
    (collection_config_version, effective_at, enabled_fact_domains_json, changed_at)
    VALUES (?, ?, ?, ?)`).run(revision, signal.effectiveAt, JSON.stringify(factDomains), signal.effectiveAt);
  db.prepare(`INSERT INTO analytics_config_source_control
    (singleton, source_config_version, effective_at, content_hash, canonical_content)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET source_config_version=excluded.source_config_version,
      effective_at=excluded.effective_at, content_hash=excluded.content_hash,
      canonical_content=excluded.canonical_content`).run(
    signal.sourceConfigVersion, signal.effectiveAt, contentHash, canonicalContent,
  );
  return true;
}

function generationRow(
  db: AnalyticsDb,
  signal: GenerationControl,
): GenerationRow | undefined {
  const [domain, ns, id, generation] = identity(signal);
  return db
    .prepare(
      `SELECT lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at,
    known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, last_control_received_at
    FROM analytics_producer_generation WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
    )
    .get(domain, ns, id, generation) as GenerationRow | undefined;
}

function generationValues(signal: GenerationControl) {
  return [
    signal.domain,
    signal.producerNamespace,
    signal.producerId,
    signal.producerGeneration,
    signal.finalSequence,
    signal.committedSequence,
    signal.maxObservedAt,
    signal.earliestOpenStartedAt,
    signal.knownDrop ? 1 : 0,
    signal.droppedSinceSequence,
    signal.outboxPending,
    signal.oldestPendingAt,
    signal.lossEpoch,
    signal.controlSequence,
    signal.sentAt,
    signal.sentAt,
  ];
}

type ControlPreflight = "new" | "idempotent" | "rejected";

function preflightGenerationControl(
  db: AnalyticsDb,
  signal: GenerationControl,
  lifecycle: GenerationRow["lifecycle"],
): ControlPreflight {
  const existing = generationRow(db, signal);
  const checkpointMatches = () => {
    const checkpoint = db
      .prepare(
        `SELECT last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count,
      known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, received_at
      FROM analytics_producer_checkpoint WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
      )
      .get(...identity(signal)) as CheckpointRow | undefined;
    return (
      checkpoint?.last_sequence === signal.committedSequence &&
      checkpoint.max_observed_at === signal.maxObservedAt &&
      checkpoint.earliest_open_started_at === signal.earliestOpenStartedAt &&
      checkpoint.open_execution_count === signal.openExecutionCount &&
      checkpoint.open_model_count === signal.openModelCount &&
      checkpoint.known_drop === (signal.knownDrop ? 1 : 0) &&
      checkpoint.dropped_since_sequence === signal.droppedSinceSequence &&
      checkpoint.outbox_pending === signal.outboxPending &&
      checkpoint.oldest_pending_at === signal.oldestPendingAt &&
      checkpoint.loss_epoch === signal.lossEpoch &&
      checkpoint.control_sequence === signal.controlSequence &&
      checkpoint.received_at === signal.sentAt
    );
  };
  // Controls are a per-domain, per-generation linear history. A replay is
  // accepted only when it is byte-for-byte equivalent to stored control state;
  // older and conflicting controls cannot regress closing/closed or finality.
  if (!existing) return "new";
  if (signal.controlSequence < existing.control_sequence) return "rejected";
  if (signal.controlSequence === existing.control_sequence) {
    const identical =
      existing.lifecycle === lifecycle &&
      existing.final_sequence === signal.finalSequence &&
      existing.committed_sequence === signal.committedSequence &&
      existing.max_observed_at === signal.maxObservedAt &&
      existing.earliest_open_started_at === signal.earliestOpenStartedAt &&
      existing.known_drop === (signal.knownDrop ? 1 : 0) &&
      existing.dropped_since_sequence === signal.droppedSinceSequence &&
      existing.outbox_pending === signal.outboxPending &&
      existing.oldest_pending_at === signal.oldestPendingAt &&
      existing.loss_epoch === signal.lossEpoch &&
      existing.last_control_received_at === signal.sentAt;
    if (!identical) return "rejected";
    if (signal.kind === "checkpoint")
      return checkpointMatches() ? "idempotent" : "rejected";
    const checkpointAtSequence = db
      .prepare(
        `SELECT 1 FROM analytics_producer_checkpoint WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=? AND control_sequence=?`,
      )
      .get(...identity(signal), signal.controlSequence);
    return checkpointAtSequence ? "rejected" : "idempotent";
  }
  return TERMINAL_LIFECYCLES.has(existing.lifecycle) ? "rejected" : "new";
}

function writeGeneration(
  db: AnalyticsDb,
  signal: GenerationControl,
  lifecycle: GenerationRow["lifecycle"],
) {
  if (preflightGenerationControl(db, signal, lifecycle) !== "new") return false;
  db.prepare(
    `INSERT INTO analytics_producer_slot (domain, producer_namespace, producer_id, expected_enabled, config_version, updated_at)
    VALUES (?, ?, ?, 0, 'producer', ?) ON CONFLICT(domain, producer_namespace, producer_id) DO NOTHING`,
  ).run(
    signal.domain,
    signal.producerNamespace,
    signal.producerId,
    signal.sentAt,
  );
  const effectiveLifecycle = lifecycle;
  // A strictly newer control owns every mutable lifecycle/control field.
  db.prepare(
    `INSERT INTO analytics_producer_generation
    (domain, producer_namespace, producer_id, producer_generation, lifecycle, final_sequence, committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, last_control_received_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain, producer_namespace, producer_id, producer_generation) DO UPDATE SET
      lifecycle=excluded.lifecycle, final_sequence=COALESCE(excluded.final_sequence, final_sequence), committed_sequence=MAX(committed_sequence, excluded.committed_sequence),
      max_observed_at=CASE WHEN excluded.max_observed_at IS NULL THEN max_observed_at WHEN max_observed_at IS NULL THEN excluded.max_observed_at ELSE MAX(max_observed_at, excluded.max_observed_at) END,
      earliest_open_started_at=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.earliest_open_started_at ELSE earliest_open_started_at END,
      known_drop=MAX(known_drop, excluded.known_drop),
      dropped_since_sequence=COALESCE(dropped_since_sequence, excluded.dropped_since_sequence),
      outbox_pending=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.outbox_pending ELSE outbox_pending END,
      oldest_pending_at=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.oldest_pending_at ELSE oldest_pending_at END,
      loss_epoch=MAX(loss_epoch, excluded.loss_epoch), control_sequence=MAX(control_sequence, excluded.control_sequence), last_control_received_at=MAX(last_control_received_at, excluded.last_control_received_at)`,
  ).run(
    ...generationValues(signal).slice(0, 4),
    effectiveLifecycle,
    ...generationValues(signal).slice(4),
  );
  return true;
}

/** A terminal model generation may receive an outbox event after its terminal
 * control.  It is receipt/fact-only: recovery must not revive lifecycle or
 * alter certified completeness. */
function ensureEventGeneration(
  db: AnalyticsDb,
  event: AnalyticsSignalEvent,
): "active" | "terminal" | false {
  const existing = generationRow(db, event as unknown as GenerationControl);
  if (existing && TERMINAL_LIFECYCLES.has(existing.lifecycle)) {
    return event.domain === "model" ? "terminal" : false;
  }
  if (existing) return "active";
  const synthetic: GenerationControl = {
    kind: "register",
    domain: event.domain,
    producerNamespace: event.producerNamespace,
    producerId: event.producerId,
    producerGeneration: event.producerGeneration,
    sentAt: event.observedAt,
    controlSequence: 1,
    finalSequence: null,
    committedSequence: 0,
    maxObservedAt: event.observedAt,
    earliestOpenStartedAt: null,
    openExecutionCount: 0,
    openModelCount: 0,
    knownDrop: false,
    droppedSinceSequence: null,
    outboxPending: 0,
    oldestPendingAt: null,
    lossEpoch: 0,
  };
  return writeGeneration(db, synthetic, "registered") ? "active" : false;
}

function writeCheckpoint(db: AnalyticsDb, signal: GenerationControl) {
  const [domain, ns, id, generation] = identity(signal);
  db.prepare(
    `INSERT INTO analytics_producer_checkpoint
    (domain, producer_namespace, producer_id, producer_generation, last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain, producer_namespace, producer_id, producer_generation) DO UPDATE SET
      last_sequence=MAX(last_sequence, excluded.last_sequence), max_observed_at=CASE WHEN excluded.max_observed_at IS NULL THEN max_observed_at WHEN max_observed_at IS NULL THEN excluded.max_observed_at ELSE MAX(max_observed_at, excluded.max_observed_at) END,
      earliest_open_started_at=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.earliest_open_started_at ELSE earliest_open_started_at END,
      open_execution_count=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.open_execution_count ELSE open_execution_count END,
      open_model_count=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.open_model_count ELSE open_model_count END,
      known_drop=MAX(known_drop, excluded.known_drop), dropped_since_sequence=COALESCE(excluded.dropped_since_sequence, dropped_since_sequence),
      outbox_pending=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.outbox_pending ELSE outbox_pending END,
      oldest_pending_at=CASE WHEN excluded.control_sequence > control_sequence THEN excluded.oldest_pending_at ELSE oldest_pending_at END,
      loss_epoch=MAX(loss_epoch, excluded.loss_epoch), control_sequence=MAX(control_sequence, excluded.control_sequence), received_at=MAX(received_at, excluded.received_at)`,
  ).run(
    domain,
    ns,
    id,
    generation,
    signal.committedSequence,
    signal.maxObservedAt,
    signal.earliestOpenStartedAt,
    signal.openExecutionCount,
    signal.openModelCount,
    signal.knownDrop ? 1 : 0,
    signal.droppedSinceSequence,
    signal.outboxPending,
    signal.oldestPendingAt,
    signal.lossEpoch,
    signal.controlSequence,
    signal.sentAt,
  );
}

function receiptContinuous(
  db: AnalyticsDb,
  namespace: string,
  producerId: string,
  generation: string,
  sequence: number,
) {
  if (sequence === 0) return true;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(sequence) AS minimum, MAX(sequence) AS maximum
    FROM analytics_event_receipt WHERE producer_namespace=? AND producer_id=? AND producer_generation=? AND sequence <= ?`,
    )
    .get(namespace, producerId, generation, sequence) as {
    count: number;
    minimum: number | null;
    maximum: number | null;
  };
  return (
    row.count === sequence && row.minimum === 1 && row.maximum === sequence
  );
}

function databaseOpenStart(
  db: AnalyticsDb,
  domain: Domain,
  namespace: string,
  producerId: string,
  generation: string,
): number | null {
  if (domain === "execution") {
    const row = db
      .prepare(
        "SELECT MIN(started_at) AS started_at FROM analytics_execution_fact WHERE producer_namespace=? AND producer_id=? AND producer_generation=? AND status != 'ended'",
      )
      .get(namespace, producerId, generation) as { started_at: number | null };
    return row.started_at;
  }
  if (domain === "model") {
    const row = db
      .prepare(
        "SELECT MIN(started_at) AS started_at FROM analytics_model_call_fact WHERE producer_namespace=? AND producer_id=? AND producer_generation=? AND status = 'running'",
      )
      .get(namespace, producerId, generation) as { started_at: number | null };
    return row.started_at;
  }
  return null;
}

/** Pre-v14 open Facts have no producer identity. They are a domain-level
 * uncertainty, not evidence against an arbitrary new generation. */
function hasLegacyUnknownOpenFact(db: AnalyticsDb, domain: Domain) {
  if (domain === "execution")
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM analytics_execution_fact WHERE producer_namespace IS NULL AND status != 'ended' LIMIT 1",
        )
        .get(),
    );
  if (domain === "model")
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM analytics_model_call_fact WHERE producer_namespace IS NULL AND status = 'running' LIMIT 1",
        )
        .get(),
    );
  return false;
}

/**
 * A replacement producer can narrow an abandoned generation's open gap only
 * after every earlier, same-slot Fact is safe at the proposed boundary.  This
 * deliberately looks across generations (and legacy rows without identity):
 * checking only the replacement's own open Facts would certify a tail that the
 * failed generation may still have left unknown.
 */
function hasReplacementGapRisk(
  db: AnalyticsDb,
  domain: Domain,
  namespace: string,
  producerId: string,
  replacementGeneration: string,
  candidate: number,
) {
  if (domain === "model") {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM analytics_model_call_fact
           WHERE started_at < ? AND status='running'
             AND (
               (producer_namespace=? AND producer_id=? AND producer_generation != ?)
               OR producer_namespace IS NULL
             )
           LIMIT 1`,
        )
        .get(candidate, namespace, producerId, replacementGeneration),
    );
  }
  if (domain === "execution") {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM analytics_execution_fact
           WHERE started_at IS NOT NULL AND started_at < ?
             AND (
               status != 'ended'
               OR end_time_quality = 'unknown'
               OR effective_ended_at IS NULL
             )
             AND (
               (producer_namespace=? AND producer_id=? AND producer_generation != ?)
               OR producer_namespace IS NULL
             )
           LIMIT 1`,
        )
        .get(candidate, namespace, producerId, replacementGeneration),
    );
  }
  return false;
}

function closeReplacementGaps(
  db: AnalyticsDb,
  domain: Domain,
  namespace: string,
  producerId: string,
  generation: string,
  candidate: number,
  closedAt: number,
) {
  db.prepare(
    `UPDATE analytics_signal_coverage_gap SET gap_to=?, closed_at=?
    WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation != ?
      AND gap_to IS NULL AND gap_from < ?`,
  ).run(
    candidate,
    closedAt,
    domain,
    namespace,
    producerId,
    generation,
    candidate,
  );
}

/** The only signal completeness authority. It runs inside the accepting transaction. */
export function authenticateSignalDomain(
  db: AnalyticsDb,
  domain: Domain,
  now = Date.now(),
  freshnessMs = 15_000,
) {
  const slots = db
    .prepare(
      `SELECT producer_namespace, producer_id FROM analytics_producer_slot
    WHERE domain=? AND expected_enabled=1 ORDER BY producer_namespace, producer_id`,
    )
    .all(domain) as Array<{ producer_namespace: string; producer_id: string }>;
  if (slots.length === 0) {
    setDomainState(
      db,
      domain,
      domain === "worker" ? "disabled" : "degraded",
      domain === "worker" ? null : "SIGNAL_EXPECTED_SLOT_MISSING",
      now,
    );
    return null;
  }
  if (hasLegacyUnknownOpenFact(db, domain)) {
    setDomainState(
      db,
      domain,
      "degraded",
      "SIGNAL_OPEN_FACT_IDENTITY_UNKNOWN",
      now,
    );
    return null;
  }
  const candidates: Array<{
    candidate: number;
    namespace: string;
    producerId: string;
    generation: string;
  }> = [];
  for (const slot of slots) {
    const unsafeAbandoned = db
      .prepare(
        `SELECT 1 FROM analytics_producer_generation g
      WHERE domain=? AND producer_namespace=? AND producer_id=? AND lifecycle='abandoned'
        AND NOT EXISTS (SELECT 1 FROM analytics_signal_coverage_gap gap WHERE gap.domain=g.domain AND gap.producer_namespace=g.producer_namespace
          AND gap.producer_id=g.producer_id AND gap.producer_generation=g.producer_generation AND gap.cause='abandoned_exit')`,
      )
      .get(domain, slot.producer_namespace, slot.producer_id);
    if (unsafeAbandoned) {
      setDomainState(
        db,
        domain,
        "degraded",
        "SIGNAL_ABANDONED_GAP_UNRECORDED",
        now,
      );
      return null;
    }
    const generations = db
      .prepare(
        `SELECT lifecycle, producer_generation, known_drop, outbox_pending, last_control_received_at
      FROM analytics_producer_generation WHERE domain=? AND producer_namespace=? AND producer_id=?
        AND lifecycle IN ('registered','closing','stale') ORDER BY created_at ASC, producer_generation ASC`,
      )
      .all(domain, slot.producer_namespace, slot.producer_id) as Array<{
      lifecycle: "registered" | "closing" | "stale";
      producer_generation: string;
      known_drop: number;
      outbox_pending: number;
      last_control_received_at: number;
    }>;
    if (generations.length === 0) {
      setDomainState(
        db,
        domain,
        "degraded",
        "SIGNAL_CHECKPOINT_MISSING_OR_STALE",
        now,
      );
      return null;
    }
    for (const generation of generations) {
      if (
        generation.lifecycle === "stale" ||
        generation.last_control_received_at < now - freshnessMs
      ) {
        setDomainState(
          db,
          domain,
          generation.lifecycle === "stale" ? "stale" : "degraded",
          generation.lifecycle === "stale"
            ? "SIGNAL_STALE"
            : "SIGNAL_CHECKPOINT_MISSING_OR_STALE",
          now,
        );
        return null;
      }
      const checkpoint = db
        .prepare(
          `SELECT last_sequence, max_observed_at, earliest_open_started_at, open_execution_count, open_model_count, known_drop, outbox_pending, received_at
        FROM analytics_producer_checkpoint WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
        )
        .get(
          domain,
          slot.producer_namespace,
          slot.producer_id,
          generation.producer_generation,
        ) as CheckpointRow | undefined;
      const openCount =
        (domain === "execution"
          ? checkpoint?.open_execution_count
          : domain === "model"
            ? checkpoint?.open_model_count
            : 0) ?? 0;
      if (
        !checkpoint ||
        checkpoint.received_at < now - freshnessMs ||
        checkpoint.known_drop ||
        checkpoint.outbox_pending > 0 ||
        generation.known_drop ||
        generation.outbox_pending > 0 ||
        !receiptContinuous(
          db,
          slot.producer_namespace,
          slot.producer_id,
          generation.producer_generation,
          checkpoint.last_sequence,
        )
      ) {
        setDomainState(
          db,
          domain,
          "degraded",
          "SIGNAL_RECEIPT_OR_CHECKPOINT_INCOMPLETE",
          now,
        );
        return null;
      }
      if (generation.lifecycle === "closing") {
        setDomainState(
          db,
          domain,
          "degraded",
          "SIGNAL_GENERATION_CLOSING",
          now,
        );
        return null;
      }
      if (
        checkpoint.max_observed_at === null ||
        (openCount === 0 && checkpoint.earliest_open_started_at !== null) ||
        (openCount > 0 && checkpoint.earliest_open_started_at === null)
      ) {
        setDomainState(
          db,
          domain,
          "degraded",
          "SIGNAL_OPEN_FACT_INCONSISTENT",
          now,
        );
        return null;
      }
      const factOpen = databaseOpenStart(
        db,
        domain,
        slot.producer_namespace,
        slot.producer_id,
        generation.producer_generation,
      );
      if (
        (openCount === 0) !== (factOpen === null) ||
        (factOpen !== null && checkpoint.earliest_open_started_at !== factOpen)
      ) {
        setDomainState(
          db,
          domain,
          "degraded",
          "SIGNAL_OPEN_FACT_INCONSISTENT",
          now,
        );
        return null;
      }
      candidates.push({
        candidate: Math.min(
          checkpoint.max_observed_at,
          checkpoint.earliest_open_started_at ?? Number.MAX_SAFE_INTEGER,
          factOpen ?? Number.MAX_SAFE_INTEGER,
        ),
        namespace: slot.producer_namespace,
        producerId: slot.producer_id,
        generation: generation.producer_generation,
      });
    }
  }
  const candidate = Math.min(...candidates.map((row) => row.candidate));
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    setDomainState(
      db,
      domain,
      "degraded",
      "SIGNAL_OPEN_FACT_INCONSISTENT",
      now,
    );
    return null;
  }
  if (
    candidates.some((row) =>
      hasReplacementGapRisk(
        db,
        domain,
        row.namespace,
        row.producerId,
        row.generation,
        candidate,
      ),
    )
  ) {
    setDomainState(db, domain, "degraded", "SIGNAL_OPEN_FACT_INCONSISTENT", now);
    return null;
  }
  setDomainState(db, domain, "healthy", null, now, candidate);
  for (const row of candidates)
    closeReplacementGaps(
      db,
      domain,
      row.namespace,
      row.producerId,
      row.generation,
      candidate,
      now,
    );
  if (domain === "execution") mirrorExecutionState(db);
  return candidate;
}

function gapFrom(db: AnalyticsDb, domain: Domain) {
  const row = db
    .prepare(
      "SELECT reconciled_through, collection_started_at FROM analytics_domain_state WHERE domain=?",
    )
    .get(domain) as
    | {
        reconciled_through: number | null;
        collection_started_at: number | null;
      }
    | undefined;
  return row?.reconciled_through ?? row?.collection_started_at ?? null;
}

function createGap(
  db: AnalyticsDb,
  signal: GenerationControl,
  cause: "known_drop" | "abandoned_exit" | "outbox_corrupt",
) {
  const from = gapFrom(db, signal.domain);
  if (from === null) return false;
  const [domain, ns, id, generation] = identity(signal);
  const existing = db
    .prepare(
      `SELECT gap_id FROM analytics_signal_coverage_gap
    WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=? AND gap_to IS NULL`,
    )
    .get(domain, ns, id, generation);
  if (!existing)
    db.prepare(
      `INSERT INTO analytics_signal_coverage_gap
    (gap_id, domain, producer_namespace, producer_id, producer_generation, gap_from, gap_to, cause, dropped_since_sequence, recorded_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    ).run(
      randomUUID(),
      domain,
      ns,
      id,
      generation,
      from,
      cause,
      signal.droppedSinceSequence,
      signal.sentAt,
    );
  else if (cause === "outbox_corrupt")
    db.prepare(
      "UPDATE analytics_signal_coverage_gap SET cause='outbox_corrupt', recorded_at=MAX(recorded_at, ?) WHERE gap_id=?",
    ).run(signal.sentAt, (existing as { gap_id: string }).gap_id);
  return true;
}

/** Child-internal only: diagnostics from the API supervisor may mark durable
 * Model Outbox corruption even after a generation became terminal. */
export function diagnoseOutboxCorrupt(
  db: AnalyticsDb,
  input: {
    producerNamespace: "agent_worker";
    producerId: "agent_runner";
    producerGeneration: string;
    recordedAt: number;
  },
) {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT domain, committed_sequence, max_observed_at, earliest_open_started_at, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch, control_sequence
      FROM analytics_producer_generation WHERE domain='model' AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
      )
      .get(
        input.producerNamespace,
        input.producerId,
        input.producerGeneration,
      ) as Record<string, unknown> | undefined;
    if (!row) return false;
    db.prepare(
      `UPDATE analytics_producer_generation SET known_drop=1, dropped_since_sequence=COALESCE(dropped_since_sequence, 1), loss_epoch=MAX(loss_epoch, ?), last_control_received_at=MAX(last_control_received_at, ?) WHERE domain='model' AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
    ).run(
      Number(row.loss_epoch ?? 0) + 1,
      input.recordedAt,
      input.producerNamespace,
      input.producerId,
      input.producerGeneration,
    );
    const synthetic: GenerationControl = {
      kind: "checkpoint",
      domain: "model",
      producerNamespace: input.producerNamespace,
      producerId: input.producerId,
      producerGeneration: input.producerGeneration,
      sentAt: input.recordedAt,
      controlSequence: Number(row.control_sequence ?? 1),
      finalSequence: null,
      committedSequence: Number(row.committed_sequence ?? 0),
      maxObservedAt: row.max_observed_at as number | null,
      earliestOpenStartedAt: row.earliest_open_started_at as number | null,
      openExecutionCount: 0,
      openModelCount: 0,
      knownDrop: true,
      droppedSinceSequence: (row.dropped_since_sequence as number | null) ?? 1,
      outboxPending: Number(row.outbox_pending ?? 0),
      oldestPendingAt: row.oldest_pending_at as number | null,
      lossEpoch: Number(row.loss_epoch ?? 0) + 1,
    };
    createGap(db, synthetic, "outbox_corrupt");
    setDomainState(
      db,
      "model",
      "degraded",
      "SIGNAL_OUTBOX_CORRUPT",
      input.recordedAt,
    );
    return true;
  })();
}

function canClose(db: AnalyticsDb, signal: GenerationControl) {
  const final = signal.finalSequence;
  const persisted = generationRow(db, signal);
  const checkpoint = db
    .prepare(
      `SELECT known_drop, outbox_pending, open_execution_count, open_model_count, last_sequence
    FROM analytics_producer_checkpoint WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
    )
    .get(...identity(signal)) as
    | {
        known_drop: number;
        outbox_pending: number;
        open_execution_count: number;
        open_model_count: number;
        last_sequence: number;
      }
    | undefined;
  return (
    final !== null &&
    signal.committedSequence === final &&
    !signal.knownDrop &&
    signal.outboxPending === 0 &&
    signal.openExecutionCount === 0 &&
    signal.openModelCount === 0 &&
    !persisted?.known_drop &&
    (persisted?.outbox_pending ?? 0) === 0 &&
    !checkpoint?.known_drop &&
    (checkpoint?.outbox_pending ?? 0) === 0 &&
    (checkpoint?.open_execution_count ?? 0) === 0 &&
    (checkpoint?.open_model_count ?? 0) === 0 &&
    (checkpoint?.last_sequence ?? final) <= final &&
    receiptContinuous(
      db,
      signal.producerNamespace,
      signal.producerId,
      signal.producerGeneration,
      final,
    ) &&
    databaseOpenStart(
      db,
      signal.domain,
      signal.producerNamespace,
      signal.producerId,
      signal.producerGeneration,
    ) === null
  );
}

/** Child-internal supervisor operation; public producers cannot request it. */
export function abandonGeneration(
  db: AnalyticsDb,
  signal: Omit<GenerationControl, "kind">,
  now = Date.now(),
) {
  return db.transaction(() => {
    const existing = generationRow(db, signal as GenerationControl);
    const control: GenerationControl = {
      ...signal,
      kind: "register",
      sentAt: now,
      controlSequence: Math.max(
        signal.controlSequence,
        (existing?.control_sequence ?? 0) + 1,
      ),
    };
    if (!writeGeneration(db, control, "abandoned")) return false;
    createGap(db, control, "abandoned_exit");
    setDomainState(
      db,
      control.domain as Domain,
      "degraded",
      "SIGNAL_ABANDONED",
      now,
    );
    return true;
  })();
}

type LifecycleTarget = {
  domain: Domain;
  producerNamespace: "agent_worker" | "worker_observer" | "api_local_fallback";
  producerId: string;
  producerGeneration: string;
};

/** Exit evidence is target-bound: late delivery must never abandon a replacement. */
function abandonLifecycleTargets(
  db: AnalyticsDb,
  targets: LifecycleTarget[],
  now: number,
) {
  for (const target of targets) {
    const row = db
      .prepare(
        `SELECT committed_sequence, max_observed_at, earliest_open_started_at, known_drop, dropped_since_sequence, outbox_pending, oldest_pending_at, loss_epoch
      FROM analytics_producer_generation WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=?
        AND lifecycle IN ('registered','closing','stale')`,
      )
      .get(
        target.domain,
        target.producerNamespace,
        target.producerId,
        target.producerGeneration,
      ) as Record<string, unknown> | undefined;
    if (!row) continue;
    abandonGeneration(
      db,
      {
        domain: target.domain,
        producerNamespace: target.producerNamespace,
        producerId: target.producerId,
        producerGeneration: target.producerGeneration,
        sentAt: now,
        controlSequence: 1,
        finalSequence: null,
        committedSequence: Number(row.committed_sequence),
        maxObservedAt: row.max_observed_at as number | null,
        earliestOpenStartedAt: row.earliest_open_started_at as number | null,
        openExecutionCount: 0,
        openModelCount: 0,
        knownDrop: Boolean(row.known_drop),
        droppedSinceSequence: row.dropped_since_sequence as number | null,
        outboxPending: Number(row.outbox_pending),
        oldestPendingAt: row.oldest_pending_at as number | null,
        lossEpoch: Number(row.loss_epoch),
      },
      now,
    );
  }
}

/** API-supervisor-only recovery for a durable local-fallback lifecycle intent. */
export function abandonLocalFallbackGeneration(
  db: AnalyticsDb,
  producerGeneration: string,
  now = Date.now(),
) {
  if (!producerGeneration || producerGeneration.length > 160) return false;
  return db.transaction(() => {
    abandonLifecycleTargets(
      db,
      (["execution", "model"] as Domain[]).map((domain) => ({
        domain,
        producerNamespace: "api_local_fallback" as const,
        producerId: "api_local_fallback",
        producerGeneration,
      })),
      now,
    );
    // A crash can happen after intent persistence but before register reaches
    // the child. That is still a completed recovery operation, not a retry.
    return true;
  })();
}

function recordUnknownExitGap(
  db: AnalyticsDb,
  signal: AnalyticsSignalEvent,
  now: number,
) {
  createGap(
    db,
    {
      ...signal,
      kind: "register",
      sentAt: signal.observedAt,
      controlSequence: 1,
      finalSequence: null,
      committedSequence: 0,
      maxObservedAt: signal.observedAt,
      earliestOpenStartedAt: null,
      openExecutionCount: 0,
      openModelCount: 0,
      knownDrop: false,
      droppedSinceSequence: null,
      outboxPending: 0,
      oldestPendingAt: null,
      lossEpoch: 0,
    },
    "abandoned_exit",
  );
  setDomainState(db, "worker", "degraded", "SIGNAL_EXIT_TARGET_UNKNOWN", now);
}

/** A worker-exit receipt is evidence only for Runs with a recorded, still-open
 * agent-worker execution.  It never mutates the business database; a later
 * observed collector row intentionally wins through storeRuns' upsert. */
function inferInterruptedRuns(
  db: AnalyticsDb,
  targets: LifecycleTarget[],
  now: number,
) {
  const executionTargets = targets.filter(
    (target) =>
      target.domain === "execution" &&
      target.producerNamespace === "agent_worker",
  );
  if (executionTargets.length === 0) return;
  const targetSql = executionTargets
    .map(
      () =>
        "(e.producer_namespace=? AND e.producer_id=? AND e.producer_generation=?)",
    )
    .join(" OR ");
  db.prepare(
    `UPDATE analytics_run_fact
    SET display_status='interrupted', status_quality='inferred',
      inferred_evidence_type='worker_unexpected_exit', terminal_at=COALESCE(terminal_at, ?)
    WHERE display_status='running' AND status_quality='observed'
      AND EXISTS (SELECT 1 FROM analytics_execution_fact e
        WHERE e.run_id=analytics_run_fact.run_id
          AND e.runtime_kind='agent_worker' AND e.status!='ended' AND (${targetSql}))`,
  ).run(
    now,
    ...executionTargets.flatMap((target) => [
      target.producerNamespace,
      target.producerId,
      target.producerGeneration,
    ]),
  );
}

/** An exact unexpected-exit target closes only its currently open execution
 * facts. The timestamp is useful only when it forms a positive interval; an
 * invalid ordering records terminal evidence without manufacturing duration. */
function inferExecutionEndsFromWorkerExit(
  db: AnalyticsDb,
  targets: LifecycleTarget[],
  occurredAt: number,
  now: number,
) {
  const executionTargets = targets.filter(
    (target) => target.domain === "execution" && target.producerNamespace === "agent_worker",
  );
  if (executionTargets.length === 0) return;
  const targetSql = executionTargets.map(
    () => "(producer_namespace=? AND producer_id=? AND producer_generation=?)",
  ).join(" OR ");
  db.prepare(
    `UPDATE analytics_execution_fact
     SET status='ended',
       ended_at=CASE WHEN ? > started_at THEN ? ELSE NULL END,
       effective_ended_at=CASE WHEN ? > started_at THEN ? ELSE NULL END,
       end_time_quality=CASE WHEN ? > started_at THEN 'inferred' ELSE 'unknown' END,
       end_reason='worker_exit', updated_at=MAX(updated_at, ?)
     WHERE status!='ended' AND (${targetSql})`,
  ).run(
    occurredAt, occurredAt, occurredAt, occurredAt, occurredAt, now,
    ...executionTargets.flatMap((target) => [
      target.producerNamespace,
      target.producerId,
      target.producerGeneration,
    ]),
  );
}

function applyFact(db: AnalyticsDb, event: AnalyticsSignalEvent, now: number) {
  const p = event.payload as Record<string, unknown>;
  if (event.domain === "execution") {
    const ended = p.endedAt as number | null;
    const raw = String(p.endReason ?? "other");
    const endedState =
      ended !== null || event.eventType === "execution_finished";
    const reason =
      raw === "completed"
        ? "completed"
        : raw === "failed"
          ? "failed"
          : raw === "cancelled"
            ? "cancelled"
            : raw === "timed_out"
              ? "timed_out"
              : "other";
    db.prepare(
      `INSERT INTO analytics_execution_fact
      (execution_id, run_id, runtime_kind, producer_namespace, producer_id, producer_generation, run_kind, parent_run_id, queued_at, started_at, ended_at, effective_ended_at, status, end_time_quality, end_reason, observed_at, updated_at, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        producer_namespace=COALESCE(analytics_execution_fact.producer_namespace, excluded.producer_namespace),
        producer_id=COALESCE(analytics_execution_fact.producer_id, excluded.producer_id),
        producer_generation=COALESCE(analytics_execution_fact.producer_generation, excluded.producer_generation),
        ended_at=CASE WHEN excluded.status='ended' AND excluded.end_time_quality='observed' AND analytics_execution_fact.end_time_quality!='observed' THEN excluded.ended_at ELSE COALESCE(excluded.ended_at, ended_at) END,
        effective_ended_at=CASE WHEN excluded.status='ended' AND excluded.end_time_quality='observed' AND analytics_execution_fact.end_time_quality!='observed' THEN excluded.effective_ended_at ELSE COALESCE(excluded.effective_ended_at, effective_ended_at) END,
        status=CASE WHEN analytics_execution_fact.status='ended' THEN 'ended' WHEN excluded.status='ended' THEN 'ended' ELSE excluded.status END,
        end_time_quality=CASE WHEN excluded.status='ended' AND analytics_execution_fact.end_time_quality!='observed' THEN excluded.end_time_quality ELSE analytics_execution_fact.end_time_quality END,
        end_reason=CASE WHEN excluded.status='ended' AND excluded.end_time_quality='observed' AND analytics_execution_fact.end_time_quality!='observed' THEN excluded.end_reason ELSE COALESCE(excluded.end_reason, analytics_execution_fact.end_reason) END,
        observed_at=MAX(observed_at, excluded.observed_at), updated_at=MAX(updated_at, excluded.updated_at)`,
    ).run(
      p.executionId ?? event.subjectIdentity,
      p.runId,
      p.runtimeKind ??
        (event.producerNamespace === "agent_worker"
          ? "agent_worker"
          : "api_local_fallback"),
      event.producerNamespace,
      event.producerId,
      event.producerGeneration,
      p.runKind,
      p.parentRunId,
      p.queuedAt ?? p.startedAt,
      p.startedAt,
      ended,
      ended,
      endedState ? "ended" : "running",
      endedState ? "observed" : "unknown",
      endedState ? reason : null,
      event.observedAt,
      now,
      now,
    );
    return;
  }
  if (event.domain === "model") {
    const ended = p.endedAt as number | null;
    const input = p.inputTokens as number | null;
    const output = p.outputTokens as number | null;
    const total = input !== null && output !== null ? input + output : null;
    const status = String(p.status);
    const failure =
      status === "completed" || status === "running"
        ? null
        : status === "timed_out"
          ? "timeout"
          : status === "cancelled"
            ? "cancelled"
            : "provider";
    db.prepare(
      `INSERT INTO analytics_model_call_fact
      (model_call_id, execution_id, run_id, attempt_no, producer_namespace, producer_id, producer_generation, provider_id, model_id, started_at, ended_at, status, completion_quality, timeout_kind, input_tokens, output_tokens, total_tokens, total_source, cache_read_tokens, cache_write_tokens, cache_comparable, cache_write_verified, failure_kind, observed_at, updated_at, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_call_id) DO UPDATE SET
        producer_namespace=COALESCE(analytics_model_call_fact.producer_namespace, excluded.producer_namespace),
        producer_id=COALESCE(analytics_model_call_fact.producer_id, excluded.producer_id),
        producer_generation=COALESCE(analytics_model_call_fact.producer_generation, excluded.producer_generation),
        ended_at=COALESCE(excluded.ended_at, ended_at), status=CASE WHEN analytics_model_call_fact.status='running' THEN excluded.status ELSE analytics_model_call_fact.status END,
        completion_quality=CASE WHEN excluded.ended_at IS NOT NULL THEN excluded.completion_quality ELSE analytics_model_call_fact.completion_quality END,
        timeout_kind=COALESCE(excluded.timeout_kind, timeout_kind), input_tokens=COALESCE(excluded.input_tokens, input_tokens), output_tokens=COALESCE(excluded.output_tokens, output_tokens),
        total_tokens=COALESCE(excluded.total_tokens, total_tokens), total_source=CASE WHEN excluded.total_tokens IS NULL THEN total_source ELSE excluded.total_source END,
        cache_read_tokens=COALESCE(excluded.cache_read_tokens, cache_read_tokens), cache_write_tokens=COALESCE(excluded.cache_write_tokens, cache_write_tokens), cache_comparable=MAX(cache_comparable, excluded.cache_comparable), cache_write_verified=MAX(cache_write_verified, excluded.cache_write_verified), failure_kind=COALESCE(excluded.failure_kind, failure_kind), observed_at=MAX(observed_at, excluded.observed_at), updated_at=MAX(updated_at, excluded.updated_at)`,
    ).run(
      p.modelCallId ?? event.subjectIdentity,
      p.executionId,
      p.runId,
      p.attemptNo ?? 1,
      event.producerNamespace,
      event.producerId,
      event.producerGeneration,
      p.providerId,
      p.modelId,
      p.startedAt,
      ended,
      status,
      p.completionQuality ?? (ended === null ? "unknown" : "observed"),
      p.timeoutKind,
      input,
      output,
      p.totalTokens ?? total,
      p.totalSource ?? (total === null ? "unavailable" : "derived"),
      p.cacheReadTokens,
      p.cacheWriteTokens,
      p.cacheComparable ? 1 : 0,
      p.cacheWriteVerified ? 1 : 0,
      p.failureKind ?? failure,
      event.observedAt,
      now,
      now,
    );
    markDirtyHour(db, "model", p.startedAt as number, now);
    return;
  }
  if (event.eventType === "worker_snapshot") {
    db.prepare(
      `INSERT INTO analytics_worker_live_snapshot (runner_mode, snapshot_at, active_count, queue_length, concurrency, last_ready_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(runner_mode) DO UPDATE SET snapshot_at=MAX(snapshot_at,excluded.snapshot_at), active_count=excluded.active_count, queue_length=excluded.queue_length, concurrency=excluded.concurrency, last_ready_at=COALESCE(excluded.last_ready_at,last_ready_at), received_at=excluded.received_at`,
    ).run(
      p.runnerMode,
      p.snapshotAt,
      p.activeCount,
      p.queueLength,
      p.concurrency,
      p.lastReadyAt,
      now,
    );
    return;
  }
  const workerEvent = String(p.event ?? "ready");
  const eventType =
    workerEvent === "unexpected_exit"
      ? "unexpected_exit"
      : workerEvent === "controlled_stop"
        ? "controlled_stop"
        : workerEvent === "restart_attempted" ||
            event.eventType === "worker_restart_attempted"
          ? "restart_attempted"
          : workerEvent === "restart_succeeded" ||
              event.eventType === "worker_restart_succeeded"
            ? "restart_succeeded"
            : workerEvent === "restart_failed" ||
                event.eventType === "worker_restart_failed"
              ? "restart_failed"
              : "ready";
  const restartAttemptId = eventType.startsWith("restart_")
    ? String(p.restartAttemptId)
    : null;
  db.prepare(
    "INSERT OR IGNORE INTO analytics_worker_event_fact (event_id, occurred_at, event_type, restart_attempt_id, runner_mode, collected_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    event.eventId,
    p.occurredAt,
    eventType,
    restartAttemptId,
    p.runnerMode,
    now,
  );
}

/** Handles only canonical, sanitized contracts in one Analytics transaction. */
export function acceptAnalyticsSignal(
  db: AnalyticsDb,
  signal: AnalyticsSignal,
  now = Date.now(),
): AnalyticsSignalResult {
  return db.transaction(() => {
    if (
      signal.kind === "expected_slots_config" &&
      !isCanonicalAnalyticsSignal(signal)
    )
      return { accepted: false, receipt: null };
    if (signal.kind === "expected_slots_config") {
      if (!replaceExpectedSlots(db, signal))
        return { accepted: false, receipt: null };
      // Configuration is not collection and never proves a zero interval.
      for (const domain of ["execution", "model", "worker"] as const)
        if (isSignalDomainEnabled(db, domain))
          authenticateSignalDomain(db, domain, now);
      return { accepted: true, receipt: null };
    }
    if (
      !SIGNAL_DOMAINS.has(signal.domain) ||
      !ALLOWED_SLOTS.has(
        slotKey(signal.domain, signal.producerNamespace, signal.producerId),
      )
    )
      return { accepted: false, receipt: null };
    if (signal.kind !== "event") {
      const lifecycle =
        signal.kind === "register"
          ? "registered"
          : signal.kind === "closing"
            ? "closing"
            : signal.kind === "closed"
              ? "closed"
              : "registered";
      // Do not let an obsolete or conflicting control mutate collection/domain
      // state, run close validation, or write a checkpoint before rejection.
      const preflight = preflightGenerationControl(db, signal, lifecycle);
      if (preflight === "rejected") return { accepted: false, receipt: null };
      if (preflight === "idempotent") return { accepted: true, receipt: null };
      const domainEnabled = isSignalDomainEnabled(db, signal.domain);
      if (domainEnabled && signal.kind === "closed" && !canClose(db, signal)) {
        setDomainState(
          db,
          signal.domain,
          "degraded",
          "SIGNAL_CLOSE_UNVERIFIED",
          now,
        );
        return { accepted: false, receipt: null };
      }
      if (domainEnabled)
        markCollectionStarted(db, signal.domain, signal.sentAt);
      if (!writeGeneration(db, signal, lifecycle))
        return { accepted: false, receipt: null };
      if (signal.kind === "checkpoint") writeCheckpoint(db, signal);
      if (domainEnabled && signal.knownDrop) {
        createGap(db, signal, "known_drop");
        setDomainState(db, signal.domain, "degraded", "SIGNAL_KNOWN_DROP", now);
      }
      if (domainEnabled) authenticateSignalDomain(db, signal.domain, now);
      return { accepted: true, receipt: null };
    }
    const domainEnabled = isSignalDomainEnabled(db, signal.domain);
    if (domainEnabled)
      markCollectionStarted(db, signal.domain, signal.observedAt);
    const { fingerprint, ...unsigned } = signal;
    if (eventFingerprint(unsigned) !== fingerprint) {
      if (domainEnabled)
        setDomainState(
          db,
          signal.domain,
          "degraded",
          "SIGNAL_FINGERPRINT_INVALID",
          now,
        );
      return { accepted: false, receipt: null };
    }
    const byId = db
      .prepare(
        "SELECT fingerprint, committed_at FROM analytics_event_receipt WHERE event_id=?",
      )
      .get(signal.eventId) as
      { fingerprint: string; committed_at: number } | undefined;
    if (byId)
      return byId.fingerprint === fingerprint
        ? {
            accepted: true,
            receipt: {
              eventId: signal.eventId,
              fingerprint,
              committedAt: byId.committed_at,
            },
          }
        : (domainEnabled &&
            setDomainState(
              db,
              signal.domain,
              "degraded",
              "SIGNAL_RECEIPT_CONFLICT",
              now,
            ),
          { accepted: false, receipt: null });
    const bySequence = db
      .prepare(
        "SELECT event_id, fingerprint, subject_identity FROM analytics_event_receipt WHERE producer_namespace=? AND producer_id=? AND producer_generation=? AND sequence=?",
      )
      .get(
        signal.producerNamespace,
        signal.producerId,
        signal.producerGeneration,
        signal.sequence,
      ) as
      | { event_id: string; fingerprint: string; subject_identity: string }
      | undefined;
    if (bySequence)
      return bySequence.fingerprint === fingerprint &&
        bySequence.subject_identity === signal.subjectIdentity
        ? {
            accepted: true,
            receipt: {
              eventId: bySequence.event_id,
              fingerprint,
              committedAt: now,
            },
          }
        : (domainEnabled &&
            setDomainState(
              db,
              signal.domain,
              "degraded",
              "SIGNAL_SEQUENCE_CONFLICT",
              now,
            ),
          { accepted: false, receipt: null });
    const generationMode = ensureEventGeneration(db, signal);
    if (!generationMode) return { accepted: false, receipt: null };
    // Receipts remain durable while disabled so re-enable never creates a sequence hole.
    if (domainEnabled) applyFact(db, signal, now);
    db.prepare(
      `INSERT INTO analytics_event_receipt (event_id, producer_namespace, producer_id, producer_generation, sequence, payload_version, event_type, subject_identity, fingerprint, received_at, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      signal.eventId,
      signal.producerNamespace,
      signal.producerId,
      signal.producerGeneration,
      signal.sequence,
      signal.payloadVersion,
      signal.eventType,
      signal.subjectIdentity,
      fingerprint,
      now,
      now,
    );
    if (generationMode === "active") {
      db.prepare(
        `UPDATE analytics_producer_generation SET committed_sequence=MAX(committed_sequence, ?), max_observed_at=CASE WHEN max_observed_at IS NULL THEN ? ELSE MAX(max_observed_at, ?) END, last_control_received_at=MAX(last_control_received_at, ?) WHERE domain=? AND producer_namespace=? AND producer_id=? AND producer_generation=?`,
      ).run(
        signal.sequence,
        signal.observedAt,
        signal.observedAt,
        now,
        signal.domain,
        signal.producerNamespace,
        signal.producerId,
        signal.producerGeneration,
      );
    }
    if (
      domainEnabled &&
      signal.producerNamespace === "worker_observer" &&
      (signal.eventType === "worker_unexpected_exit" ||
        signal.eventType === "worker_controlled_stop")
    ) {
      const payload = signal.payload as Record<string, unknown>;
      const targets = (
        Array.isArray(payload.targets) ? payload.targets : []
      ).filter(
        (target): target is LifecycleTarget =>
          Boolean(target) &&
          typeof target === "object" &&
          (["execution", "model", "worker"] as string[]).includes(
            String((target as Record<string, unknown>).domain),
          ) &&
          (["agent_worker", "worker_observer"] as string[]).includes(
            String((target as Record<string, unknown>).producerNamespace),
          ) &&
          typeof (target as Record<string, unknown>).producerId === "string" &&
          typeof (target as Record<string, unknown>).producerGeneration ===
            "string",
      );
      if (payload.targetIdentityQuality === "exact")
        abandonLifecycleTargets(db, targets, now);
      else recordUnknownExitGap(db, signal, now);
      if (
        signal.eventType === "worker_unexpected_exit" &&
        payload.targetIdentityQuality === "exact"
      ) {
        inferInterruptedRuns(db, targets, now);
        inferExecutionEndsFromWorkerExit(db, targets, Number(payload.occurredAt), now);
      }
    }
    if (generationMode === "active" && domainEnabled)
      authenticateSignalDomain(db, signal.domain, now);
    return {
      accepted: true,
      receipt: { eventId: signal.eventId, fingerprint, committedAt: now },
    };
  })();
}

/** Marks only non-terminal generations stale. A later checkpoint may recover the same generation. */
export function markStaleGenerations(
  db: AnalyticsDb,
  now = Date.now(),
  maxAgeMs = 15_000,
) {
  const cutoff = Math.max(0, now - maxAgeMs);
  return db.transaction(() => {
    const enabledDomains = [...readCurrentEnabledFactDomains(db)].filter(
      (domain): domain is Domain => SIGNAL_DOMAINS.has(domain),
    );
    if (enabledDomains.length === 0) return 0;
    const placeholders = enabledDomains.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT g.domain FROM analytics_producer_generation g JOIN analytics_producer_slot s ON s.domain=g.domain AND s.producer_namespace=g.producer_namespace AND s.producer_id=g.producer_id WHERE s.expected_enabled=1 AND g.domain IN (${placeholders}) AND g.lifecycle IN ('registered','closing','stale') AND g.last_control_received_at < ?`,
      )
      .all(...enabledDomains, cutoff) as Array<{ domain: Domain }>;
    db.prepare(
      `UPDATE analytics_producer_generation SET lifecycle='stale' WHERE lifecycle IN ('registered','closing','stale') AND last_control_received_at < ? AND domain IN (${placeholders}) AND EXISTS (SELECT 1 FROM analytics_producer_slot s WHERE s.expected_enabled=1 AND s.domain=analytics_producer_generation.domain AND s.producer_namespace=analytics_producer_generation.producer_namespace AND s.producer_id=analytics_producer_generation.producer_id)`,
    ).run(cutoff, ...enabledDomains);
    for (const row of rows) {
      setDomainState(db, row.domain, "stale", "SIGNAL_STALE", now);
      if (row.domain === "execution") mirrorExecutionState(db);
    }
    return rows.length;
  })();
}

export type UnsignedAnalyticsSignalEvent = AnalyticsSignalEvent extends infer T
  ? T extends AnalyticsSignalEvent
    ? Omit<T, "fingerprint">
    : never
  : never;
export function analyticsFingerprint(signal: UnsignedAnalyticsSignalEvent) {
  return eventFingerprint(signal);
}
