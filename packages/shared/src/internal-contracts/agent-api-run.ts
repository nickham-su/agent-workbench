import { Type, type Static } from "@sinclair/typebox";

export const AgentApiRunCompleteRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  updatedAt: Type.Optional(Type.Number()),
});
export type AgentApiRunCompleteRequest = Static<
  typeof AgentApiRunCompleteRequestSchema
>;

export const AgentApiRunCompleteResponseSchema = Type.Object({
  ok: Type.Literal(true),
});
export type AgentApiRunCompleteResponse = Static<
  typeof AgentApiRunCompleteResponseSchema
>;
