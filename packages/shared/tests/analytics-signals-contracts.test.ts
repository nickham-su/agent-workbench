import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AnalyticsControlSignalSchema, AnalyticsSignalEventSchema, AnalyticsSignalSchema, isCanonicalAnalyticsSignal } from "../src/contracts/analytics-signals.js";

const fingerprint = "a".repeat(64);
const executionStarted = {
  kind: "event", domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: "g1",
  sequence: 1, eventId: "e1", payloadVersion: 1, eventType: "execution_started", subjectIdentity: "execution:r1", fingerprint, observedAt: 1,
  payload: { executionId: "execution:r1", runId: "r1", runtimeKind: "agent_worker", runKind: "user", parentRunId: null, queuedAt: null, startedAt: 1, endedAt: null, endTimeQuality: "unknown", endReason: null }
};

test("analytics signal contracts are closed and strictly discriminate event stages", () => {
  assert.equal(Value.Check(AnalyticsSignalEventSchema, executionStarted), true);
  assert.equal(Value.Check(AnalyticsSignalEventSchema, { ...executionStarted, payload: { ...executionStarted.payload, prompt: "secret" } }), false);
  assert.equal(Value.Check(AnalyticsSignalEventSchema, { ...executionStarted, rawError: "stack" }), false);
  assert.equal(Value.Check(AnalyticsSignalEventSchema, { ...executionStarted, sequence: 0 }), false);
  assert.equal(Value.Check(AnalyticsSignalEventSchema, { ...executionStarted, eventType: "execution_finished" }), false);
  const worker = { ...executionStarted, domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", eventType: "worker_restart_attempted", payload: { occurredAt: 1, event: "restart_failed", restartAttemptId: "attempt-1", runnerMode: "agent_worker" } };
  assert.equal(Value.Check(AnalyticsSignalEventSchema, worker), false);
  assert.equal(Value.Check(AnalyticsSignalEventSchema, { ...executionStarted, payload: { runId: "r1", runKind: "user", parentRunId: null, startedAt: 1, endedAt: null, state: "running" } }), false);
});

test("checkpoint/control signals retain only coherent bounded completeness fields", () => {
  const valid = { kind: "checkpoint", domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: "g1", sentAt: 1, controlSequence: 1, finalSequence: null, committedSequence: 0, maxObservedAt: null, earliestOpenStartedAt: null, openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0 };
  assert.equal(Value.Check(AnalyticsControlSignalSchema, valid), true);
  assert.equal(isCanonicalAnalyticsSignal({ ...valid, knownDrop: false, droppedSinceSequence: 1 }), false);
  assert.equal(isCanonicalAnalyticsSignal({ ...valid, outboxPending: 0, oldestPendingAt: 1 }), false);
  assert.equal(isCanonicalAnalyticsSignal({ ...valid, openExecutionCount: 0, earliestOpenStartedAt: 1 }), false);
  assert.equal(Value.Check(AnalyticsControlSignalSchema, { ...valid, kind: "abandoned" }), false);
  assert.equal(Value.Check(AnalyticsSignalSchema, { ...valid, error: "provider raw error" }), false);
});

test("expected slot configuration is an atomic closed replacement document", () => {
  const config = { kind: "expected_slots_config", sentAt: 1, effectiveAt: 1,
    sourceConfigVersion: 1, enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker"],
    requestId: "slot-request-1", slots: [
    { domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager" },
    { domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner" },
    { domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner" }
  ] };
  assert.equal(Value.Check(AnalyticsControlSignalSchema, config), true);
  assert.equal(Value.Check(AnalyticsControlSignalSchema, { ...config, enabledFactDomains: [...config.enabledFactDomains, "git"] }), false);
  assert.equal(Value.Check(AnalyticsControlSignalSchema, { ...config, slots: [...config.slots, { domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager" }] }), false);
});
