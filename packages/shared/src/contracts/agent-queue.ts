import { Type, type Static } from "@sinclair/typebox";
import { AgentUiLocaleSchema } from "./agent.js";
import { AgentImageMediaTypeSchema } from "./agent-primitives.js";

/** Limits for the interactive Web inbox only; legacy force-trigger contracts are unchanged. */
export const AGENT_QUEUE_MAX_PENDING_COUNT = 100;
export const AGENT_QUEUE_MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const AGENT_QUEUE_MAX_TEXT_BYTES = 64 * 1024;
export const AGENT_QUEUE_MAX_INJECT_BATCH = 8;
export const AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES = 1024 * 1024 * 1024;
export const AGENT_QUEUE_INPUT_POLICY_VERSION = "agent-effective-input-v1";
export const AGENT_QUEUE_INPUT_ESTIMATOR_VERSION = "queue-input-estimator-v1";
/** SHA-256 of JSON.stringify([]); only fresh creation may assume this without a snapshot. */
export const AGENT_QUEUE_INITIAL_STOP_GENERATION =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export const AgentQueueIdSchema = Type.String({ minLength: 1 });
export const AgentQueueVersionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const AgentQueueHashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const nullableId = Type.Union([AgentQueueIdSchema, Type.Null()]);
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map(value => Type.Literal(value)));
const strict = { additionalProperties: false } as const;

export const AgentQueueStopDiagnosticCodeSchema = literals([
  "stop_requested", "runner_not_quiescent", "transport_timeout", "transport_unavailable",
  "invalid_stop_response", "runtime_instance_mismatch", "runtime_exit_unproven", "runtime_identity_unverified"
] as const);
export type AgentQueueStopDiagnosticCode = Static<typeof AgentQueueStopDiagnosticCodeSchema>;
export const AgentQueueConfirmationSourceSchema = literals(["worker_model", "local_fallback"] as const);
export type AgentQueueConfirmationSource = Static<typeof AgentQueueConfirmationSourceSchema>;
export const AgentQueueIdentitySchema = Type.Object({
  agentId: AgentQueueIdSchema, providerId: AgentQueueIdSchema, modelId: AgentQueueIdSchema
}, strict);
export type AgentQueueIdentity = Static<typeof AgentQueueIdentitySchema>;

const receiptFields = {
  id: AgentQueueIdSchema, clientRequestId: AgentQueueIdSchema,
  sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  createdAt: AgentQueueVersionSchema, updatedAt: AgentQueueVersionSchema
};
export const AgentQueuedUserMessageReceiptSchema = Type.Object({
  ...receiptFields, status: Type.Literal("queued"), messageId: Type.Null(), runId: Type.Null(),
  confirmationState: Type.Null(), confirmationSource: Type.Null()
}, strict);
const cancelledReceipt = Type.Object({
  ...receiptFields, status: Type.Literal("cancelled"), messageId: Type.Null(), runId: Type.Null(),
  confirmationState: Type.Null(), confirmationSource: Type.Null()
}, strict);
const injectedBase = { ...receiptFields, status: Type.Literal("injected"), messageId: AgentQueueIdSchema, runId: AgentQueueIdSchema };
export const AgentUserMessageReceiptSchema = Type.Union([
  AgentQueuedUserMessageReceiptSchema, cancelledReceipt,
  Type.Object({ ...injectedBase, confirmationState: literals(["unconfirmed", "abandoned"] as const), confirmationSource: Type.Null() }, strict),
  Type.Object({ ...injectedBase, confirmationState: Type.Literal("confirmed"), confirmationSource: AgentQueueConfirmationSourceSchema }, strict)
]);
export type AgentUserMessageReceipt = Static<typeof AgentUserMessageReceiptSchema>;
export const AgentQueueStopSnapshotSchema = Type.Object({
  state: literals(["none", "pending", "unknown", "quiescent"] as const),
  unresolvedOperationCount: AgentQueueVersionSchema, unresolvedTargetCount: AgentQueueVersionSchema,
  code: Type.Union([AgentQueueStopDiagnosticCodeSchema, Type.Null()])
}, strict);
export type AgentQueueStopSnapshot = Static<typeof AgentQueueStopSnapshotSchema>;
export const AgentMessageQueueSnapshotSchema = Type.Object({
  workspaceId: AgentQueueIdSchema, sessionId: AgentQueueIdSchema, queueVersion: AgentQueueVersionSchema,
  stopGeneration: AgentQueueHashSchema,
  pendingCount: Type.Integer({ minimum: 0, maximum: AGENT_QUEUE_MAX_PENDING_COUNT }),
  pendingBytes: Type.Integer({ minimum: 0, maximum: AGENT_QUEUE_MAX_PENDING_BYTES }),
  pendingIdentity: Type.Union([AgentQueueIdentitySchema, Type.Null()]),
  /** Authoritative identity for the next accepted input, including a running interactive Run. */
  inputIdentity: Type.Optional(Type.Union([AgentQueueIdentitySchema, Type.Null()])),
  unconfirmedInputCount: AgentQueueVersionSchema,
  unconfirmedInputSetHash: Type.Union([AgentQueueHashSchema, Type.Null()]),
  recoveryIdentity: Type.Union([AgentQueueIdentitySchema, Type.Null()]),
  stop: AgentQueueStopSnapshotSchema,
  items: Type.Array(Type.Object({
    ...AgentQueuedUserMessageReceiptSchema.properties,
    textPreview: Type.String({ maxLength: 256 }), attachmentCount: Type.Integer({ minimum: 0, maximum: 4 })
  }, strict), { maxItems: AGENT_QUEUE_MAX_PENDING_COUNT })
}, strict);
export type AgentMessageQueueSnapshot = Static<typeof AgentMessageQueueSnapshotSchema>;

const acceptFields = {
  workspaceId: AgentQueueIdSchema, clientRequestId: AgentQueueIdSchema,
  stopGeneration: Type.Optional(AgentQueueHashSchema),
  /** Null/absent is an explicit ordinary send; a supplement belongs only to this Run. */
  targetRunId: Type.Optional(nullableId),
  agentId: Type.Optional(AgentQueueIdSchema), uiLocale: Type.Optional(AgentUiLocaleSchema)
};
/** UTF-8 byte limit is enforced by the application; schema maxLength is only an early ceiling. */
export const AgentAcceptUserMessageRequestSchema = Type.Object({
  ...acceptFields, text: Type.String({ minLength: 1, maxLength: AGENT_QUEUE_MAX_TEXT_BYTES })
}, strict);
export type AgentAcceptUserMessageRequest = Static<typeof AgentAcceptUserMessageRequestSchema>;
export const AgentAcceptUserMessageMultipartPayloadSchema = Type.Object({
  ...acceptFields, text: Type.Optional(Type.String({ maxLength: AGENT_QUEUE_MAX_TEXT_BYTES }))
}, strict);
export type AgentAcceptUserMessageMultipartPayload = Static<typeof AgentAcceptUserMessageMultipartPayloadSchema>;
export const AgentAcceptUserMessageResponseSchema = Type.Object({
  receipt: AgentUserMessageReceiptSchema, deduplicated: Type.Boolean(), queue: AgentMessageQueueSnapshotSchema
}, strict);
export type AgentAcceptUserMessageResponse = Static<typeof AgentAcceptUserMessageResponseSchema>;
export const AgentMessageQueueQuerySchema = Type.Object({ workspaceId: AgentQueueIdSchema }, strict);
export type AgentMessageQueueQuery = Static<typeof AgentMessageQueueQuerySchema>;
export const AgentReceiptByRequestQuerySchema = Type.Object({ workspaceId: AgentQueueIdSchema, clientRequestId: AgentQueueIdSchema }, strict);
export type AgentReceiptByRequestQuery = Static<typeof AgentReceiptByRequestQuerySchema>;
export const AgentReceiptResponseSchema = Type.Object({ receipt: AgentUserMessageReceiptSchema, queue: AgentMessageQueueSnapshotSchema }, strict);
export type AgentReceiptResponse = Static<typeof AgentReceiptResponseSchema>;
export const AgentReceiptAttachmentSchema = Type.Object({
  id: AgentQueueIdSchema, position: Type.Integer({ minimum: 0, maximum: 3 }),
  filename: Type.String({ minLength: 1, maxLength: 255 }), mediaType: AgentImageMediaTypeSchema,
  byteSize: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 })
}, strict);
export type AgentReceiptAttachment = Static<typeof AgentReceiptAttachmentSchema>;
export const AgentReceiptDetailResponseSchema = Type.Object({
  receipt: AgentUserMessageReceiptSchema, text: Type.Union([Type.String(), Type.Null()]),
  inputText: Type.Union([Type.String(), Type.Null()]),
  attachments: Type.Array(AgentReceiptAttachmentSchema, { maxItems: 4 })
}, strict);
export type AgentReceiptDetailResponse = Static<typeof AgentReceiptDetailResponseSchema>;
export const AgentCancelReceiptRequestSchema = Type.Object({ workspaceId: AgentQueueIdSchema }, strict);
export type AgentCancelReceiptRequest = Static<typeof AgentCancelReceiptRequestSchema>;
/** Captured queued IDs only; effect-idempotent retries never target newer messages. */
export const AgentClearMessageQueueRequestSchema = Type.Object({
  workspaceId: AgentQueueIdSchema,
  receiptIds: Type.Array(AgentQueueIdSchema, { maxItems: AGENT_QUEUE_MAX_PENDING_COUNT, uniqueItems: true })
}, strict);
export type AgentClearMessageQueueRequest = Static<typeof AgentClearMessageQueueRequestSchema>;
export const AgentClearMessageQueueResponseSchema = Type.Object({
  cancelledCount: Type.Integer({ minimum: 0, maximum: AGENT_QUEUE_MAX_PENDING_COUNT }), queue: AgentMessageQueueSnapshotSchema
}, strict);
export type AgentClearMessageQueueResponse = Static<typeof AgentClearMessageQueueResponseSchema>;
export const AgentStopMessageQueueRequestSchema = Type.Object({ workspaceId: AgentQueueIdSchema, operationId: AgentQueueIdSchema }, strict);
export type AgentStopMessageQueueRequest = Static<typeof AgentStopMessageQueueRequestSchema>;
export const AgentStopMessageQueueResponseSchema = Type.Object({
  stopOperation: Type.Object({ operationId: AgentQueueIdSchema, acceptedQueueVersion: AgentQueueVersionSchema, targetCount: AgentQueueVersionSchema }, strict),
  queue: AgentMessageQueueSnapshotSchema
}, strict);
export type AgentStopMessageQueueResponse = Static<typeof AgentStopMessageQueueResponseSchema>;
export const AgentResumeMessageQueueRequestSchema = Type.Object({
  ...AgentStopMessageQueueRequestSchema.properties, expectedQueueVersion: AgentQueueVersionSchema
}, strict);
export type AgentResumeMessageQueueRequest = Static<typeof AgentResumeMessageQueueRequestSchema>;
export const AgentResumeMessageQueueResponseSchema = Type.Union([
  Type.Object({ action: Type.Literal("continued_unconfirmed"), runId: AgentQueueIdSchema, queue: AgentMessageQueueSnapshotSchema }, strict),
  Type.Object({ action: Type.Literal("no_unconfirmed"), runId: nullableId, queue: AgentMessageQueueSnapshotSchema }, strict)
]);
export type AgentResumeMessageQueueResponse = Static<typeof AgentResumeMessageQueueResponseSchema>;
export const AgentAbandonUnconfirmedInputRequestSchema = Type.Object({
  ...AgentResumeMessageQueueRequestSchema.properties,
  expectedUnconfirmedInputSetHash: AgentQueueHashSchema, confirmIrreversible: Type.Literal(true)
}, strict);
export type AgentAbandonUnconfirmedInputRequest = Static<typeof AgentAbandonUnconfirmedInputRequestSchema>;
export const AgentAbandonUnconfirmedInputResponseSchema = Type.Object({
  abandonedReceiptIds: Type.Array(AgentQueueIdSchema, { minItems: 1, uniqueItems: true }), queue: AgentMessageQueueSnapshotSchema
}, strict);
export type AgentAbandonUnconfirmedInputResponse = Static<typeof AgentAbandonUnconfirmedInputResponseSchema>;
export const AgentAttachmentRetentionResponseSchema = Type.Object({
  scope: Type.Literal("agent_web_queue_v1"), limitBytes: Type.Literal(AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES),
  chargedBytes: AgentQueueVersionSchema, reservedBytes: AgentQueueVersionSchema, retainedBytes: AgentQueueVersionSchema
}, strict);
export type AgentAttachmentRetentionResponse = Static<typeof AgentAttachmentRetentionResponseSchema>;

/** Public queue routes; production admission remains behind trusted runtime recovery. */
export const AgentMessageQueueEndpoints = {
  accept: { method: "POST", path: "/api/agent/sessions/:sessionId/receipts" },
  snapshot: { method: "GET", path: "/api/agent/sessions/:sessionId/message-queue" },
  byRequest: { method: "GET", path: "/api/agent/sessions/:sessionId/receipts/by-request" },
  receipt: { method: "GET", path: "/api/agent/sessions/:sessionId/receipts/:receiptId" },
  attachment: { method: "GET", path: "/api/agent/sessions/:sessionId/receipts/:receiptId/attachments/:attachmentId/content" },
  cancel: { method: "POST", path: "/api/agent/sessions/:sessionId/receipts/:receiptId/cancel" },
  clear: { method: "POST", path: "/api/agent/sessions/:sessionId/message-queue/clear" },
  stop: { method: "POST", path: "/api/agent/sessions/:sessionId/message-queue/stop" },
  resume: { method: "POST", path: "/api/agent/sessions/:sessionId/message-queue/resume" },
  abandon: { method: "POST", path: "/api/agent/sessions/:sessionId/message-queue/abandon-unconfirmed" },
  retention: { method: "GET", path: "/api/agent/attachment-retention" }
} as const;

export const AgentQueueErrorCodeSchema = literals([
  "AGENT_QUEUE_AGENT_CONFLICT", "AGENT_REQUEST_PAYLOAD_CONFLICT", "AGENT_REQUEST_ID_NAMESPACE_CONFLICT",
  "AGENT_RECEIPT_ALREADY_INJECTED", "AGENT_QUEUE_VERSION_CONFLICT", "AGENT_UNCONFIRMED_SET_CONFLICT",
  "AGENT_SESSION_STOP_PENDING", "AGENT_SESSION_STOP_UNKNOWN", "AGENT_RUNTIME_INSTANCE_MISMATCH",
  "AGENT_STOP_OPERATION_CONFLICT", "AGENT_QUEUE_RUN_DRAINING", "AGENT_QUEUE_RUN_ACTIVE",
  "AGENT_NO_UNCONFIRMED_INPUT", "AGENT_QUEUE_INPUT_NOT_CONFIRMED", "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN",
  "AGENT_QUEUE_STOP_GENERATION_CHANGED", "AGENT_QUEUE_EXECUTION_NOT_DRAINED", "AGENT_QUEUE_TOOL_STATE_UNSAFE",
  "SESSION_HAS_PENDING_INPUT", "AGENT_SUPPLEMENT_TARGET_CLOSED", "AGENT_QUEUE_TEXT_TOO_LARGE",
  "AGENT_QUEUE_CAPACITY_EXCEEDED", "AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED"
] as const);
export type AgentQueueErrorCode = Static<typeof AgentQueueErrorCodeSchema>;
