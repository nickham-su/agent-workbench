import { Type, type Static } from "@sinclair/typebox";

export const AgentApiRunStateRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
  activeRunId: Type.Union([Type.String(), Type.Null()]),
  activeAssistantItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  lastResponseTotalTokens: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  runNoticeText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentApiRunStateRequest = Static<typeof AgentApiRunStateRequestSchema>;

export const AgentApiRunStateResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AgentApiRunStateResponse = Static<typeof AgentApiRunStateResponseSchema>;

export const AgentApiRunCompleteRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled")
  ]),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentApiRunCompleteRequest = Static<typeof AgentApiRunCompleteRequestSchema>;

export const AgentApiRunCompleteResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AgentApiRunCompleteResponse = Static<typeof AgentApiRunCompleteResponseSchema>;
