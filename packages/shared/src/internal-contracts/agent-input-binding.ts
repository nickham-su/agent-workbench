import { Type, type Static } from "@sinclair/typebox";
import {
  AGENT_QUEUE_INPUT_POLICY_VERSION, AgentQueueHashSchema, AgentQueueIdSchema, AgentQueueVersionSchema
} from "../contracts/agent-queue.js";

/** Trusted snapshot metadata; input source is derived by the receiving capability. */
export const AgentInteractiveInputBindingSchema = Type.Object({
  inputReceiptIds: Type.Array(AgentQueueIdSchema, { uniqueItems: true }),
  effectiveInputPolicyVersion: Type.Literal(AGENT_QUEUE_INPUT_POLICY_VERSION),
  snapshotHash: AgentQueueHashSchema,
  inputRevision: AgentQueueVersionSchema
}, { additionalProperties: false });
export type AgentInteractiveInputBinding = Static<typeof AgentInteractiveInputBindingSchema>;

/** Protected read-side metadata, never supplied by the public send endpoint. */
export const AgentEffectiveInputPolicySchema = Type.Object({
  version: Type.Literal(AGENT_QUEUE_INPUT_POLICY_VERSION),
  interactive: Type.Boolean(),
  inputReceiptIds: Type.Array(AgentQueueIdSchema, { uniqueItems: true }),
  activeAssistantBinding: Type.Optional(Type.Object({
    messageId: AgentQueueIdSchema,
    inputBinding: AgentInteractiveInputBindingSchema
  }, { additionalProperties: false })),
  inputs: Type.Array(Type.Object({
    receiptId: AgentQueueIdSchema,
    messageId: AgentQueueIdSchema,
    currentRunInput: Type.Boolean(),
    attachments: Type.Array(Type.Object({
      attachmentId: AgentQueueIdSchema, byteSha256: AgentQueueHashSchema, byteSize: Type.Integer({ minimum: 1 })
    }, { additionalProperties: false }))
  }, { additionalProperties: false }))
}, { additionalProperties: false });
export type AgentEffectiveInputPolicy = Static<typeof AgentEffectiveInputPolicySchema>;
