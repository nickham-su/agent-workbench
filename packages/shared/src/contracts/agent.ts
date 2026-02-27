import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const AgentSessionKindSchema = Type.Union([Type.Literal("primary"), Type.Literal("subtask")]);
export type AgentSessionKind = Static<typeof AgentSessionKindSchema>;

export const AgentRunStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("waiting_approval")
]);
export type AgentRunStatus = Static<typeof AgentRunStatusSchema>;

export const AgentEventLaneSchema = Type.Union([
  Type.Literal("timeline"),
  Type.Literal("realtime"),
  Type.Literal("control")
]);
export type AgentEventLane = Static<typeof AgentEventLaneSchema>;

export const AgentTextPayloadSchema = Type.Object({
  preview: Type.String(),
  truncated: Type.Boolean(),
  artifactPath: Type.Union([Type.String(), Type.Null()]),
  bytes: Type.Optional(Type.Number({ minimum: 0 })),
  lines: Type.Optional(Type.Number({ minimum: 0 }))
});
export type AgentTextPayload = Static<typeof AgentTextPayloadSchema>;

export const AgentSessionRecordSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  kind: AgentSessionKindSchema,
  headEventId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});
export type AgentSessionRecord = Static<typeof AgentSessionRecordSchema>;

export const AgentEventRecordSchema = Type.Object({
  eventId: Type.Number(),
  id: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  lane: AgentEventLaneSchema,
  prevId: Type.Union([Type.String(), Type.Null()]),
  type: Type.String({ minLength: 1 }),
  schemaVersion: Type.Number({ minimum: 1 }),
  correlationId: Type.Union([Type.String(), Type.Null()]),
  causationId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  payload: Type.Any()
});
export type AgentEventRecord = Static<typeof AgentEventRecordSchema>;

export const AgentSessionConversationResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  headEventId: Type.Union([Type.String(), Type.Null()]),
  appliedEventId: Type.Number(),
  events: Type.Array(AgentEventRecordSchema)
});
export type AgentSessionConversationResponse = Static<typeof AgentSessionConversationResponseSchema>;

export const AgentSessionRunStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  status: AgentRunStatusSchema,
  activeRunId: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Number(),
  appliedEventId: Type.Number()
});
export type AgentSessionRunState = Static<typeof AgentSessionRunStateSchema>;

export const AgentCreateSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.Optional(AgentSessionKindSchema)
});
export type AgentCreateSessionRequest = Static<typeof AgentCreateSessionRequestSchema>;

export const AgentForkSessionRequestSchema = Type.Object({
  fromSessionId: Type.String({ minLength: 1 }),
  fromEventId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.Optional(AgentSessionKindSchema)
});
export type AgentForkSessionRequest = Static<typeof AgentForkSessionRequestSchema>;

export const AgentSendMessageRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  clientRequestId: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String({ minLength: 1 }))
});
export type AgentSendMessageRequest = Static<typeof AgentSendMessageRequestSchema>;

export const AgentSendMessageResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  messageEventId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  deduplicated: Type.Boolean(),
  triggerMessageId: Type.Optional(Type.String({ minLength: 1 }))
});
export type AgentSendMessageResponse = Static<typeof AgentSendMessageResponseSchema>;

export const AgentRevertSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  toEventId: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String({ minLength: 1 }))
});
export type AgentRevertSessionRequest = Static<typeof AgentRevertSessionRequestSchema>;

export const AgentCancelSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  anchorEventId: Type.String({ minLength: 1 })
});
export type AgentCancelSessionRequest = Static<typeof AgentCancelSessionRequestSchema>;

export const AgentControlResultSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  headEventId: Type.Union([Type.String(), Type.Null()])
});
export type AgentControlResult = Static<typeof AgentControlResultSchema>;
