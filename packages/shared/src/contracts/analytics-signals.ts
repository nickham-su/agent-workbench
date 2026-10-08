import {
  Type,
  type Static,
  type TProperties,
  type TSchema,
} from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Strict = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const SafeId = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9._:-]+$",
});
const SafeLabel = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001f\\u007f]{1,256}$",
});
const Timestamp = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const Sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** Strictly monotonic per producer generation and domain; unlike sentAt it is never ambiguous within one millisecond. */
const ControlSequence = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const nullableTimestamp = Nullable(Timestamp);
const lifecycle = Type.Union([
  Type.Literal("registered"),
  Type.Literal("closing"),
  Type.Literal("closed"),
  Type.Literal("stale"),
  Type.Literal("abandoned"),
]);

export const AnalyticsProducerNamespaceSchema = Type.Union([
  Type.Literal("agent_worker"),
  Type.Literal("api_local_fallback"),
  Type.Literal("worker_observer"),
]);
export type AnalyticsProducerNamespace = Static<
  typeof AnalyticsProducerNamespaceSchema
>;
export const AnalyticsSignalDomainSchema = Type.Union([
  Type.Literal("execution"),
  Type.Literal("model"),
  Type.Literal("worker"),
]);
export type AnalyticsSignalDomain = Static<typeof AnalyticsSignalDomainSchema>;
export const AnalyticsGenerationLifecycleSchema = lifecycle;
export type AnalyticsGenerationLifecycle = Static<
  typeof AnalyticsGenerationLifecycleSchema
>;
export const AnalyticsSignalEventTypeSchema = Type.Union([
  Type.Literal("execution_started"),
  Type.Literal("execution_finished"),
  Type.Literal("model_invoked"),
  Type.Literal("model_finished"),
  Type.Literal("worker_ready"),
  Type.Literal("worker_snapshot"),
  Type.Literal("worker_restart_attempted"),
  Type.Literal("worker_restart_succeeded"),
  Type.Literal("worker_restart_failed"),
  Type.Literal("worker_unexpected_exit"),
  Type.Literal("worker_controlled_stop"),
]);
export type AnalyticsSignalEventType = Static<
  typeof AnalyticsSignalEventTypeSchema
>;

const eventBase = {
  kind: Type.Literal("event"),
  producerNamespace: AnalyticsProducerNamespaceSchema,
  producerId: SafeId,
  producerGeneration: SafeId,
  sequence: Sequence,
  eventId: SafeId,
  payloadVersion: Type.Literal(1),
  subjectIdentity: SafeId,
  fingerprint: Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: "^[a-f0-9]{64}$",
  }),
  observedAt: Timestamp,
};
const executionBase = {
  executionId: SafeId,
  runId: SafeId,
  runtimeKind: SafeId,
  runKind: SafeId,
  parentRunId: Nullable(SafeId),
  queuedAt: nullableTimestamp,
  startedAt: Timestamp,
};
const executionStartedPayload = Strict({
  ...executionBase,
  endedAt: Type.Null(),
  endTimeQuality: Type.Literal("unknown"),
  endReason: Type.Null(),
});
const executionFinishedPayload = Strict({
  ...executionBase,
  endedAt: Timestamp,
  endTimeQuality: Type.Literal("observed"),
  endReason: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("timed_out"),
    Type.Literal("other"),
  ]),
});
const modelBase = {
  modelCallId: SafeId,
  executionId: SafeId,
  runId: SafeId,
  attemptNo: Sequence,
  providerId: SafeLabel,
  modelId: SafeLabel,
  startedAt: Timestamp,
  inputTokens: Nullable(Count),
  outputTokens: Nullable(Count),
  totalTokens: Nullable(Count),
  totalSource: Type.Union([
    Type.Literal("reported"),
    Type.Literal("derived"),
    Type.Literal("unavailable"),
  ]),
  cacheReadTokens: Nullable(Count),
  /** Optional for durable signals produced before cache denominator support. */
  cacheInputTokens: Type.Optional(Nullable(Count)),
  cacheWriteTokens: Nullable(Count),
  cacheComparable: Type.Boolean(),
  cacheWriteVerified: Type.Boolean(),
};
const modelInvokedPayload = Strict({
  ...modelBase,
  endedAt: Type.Null(),
  status: Type.Literal("running"),
  completionQuality: Type.Literal("unknown"),
  timeoutKind: Type.Null(),
  failureKind: Type.Null(),
});
const modelFinishedPayload = Strict({
  ...modelBase,
  endedAt: Timestamp,
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("timed_out"),
    Type.Literal("cancelled"),
    Type.Literal("other"),
  ]),
  completionQuality: Type.Literal("observed"),
  timeoutKind: Nullable(
    Type.Union([Type.Literal("idle"), Type.Literal("total")]),
  ),
  failureKind: Nullable(
    Type.Union([
      Type.Literal("provider"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
      Type.Literal("other"),
    ]),
  ),
});
const WorkerLifecycleTargetSchema = Strict({
  domain: AnalyticsSignalDomainSchema,
  producerNamespace: AnalyticsProducerNamespaceSchema,
  producerId: SafeId,
  producerGeneration: SafeId,
});
/** Exit evidence is bound to the producer generations observed when the process exited.
 * `unknown` deliberately prevents the child from guessing or abandoning a replacement. */
const workerEvent = (
  event:
    | "ready"
    | "restart_attempted"
    | "restart_succeeded"
    | "restart_failed"
    | "unexpected_exit"
    | "controlled_stop",
  restart: boolean,
) =>
  Strict({
    occurredAt: Timestamp,
    event: Type.Literal(event),
    restartAttemptId: restart ? SafeId : Type.Null(),
    runnerMode: Type.Literal("agent_worker"),
    targetIdentityQuality: Type.Union([
      Type.Literal("exact"),
      Type.Literal("unknown"),
    ]),
    targets: Type.Array(WorkerLifecycleTargetSchema, { maxItems: 3 }),
  });
const snapshotPayload = Strict({
  snapshotAt: Timestamp,
  activeCount: Count,
  queueLength: Count,
  concurrency: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  lastReadyAt: nullableTimestamp,
  runnerMode: Type.Literal("agent_worker"),
});
const event = <D extends TSchema, E extends TSchema, P extends TSchema>(
  domain: D,
  eventType: E,
  payload: P,
) => Strict({ ...eventBase, domain, eventType, payload });
export const AnalyticsSignalEventSchema = Type.Union([
  event(
    Type.Literal("execution"),
    Type.Literal("execution_started"),
    executionStartedPayload,
  ),
  event(
    Type.Literal("execution"),
    Type.Literal("execution_finished"),
    executionFinishedPayload,
  ),
  event(
    Type.Literal("model"),
    Type.Literal("model_invoked"),
    modelInvokedPayload,
  ),
  event(
    Type.Literal("model"),
    Type.Literal("model_finished"),
    modelFinishedPayload,
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_ready"),
    workerEvent("ready", false),
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_restart_attempted"),
    workerEvent("restart_attempted", true),
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_restart_succeeded"),
    workerEvent("restart_succeeded", true),
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_restart_failed"),
    workerEvent("restart_failed", true),
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_unexpected_exit"),
    workerEvent("unexpected_exit", false),
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_controlled_stop"),
    workerEvent("controlled_stop", false),
  ),
  event(
    Type.Literal("worker"),
    Type.Literal("worker_snapshot"),
    snapshotPayload,
  ),
]);
export type AnalyticsSignalEvent = Static<typeof AnalyticsSignalEventSchema>;

const controlBase = {
  domain: AnalyticsSignalDomainSchema,
  producerNamespace: AnalyticsProducerNamespaceSchema,
  producerId: SafeId,
  producerGeneration: SafeId,
  sentAt: Timestamp,
  controlSequence: ControlSequence,
};
const controlState = Type.Union([
  Strict({
    ...controlBase,
    kind: Type.Union([
      Type.Literal("register"),
      Type.Literal("closing"),
      Type.Literal("closed"),
      Type.Literal("checkpoint"),
    ]),
    finalSequence: Nullable(Count),
    committedSequence: Count,
    maxObservedAt: nullableTimestamp,
    earliestOpenStartedAt: Type.Null(),
    openExecutionCount: Type.Literal(0),
    openModelCount: Type.Literal(0),
    knownDrop: Type.Literal(false),
    droppedSinceSequence: Type.Null(),
    outboxPending: Type.Literal(0),
    oldestPendingAt: Type.Null(),
    lossEpoch: Count,
  }),
  Strict({
    ...controlBase,
    kind: Type.Union([
      Type.Literal("register"),
      Type.Literal("closing"),
      Type.Literal("checkpoint"),
    ]),
    finalSequence: Type.Null(),
    committedSequence: Count,
    maxObservedAt: nullableTimestamp,
    earliestOpenStartedAt: Timestamp,
    openExecutionCount: Count,
    openModelCount: Count,
    knownDrop: Type.Literal(false),
    droppedSinceSequence: Type.Null(),
    outboxPending: Type.Literal(0),
    oldestPendingAt: Type.Null(),
    lossEpoch: Count,
  }),
  Strict({
    ...controlBase,
    kind: Type.Union([
      Type.Literal("register"),
      Type.Literal("closing"),
      Type.Literal("checkpoint"),
    ]),
    finalSequence: Type.Null(),
    committedSequence: Count,
    maxObservedAt: nullableTimestamp,
    earliestOpenStartedAt: nullableTimestamp,
    openExecutionCount: Count,
    openModelCount: Count,
    knownDrop: Type.Literal(true),
    droppedSinceSequence: Sequence,
    outboxPending: Count,
    oldestPendingAt: nullableTimestamp,
    lossEpoch: Count,
  }),
  Strict({
    ...controlBase,
    kind: Type.Union([
      Type.Literal("register"),
      Type.Literal("closing"),
      Type.Literal("checkpoint"),
    ]),
    finalSequence: Type.Null(),
    committedSequence: Count,
    maxObservedAt: nullableTimestamp,
    earliestOpenStartedAt: nullableTimestamp,
    openExecutionCount: Count,
    openModelCount: Count,
    knownDrop: Type.Literal(false),
    droppedSinceSequence: Type.Null(),
    outboxPending: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    oldestPendingAt: Timestamp,
    lossEpoch: Count,
  }),
]);
const ExpectedWorkerSlotSchema = Type.Tuple([
  Strict({
    domain: Type.Literal("worker"),
    producerNamespace: Type.Literal("worker_observer"),
    producerId: Type.Literal("process_manager"),
  }),
  Strict({
    domain: Type.Literal("execution"),
    producerNamespace: Type.Literal("agent_worker"),
    producerId: Type.Literal("agent_runner"),
  }),
  Strict({
    domain: Type.Literal("model"),
    producerNamespace: Type.Literal("agent_worker"),
    producerId: Type.Literal("agent_runner"),
  }),
]);
const ExpectedLocalSlotSchema = Type.Tuple([
  Strict({
    domain: Type.Literal("execution"),
    producerNamespace: Type.Literal("api_local_fallback"),
    producerId: Type.Literal("api_local_fallback"),
  }),
  Strict({
    domain: Type.Literal("model"),
    producerNamespace: Type.Literal("api_local_fallback"),
    producerId: Type.Literal("api_local_fallback"),
  }),
]);
const FactDomainSchema = Type.Union([
  Type.Literal("run"),
  Type.Literal("session"),
  Type.Literal("message"),
  Type.Literal("tool"),
  Type.Literal("execution"),
  Type.Literal("model"),
  Type.Literal("worker"),
]);
const ExpectedSlotsConfigSchema = Strict({
  kind: Type.Literal("expected_slots_config"),
  /** Transport diagnostics only; ordering uses sourceConfigVersion. */
  sentAt: Timestamp,
  requestId: SafeId,
  sourceConfigVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  effectiveAt: Timestamp,
  enabledFactDomains: Type.Array(FactDomainSchema),
  slots: Type.Union([ExpectedWorkerSlotSchema, ExpectedLocalSlotSchema]),
});
export const AnalyticsControlSignalSchema = Type.Union([
  controlState,
  ExpectedSlotsConfigSchema,
]);
export type AnalyticsGenerationControlSignal = {
  kind: "register" | "closing" | "closed" | "checkpoint";
  domain: AnalyticsSignalDomain;
  producerNamespace: AnalyticsProducerNamespace;
  producerId: string;
  producerGeneration: string;
  sentAt: number;
  controlSequence: number;
  finalSequence: number | null;
  committedSequence: number;
  maxObservedAt: number | null;
  earliestOpenStartedAt: number | null;
  openExecutionCount: number;
  openModelCount: number;
  knownDrop: boolean;
  droppedSinceSequence: number | null;
  outboxPending: number;
  oldestPendingAt: number | null;
  lossEpoch: number;
};
export type AnalyticsExpectedSlotsConfigSignal = {
  kind: "expected_slots_config";
  sentAt: number;
  requestId: string;
  sourceConfigVersion: number;
  effectiveAt: number;
  enabledFactDomains: Array<
    | "run"
    | "session"
    | "message"
    | "tool"
    | "execution"
    | "model"
    | "worker"
  >;
  slots: Array<{
    domain: AnalyticsSignalDomain;
    producerNamespace: AnalyticsProducerNamespace;
    producerId: string;
  }>;
};
export type AnalyticsControlSignal =
  AnalyticsGenerationControlSignal | AnalyticsExpectedSlotsConfigSignal;
export const AnalyticsSignalSchema = Type.Union([
  AnalyticsSignalEventSchema,
  AnalyticsControlSignalSchema,
]);
/** Public producer transport excludes supervisor-owned expected-slot config. */
export const AnalyticsProducerSignalSchema = Type.Union([
  AnalyticsSignalEventSchema,
  controlState,
]);
export type AnalyticsProducerSignal =
  AnalyticsSignalEvent | AnalyticsGenerationControlSignal;
export type AnalyticsSignal = AnalyticsSignalEvent | AnalyticsControlSignal;
export const AnalyticsSignalResultSchema = Strict({
  accepted: Type.Boolean(),
  receipt: Nullable(
    Strict({
      eventId: SafeId,
      fingerprint: Type.String({
        minLength: 64,
        maxLength: 64,
        pattern: "^[a-f0-9]{64}$",
      }),
    }),
  ),
});
export type AnalyticsSignalResult = Static<typeof AnalyticsSignalResultSchema>;

/** Relational checks TypeBox JSON Schema cannot express itself. */
export function isCanonicalAnalyticsSignal(
  value: unknown,
): value is AnalyticsSignal {
  if (!Value.Check(AnalyticsSignalSchema, value)) return false;
  const signal = value as AnalyticsSignal;
  if (signal.kind === "event") {
    if (signal.domain !== "model") return true;
    const { cacheReadTokens: read, cacheInputTokens: input, cacheComparable: comparable } = signal.payload;
    // Historic outbox signals have no denominator. They are accepted, but
    // the store must never turn their old comparable bit into a new sample.
    if (input === undefined) return true;
    if (input !== null && (read === null || read > input)) return false;
    const valid = input !== null && read !== null && read <= input;
    return comparable === valid;
  }
  if (signal.kind === "expected_slots_config") {
    const actual = signal.slots
      .map(
        (slot) => `${slot.domain}:${slot.producerNamespace}:${slot.producerId}`,
      )
      .sort()
      .join(",");
    const worker = [
      "execution:agent_worker:agent_runner",
      "model:agent_worker:agent_runner",
      "worker:worker_observer:process_manager",
    ].join(",");
    const local = [
      "execution:api_local_fallback:api_local_fallback",
      "model:api_local_fallback:api_local_fallback",
    ].join(",");
    const domains = signal.enabledFactDomains;
    return (
      (actual === worker || actual === local) &&
      new Set(domains).size === domains.length
    );
  }
  const open = signal.openExecutionCount + signal.openModelCount;
  if ((open === 0) !== (signal.earliestOpenStartedAt === null)) return false;
  if (signal.knownDrop !== (signal.droppedSinceSequence !== null)) return false;
  if ((signal.outboxPending === 0) !== (signal.oldestPendingAt === null))
    return false;
  if (
    signal.finalSequence !== null &&
    signal.committedSequence > signal.finalSequence
  )
    return false;
  if (signal.kind === "closed" && signal.finalSequence === null) return false;
  if (
    (signal.kind === "register" || signal.kind === "checkpoint") &&
    signal.finalSequence !== null
  )
    return false;
  return true;
}
