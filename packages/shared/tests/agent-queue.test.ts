import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AGENT_QUEUE_MAX_PENDING_COUNT, AGENT_QUEUE_MAX_PENDING_BYTES, AGENT_QUEUE_MAX_TEXT_BYTES,
  AGENT_QUEUE_MAX_INJECT_BATCH, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES,
  AgentAcceptUserMessageRequestSchema, AgentAcceptUserMessageResponseSchema,
  AgentAcceptUserMessageMultipartPayloadSchema, AgentAbandonUnconfirmedInputRequestSchema,
  AgentInputReceiptMetadataSchema, AgentMessageQueueSnapshotSchema, AgentResumeMessageQueueResponseSchema, AgentStopMessageQueueRequestSchema,
  AgentUserMessageReceiptSchema, AgentSendMessageResponseSchema
} from "../src/index.js";
import {
  AgentWorkerStopRunsRequestSchema, AgentWorkerStopRunsResponseSchema,
  AgentWorkerRuntimeIdentityResponseSchema, AgentWorkerEnqueueRequestSchema
} from "../src/internal-contracts/agent-worker.js";
import {
  AgentApiCreateStreamingAssistantRequestSchema, AgentApiResumeStreamingAssistantRequestSchema,
  AgentApiReplaceStreamingAssistantRequestSchema
} from "../src/internal-contracts/agent-api-message.js";

import { AgentApiCheckRuntimeAdmissionRequestSchema, AgentApiInjectInteractiveInputRequestSchema, AgentApiPrepareInteractiveInputResponseSchema } from "../src/internal-contracts/agent-api-queue.js";
import { AgentWorkerEndpoints } from "../src/internal-contracts/endpoints.js";
import { AgentApiEndpoints } from "../src/internal-contracts/agent-api.js";

const hash = "a".repeat(64);
const runtime = "00000000-0000-4000-8000-000000000001";
const receipt = { id: "receipt", clientRequestId: "request", sequence: 1, status: "queued", messageId: null, runId: null, confirmationState: null, confirmationSource: null, createdAt: 1, updatedAt: 1 };
const queue = { workspaceId: "w", sessionId: "s", queueVersion: 1, stopGeneration: "0".repeat(64), pendingCount: 1, pendingBytes: 5, pendingIdentity: { agentId: "a", providerId: "p", modelId: "m" },
  unconfirmedInputCount: 0, unconfirmedInputSetHash: null, recoveryIdentity: null,
  stop: { state: "none", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null },
  items: [{ ...receipt, textPreview: "hello", attachmentCount: 0 }] };

test("queue policy constants have one public authority", () => {
  assert.deepEqual([AGENT_QUEUE_MAX_PENDING_COUNT, AGENT_QUEUE_MAX_PENDING_BYTES, AGENT_QUEUE_MAX_TEXT_BYTES, AGENT_QUEUE_MAX_INJECT_BATCH, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES], [100, 64 * 1024 * 1024, 64 * 1024, 8, 1024 * 1024 * 1024]);
});

test("new receipt success has no invented run while the legacy response remains strict", () => {
  assert.equal(Value.Check(AgentAcceptUserMessageResponseSchema, { receipt, deduplicated: false, queue }), true);
  assert.equal(Value.Check(AgentSendMessageResponseSchema, { sessionId: "s", messageId: null, runId: null, deduplicated: false }), false);
  assert.equal(Value.Check(AgentSendMessageResponseSchema, { sessionId: "s", messageId: "m", runId: "r", deduplicated: false }), true);
  assert.equal(Value.Check(AgentUserMessageReceiptSchema, { ...receipt, status: "injected" }), false);
  const injected = { ...receipt, status: "injected", messageId: "m", runId: "r", confirmationState: "unconfirmed" };
  assert.equal(Value.Check(AgentUserMessageReceiptSchema, injected), true);
  assert.equal(Value.Check(AgentUserMessageReceiptSchema, { ...injected, confirmationState: "confirmed" }), false);
  assert.equal(Value.Check(AgentUserMessageReceiptSchema, { ...injected, confirmationState: "confirmed", confirmationSource: "worker_model" }), true);
  assert.equal(Value.Check(AgentUserMessageReceiptSchema, { ...injected, confirmationState: "abandoned", confirmationSource: "worker_model" }), false);
});

test("public acceptance, Stop and Abandon reject extra fields without mutating the request", () => {
  const request = { workspaceId: "w", clientRequestId: "q", text: "hello" };
  assert.equal(Value.Check(AgentAcceptUserMessageRequestSchema, request), true);
  assert.equal(Value.Check(AgentAcceptUserMessageMultipartPayloadSchema, { workspaceId: "w", clientRequestId: "q" }), true);
  assert.equal(Value.Check(AgentAcceptUserMessageRequestSchema, { ...request, text: "" }), false);
  const stop = { workspaceId: "w", operationId: "stop" };
  assert.equal(Value.Check(AgentStopMessageQueueRequestSchema, stop), true);
  assert.equal(Value.Check(AgentStopMessageQueueRequestSchema, { ...stop, expectedQueueVersion: 1 }), false);
  const abandon = { ...stop, expectedQueueVersion: 1, expectedUnconfirmedInputSetHash: hash, confirmIrreversible: true };
  assert.equal(Value.Check(AgentAbandonUnconfirmedInputRequestSchema, abandon), true);
  for (const invalid of [{ ...abandon, receiptIds: ["receipt"] }, { ...abandon, confirmIrreversible: false }, { ...abandon, expectedQueueVersion: 1.5 }, { ...abandon, expectedQueueVersion: Number.MAX_SAFE_INTEGER + 1 }, { ...abandon, expectedUnconfirmedInputSetHash: hash.toUpperCase() }])
    assert.equal(Value.Check(AgentAbandonUnconfirmedInputRequestSchema, invalid), false);
  assert.equal(Value.Check(AgentAcceptUserMessageRequestSchema, { ...request, confirmationSource: "worker_model" }), false);
  assert.deepEqual(request, { workspaceId: "w", clientRequestId: "q", text: "hello" });
});

test("queue snapshot and resume action prohibit impossible primitive shapes", () => {
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, queue), true);
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, { ...queue, queueVersion: 0.5 }), false);
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, { ...queue, pendingCount: 101 }), false);
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, { ...queue, items: [{ ...queue.items[0], status: "injected" }] }), false);
  assert.equal(Value.Check(AgentResumeMessageQueueResponseSchema, { action: "continued_unconfirmed", runId: null, queue }), false);
  assert.equal(Value.Check(AgentResumeMessageQueueResponseSchema, { action: "continued_unconfirmed", runId: "r", queue }), true);
});

const stop = { workspaceId: "w", rootSessionId: "s", operationId: "stop", runtimeInstanceId: runtime, targetsHash: hash,
  targets: [{ sessionId: "s", runId: "r" }], timeoutMs: 1_000 };
test("precise runtime stop identifies the incarnation and refuses duplicate targets", () => {
  assert.equal(Value.Check(AgentWorkerStopRunsRequestSchema, stop), true);
  for (const invalid of [{ ...stop, targets: [] }, { ...stop, targets: [stop.targets[0], stop.targets[0]] }, { ...stop, runtimeInstanceId: "analytics-generation" }, { ...stop, timeoutMs: 10_001 }, { ...stop, timeoutMs: 0 }, { ...stop, expectedQueueVersion: 1 }])
    assert.equal(Value.Check(AgentWorkerStopRunsRequestSchema, invalid), false);
  const { targets: _targets, timeoutMs: _timeout, ...scope } = stop;
  assert.equal(Value.Check(AgentWorkerStopRunsResponseSchema, { ...scope, state: "quiescent", proofId: "proof", code: null }), true);
  assert.equal(Value.Check(AgentWorkerStopRunsResponseSchema, { ...scope, state: "quiescent", proofId: null, code: null }), false);
  assert.equal(Value.Check(AgentWorkerStopRunsResponseSchema, { ...scope, state: "unknown", proofId: null, code: "transport_timeout" }), true);
  assert.equal(Value.Check(AgentWorkerRuntimeIdentityResponseSchema, { runtimeInstanceId: runtime, stopProtocolVersion: "agent-stop-runs-v1" }), true);
  assert.equal(Value.Check(AgentWorkerRuntimeIdentityResponseSchema, { runtimeInstanceId: runtime, stopProtocolVersion: "unsupported" }), false);
  assert.equal(Value.Check(AgentApiCheckRuntimeAdmissionRequestSchema, { workspaceId: "w", sessionId: "s", runId: "r", runtimeInstanceId: runtime }), true);
});

test("legacy assistant and enqueue requests remain compatible while interactive metadata is strict", () => {
  const scope = { workspaceId: "w", sessionId: "s", runId: "r" };
  const inputBinding = { inputReceiptIds: ["receipt"], effectiveInputPolicyVersion: "agent-effective-input-v1", snapshotHash: hash, inputRevision: 3 };
  const create = { ...scope, messageId: "m", createdAt: 1 };
  const resume = { ...scope, messageId: "m" };
  const replace = { ...scope, oldMessageId: "old", newMessageId: "new", runNoticeText: "", retryCount: 0, nextRetryAt: null, createdAt: 1 };
  for (const [schema, request] of [
    [AgentApiCreateStreamingAssistantRequestSchema, create],
    [AgentApiResumeStreamingAssistantRequestSchema, resume],
  ] as const) {
    assert.equal(Value.Check(schema, request), true);
    assert.equal(Value.Check(schema, { ...request, inputBinding }), true);
    assert.equal(Value.Check(schema, { ...request, inputBinding: { ...inputBinding, inputReceiptIds: ["q", "q"] } }), false);
    assert.equal(Value.Check(schema, { ...request, inputBinding: { ...inputBinding, snapshotHash: "unknown" } }), false);
    assert.equal(Value.Check(schema, { ...request, inputBinding: { ...inputBinding, confirmationSource: "worker_model" } }), false);
  }
  assert.equal(Value.Check(AgentApiReplaceStreamingAssistantRequestSchema, replace), true);
  for (const mode of ["retry_same_input", "recovery_reprepare"]) {
    assert.equal(Value.Check(AgentApiReplaceStreamingAssistantRequestSchema, { ...replace, inputBinding: { ...inputBinding, mode } }), true);
  }
  assert.equal(Value.Check(AgentApiReplaceStreamingAssistantRequestSchema, { ...replace, inputBinding }), false);
  assert.equal(Value.Check(AgentApiReplaceStreamingAssistantRequestSchema, { ...replace, inputBinding: { ...inputBinding, mode: "silent_rebind" } }), false);
  const enqueue = { ...scope, workspacePath: "/fixture/workspace" };
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, enqueue), true);
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, { ...enqueue, runtimeInstanceId: runtime }), true);
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, { ...enqueue, runtimeInstanceId: "pid-42" }), false);
});

test("inject is a bounded metadata-only request and new endpoints do not replace old contracts", () => {
  const request = { workspaceId: "w", sessionId: "s", runId: "r", operationId: "inject", expectedHeadMessageId: null,
    expectedRevision: 0, receiptIds: ["q"], preparationSnapshotHash: hash, estimatorVersion: "queue-input-estimator-v1" };
  assert.equal(Value.Check(AgentApiInjectInteractiveInputRequestSchema, request), true);
  assert.equal(Value.Check(AgentApiInjectInteractiveInputRequestSchema, { ...request, text: "untrusted replacement" }), false);
  assert.equal(Value.Check(AgentApiInjectInteractiveInputRequestSchema, { ...request, receiptIds: Array.from({ length: 9 }, (_, i) => `${i}`) }), false);
  assert.equal(AgentWorkerEndpoints.cancelSession.path, "/internal/runs/cancel-session");
  assert.equal(AgentWorkerEndpoints.stopRunsAndWait.path, "/internal/agent-worker/stop-runs-and-wait");
  assert.equal(AgentApiEndpoints.checkRuntimeAdmission.path, "/api/internal/agent/runs/runtime-admission");
});


test("timeline input receipt metadata preserves confirmation state/source without granting write authority", () => {
  for (const confirmationSource of ["worker_model", "local_fallback"]) {
    assert.equal(Value.Check(AgentInputReceiptMetadataSchema, { receiptId: "r", confirmationState: "confirmed", confirmationSource }), true);
  }
  for (const confirmationState of ["unconfirmed", "abandoned"]) {
    assert.equal(Value.Check(AgentInputReceiptMetadataSchema, { receiptId: "r", confirmationState, confirmationSource: null }), true);
    assert.equal(Value.Check(AgentInputReceiptMetadataSchema, { receiptId: "r", confirmationState, confirmationSource: "worker_model" }), false);
  }
  assert.equal(Value.Check(AgentInputReceiptMetadataSchema, { receiptId: "r", confirmationState: "confirmed", confirmationSource: null }), false);
  assert.equal(Value.Check(AgentAcceptUserMessageRequestSchema, { workspaceId: "w", clientRequestId: "request", text: "x", inputReceipt: { receiptId: "r", confirmationState: "confirmed", confirmationSource: "worker_model" } }), false);
});
test("prepare rejected is a strict authoritative decision with no frozen body", () => {
  for (const reason of ["snapshot_too_large", "cache_capacity"]) {
    const result = { operationId: "op", decision: "rejected", reason, queue };
    assert.equal(Value.Check(AgentApiPrepareInteractiveInputResponseSchema, result), true);
    for (const extra of [{ context: {} }, { candidates: [] }, { reason: "unknown" }, { reason: undefined }]) {
      assert.equal(Value.Check(AgentApiPrepareInteractiveInputResponseSchema, { ...result, ...extra }), false);
    }
  }
  assert.equal(Value.Check(AgentApiPrepareInteractiveInputResponseSchema, { operationId: "op", decision: "finish", reason: "cache_capacity", queue }), false);
});

test("Esc clear contract fixes unique receipt targets; generation is valid send metadata", async () => {
  const { AgentClearMessageQueueRequestSchema, AgentClearMessageQueueResponseSchema, AgentQueueErrorCodeSchema } = await import("../src/index.js");
  assert.equal(Value.Check(AgentClearMessageQueueRequestSchema, { workspaceId: "w", receiptIds: [] }), true);
  assert.equal(Value.Check(AgentClearMessageQueueRequestSchema, { workspaceId: "w", receiptIds: ["a", "b"] }), true);
  for (const receiptIds of [["a", "a"], [""], Array.from({ length: 101 }, (_, i) => String(i))])
    assert.equal(Value.Check(AgentClearMessageQueueRequestSchema, { workspaceId: "w", receiptIds }), false);
  assert.equal(Value.Check(AgentClearMessageQueueRequestSchema, { workspaceId: "w", receiptIds: [], operationId: "extra" }), false);
  assert.equal(Value.Check(AgentClearMessageQueueResponseSchema, { cancelledCount: 0, queue }), true);
  assert.equal(Value.Check(AgentAcceptUserMessageRequestSchema, { workspaceId: "w", clientRequestId: "r", text: "hello", stopGeneration: "a".repeat(64) }), true);
  assert.equal(Value.Check(AgentAcceptUserMessageRequestSchema, { workspaceId: "w", clientRequestId: "r", text: "hello", stopGeneration: "old" }), false);
  assert.equal(Value.Check(AgentQueueErrorCodeSchema, "AGENT_QUEUE_STOP_GENERATION_CHANGED"), true);
});

test("fresh Session Stop generation is the canonical empty Stop identity hash", async () => {
  const { createHash } = await import("node:crypto");
  const { AGENT_QUEUE_INITIAL_STOP_GENERATION } = await import("../src/index.js");
  assert.equal(AGENT_QUEUE_INITIAL_STOP_GENERATION, createHash("sha256").update(JSON.stringify([])).digest("hex"));
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, { ...queue, stopGeneration: AGENT_QUEUE_INITIAL_STOP_GENERATION }), true);
});


test("supplements bind a nonempty target Run; snapshots reject removed pause state", () => {
  const request = { workspaceId: "w", clientRequestId: "extra", text: "extra" };
  for (const schema of [AgentAcceptUserMessageRequestSchema, AgentAcceptUserMessageMultipartPayloadSchema]) {
    for (const targetRunId of [null, "target-run"]) assert.equal(Value.Check(schema, { ...request, targetRunId }), true);
    for (const targetRunId of ["", 1, {}]) assert.equal(Value.Check(schema, { ...request, targetRunId }), false);
  }
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, { ...queue, mode: "active" }), false);
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, { ...queue, pauseCode: null }), false);
});
