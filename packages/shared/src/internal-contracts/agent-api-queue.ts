import { Type, type Static } from "@sinclair/typebox";
import {
  AGENT_QUEUE_INPUT_ESTIMATOR_VERSION, AGENT_QUEUE_INPUT_POLICY_VERSION, AGENT_QUEUE_MAX_INJECT_BATCH,
  AgentMessageQueueSnapshotSchema, AgentQueueHashSchema, AgentQueueIdSchema, AgentQueueIdentitySchema,
  AgentQueueVersionSchema, AgentReceiptAttachmentSchema, AgentUserMessageReceiptSchema
} from "../contracts/agent-queue.js";
import { AgentApiPromptContextResponseSchema } from "./agent-api-read.js";

const strict = { additionalProperties: false } as const;
export { AgentRuntimeInstanceIdSchema } from "./agent-runtime.js";
import { AgentRuntimeInstanceIdSchema } from "./agent-runtime.js";
const runScope = { workspaceId: AgentQueueIdSchema, sessionId: AgentQueueIdSchema, runId: AgentQueueIdSchema };
export const AgentApiCheckRuntimeAdmissionRequestSchema = Type.Object({
  ...runScope, runtimeInstanceId: AgentRuntimeInstanceIdSchema
}, strict);
export type AgentApiCheckRuntimeAdmissionRequest = Static<typeof AgentApiCheckRuntimeAdmissionRequestSchema>;
export const AgentApiCheckRuntimeAdmissionResponseSchema = Type.Object({ bindingMatches: Type.Boolean(), admitted: Type.Boolean() }, strict);
export type AgentApiCheckRuntimeAdmissionResponse = Static<typeof AgentApiCheckRuntimeAdmissionResponseSchema>;
export const AgentApiRetireRuntimeAdmissionRequestSchema = AgentApiCheckRuntimeAdmissionRequestSchema;
export type AgentApiRetireRuntimeAdmissionRequest = Static<typeof AgentApiRetireRuntimeAdmissionRequestSchema>;
export const AgentApiRetireRuntimeAdmissionResponseSchema = Type.Object({ retired: Type.Boolean() }, strict);
export type AgentApiRetireRuntimeAdmissionResponse = Static<typeof AgentApiRetireRuntimeAdmissionResponseSchema>;


export { AgentInteractiveInputBindingSchema, type AgentInteractiveInputBinding } from "./agent-input-binding.js";

export const AgentApiPrepareInteractiveInputRequestSchema = Type.Object({
  ...runScope, operationId: AgentQueueIdSchema
}, strict);
export type AgentApiPrepareInteractiveInputRequest = Static<typeof AgentApiPrepareInteractiveInputRequestSchema>;
export const AgentInteractiveInputCandidateSchema = Type.Object({
  receipt: AgentUserMessageReceiptSchema, identity: AgentQueueIdentitySchema,
  text: Type.String(), inputText: Type.String(),
  attachments: Type.Array(Type.Object({ ...AgentReceiptAttachmentSchema.properties, byteSha256: AgentQueueHashSchema, path: Type.String({ minLength: 1 }) }, strict), { maxItems: 4 })
}, strict);
export type AgentInteractiveInputCandidate = Static<typeof AgentInteractiveInputCandidateSchema>;
const prepareResult = { operationId: AgentQueueIdSchema, queue: AgentMessageQueueSnapshotSchema };
export const AgentApiPrepareInteractiveInputResponseSchema = Type.Union([
  Type.Object({
    ...prepareResult, decision: Type.Literal("prepare"), context: AgentApiPromptContextResponseSchema,
    candidates: Type.Array(AgentInteractiveInputCandidateSchema, { maxItems: AGENT_QUEUE_MAX_INJECT_BATCH }),
    inputReceiptIds: Type.Array(AgentQueueIdSchema, { uniqueItems: true }), preparationSnapshotHash: AgentQueueHashSchema,
    effectiveInputPolicyVersion: Type.Literal(AGENT_QUEUE_INPUT_POLICY_VERSION), estimatorVersion: Type.Literal(AGENT_QUEUE_INPUT_ESTIMATOR_VERSION)
  }, strict),
  Type.Object({ ...prepareResult, decision: Type.Literal("finish") }, strict),
  // The original ordinary prepare committed, but its process-local frozen payload is gone.
  // This is NEVER evidence of finish; callers must use a new operation at a valid boundary.
  Type.Object({ ...prepareResult, decision: Type.Literal("expired") }, strict),
  // A durable negative admission decision, not an unknown control-write outcome.
  Type.Object({ ...prepareResult, decision: Type.Literal("rejected"),
    reason: Type.Union([Type.Literal("snapshot_too_large"), Type.Literal("cache_capacity")]) }, strict)
]);
export type AgentApiPrepareInteractiveInputResponse = Static<typeof AgentApiPrepareInteractiveInputResponseSchema>;
export const AgentApiInjectInteractiveInputRequestSchema = Type.Object({
  ...runScope, operationId: AgentQueueIdSchema,
  expectedHeadMessageId: Type.Union([AgentQueueIdSchema, Type.Null()]), expectedRevision: AgentQueueVersionSchema,
  receiptIds: Type.Array(AgentQueueIdSchema, { minItems: 1, maxItems: AGENT_QUEUE_MAX_INJECT_BATCH, uniqueItems: true }),
  preparationSnapshotHash: AgentQueueHashSchema, estimatorVersion: Type.Literal(AGENT_QUEUE_INPUT_ESTIMATOR_VERSION)
}, strict);
export type AgentApiInjectInteractiveInputRequest = Static<typeof AgentApiInjectInteractiveInputRequestSchema>;
export const AgentApiInjectInteractiveInputResponseSchema = Type.Object({
  operationId: AgentQueueIdSchema,
  receipts: Type.Array(AgentUserMessageReceiptSchema, { minItems: 1, maxItems: AGENT_QUEUE_MAX_INJECT_BATCH }),
  headMessageId: AgentQueueIdSchema, revision: AgentQueueVersionSchema, queue: AgentMessageQueueSnapshotSchema
}, strict);
export type AgentApiInjectInteractiveInputResponse = Static<typeof AgentApiInjectInteractiveInputResponseSchema>;
export const AgentApiCompleteInteractiveAssistantRequestSchema = Type.Object({
  ...runScope, operationId: AgentQueueIdSchema, messageId: AgentQueueIdSchema,
  responseTotalTokens: Type.Optional(Type.Union([AgentQueueVersionSchema, Type.Null()])), updatedAt: AgentQueueVersionSchema
}, strict);
export type AgentApiCompleteInteractiveAssistantRequest = Static<typeof AgentApiCompleteInteractiveAssistantRequestSchema>;
export const AgentApiCompleteInteractiveAssistantResponseSchema = Type.Object({
  operationId: AgentQueueIdSchema, decision: Type.Union([Type.Literal("continue"), Type.Literal("finish")]),
  queue: AgentMessageQueueSnapshotSchema
}, strict);
export type AgentApiCompleteInteractiveAssistantResponse = Static<typeof AgentApiCompleteInteractiveAssistantResponseSchema>;

export const AgentQueueApiEndpoints = {
  retireRuntimeAdmission: { method: "POST", path: "/api/internal/agent/runs/runtime-admission/retire" },
  checkRuntimeAdmission: { method: "POST", path: "/api/internal/agent/runs/runtime-admission" },
  prepareInteractiveInput: { method: "POST", path: "/api/internal/agent/interactive-input/prepare" },
  injectInteractiveInput: { method: "POST", path: "/api/internal/agent/interactive-input/inject" },
  completeInteractiveAssistant: { method: "POST", path: "/api/internal/agent/messages/assistant/complete-interactive" }
} as const;
