import { Type, type Static } from "@sinclair/typebox";
import { AgentQueueHashSchema, AgentQueueIdSchema, AgentQueueStopDiagnosticCodeSchema } from "../contracts/agent-queue.js";
import { AgentRuntimeInstanceIdSchema, AGENT_STOP_PROTOCOL_VERSION } from "./agent-runtime.js";
import { AgentRunKindSchema } from "../contracts/agent.js";

export const AgentWorkerHealthResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AgentWorkerHealthResponse = Static<typeof AgentWorkerHealthResponseSchema>;

export const AgentWorkerEnqueueRequestSchema = Type.Object({
  workspaceId: Type.String(),
  sessionId: Type.String(),
  runId: Type.String(),
  runKind: Type.Optional(AgentRunKindSchema),
  // Optional only for source compatibility; the admitted path must require this identity.
  runtimeInstanceId: Type.Optional(AgentRuntimeInstanceIdSchema),
  inputText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resumeAssistantMessageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  workspacePath: Type.String(),
  workspaceRepoDirNames: Type.Optional(Type.Unknown())
});
export type AgentWorkerEnqueueRequest = Static<typeof AgentWorkerEnqueueRequestSchema>;

export const AgentWorkerEnqueueResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AgentWorkerEnqueueResponse = Static<typeof AgentWorkerEnqueueResponseSchema>;

export const AgentWorkerCancelSessionRequestSchema = Type.Object({
  sessionId: Type.String()
});
export type AgentWorkerCancelSessionRequest = Static<typeof AgentWorkerCancelSessionRequestSchema>;

export const AgentWorkerCancelSessionResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AgentWorkerCancelSessionResponse = Static<typeof AgentWorkerCancelSessionResponseSchema>;

export const AgentWorkerCancelSessionAndWaitRequestSchema = Type.Object({
  sessionId: Type.String(),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 60_000 })
});
export type AgentWorkerCancelSessionAndWaitRequest = Static<typeof AgentWorkerCancelSessionAndWaitRequestSchema>;

export const AgentWorkerCancelSessionAndWaitResponseSchema = Type.Object({
  ok: Type.Literal(true),
  idle: Type.Boolean()
});
export type AgentWorkerCancelSessionAndWaitResponse = Static<typeof AgentWorkerCancelSessionAndWaitResponseSchema>;


/** Dedicated authenticated handshake; legacy health remains source-compatible. */
export const AgentWorkerRuntimeIdentityResponseSchema = Type.Object({
  runtimeInstanceId: AgentRuntimeInstanceIdSchema,
  stopProtocolVersion: Type.Literal(AGENT_STOP_PROTOCOL_VERSION)
}, { additionalProperties: false });
export type AgentWorkerRuntimeIdentityResponse = Static<typeof AgentWorkerRuntimeIdentityResponseSchema>;

const stopScope = {
  workspaceId: AgentQueueIdSchema, rootSessionId: AgentQueueIdSchema, operationId: AgentQueueIdSchema,
  runtimeInstanceId: AgentRuntimeInstanceIdSchema, targetsHash: AgentQueueHashSchema
};
export const AgentWorkerStopRunsRequestSchema = Type.Object({
  ...stopScope,
  targets: Type.Array(Type.Object({ sessionId: AgentQueueIdSchema, runId: AgentQueueIdSchema }, { additionalProperties: false }), { minItems: 1, uniqueItems: true }),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 10_000 })
}, { additionalProperties: false });
export type AgentWorkerStopRunsRequest = Static<typeof AgentWorkerStopRunsRequestSchema>;
export const AgentWorkerStopRunsResponseSchema = Type.Union([
  Type.Object({ ...stopScope, state: Type.Literal("quiescent"), proofId: AgentQueueIdSchema, code: Type.Null() }, { additionalProperties: false }),
  Type.Object({
    ...stopScope, state: Type.Union([Type.Literal("pending"), Type.Literal("unknown")]),
    proofId: Type.Null(), code: AgentQueueStopDiagnosticCodeSchema
  }, { additionalProperties: false })
]);
export type AgentWorkerStopRunsResponse = Static<typeof AgentWorkerStopRunsResponseSchema>;

export { AGENT_STOP_PROTOCOL_VERSION } from "./agent-runtime.js";
