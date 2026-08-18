import { Type, type Static } from "@sinclair/typebox";

export const AgentWorkerHealthResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AgentWorkerHealthResponse = Static<typeof AgentWorkerHealthResponseSchema>;

export const AgentWorkerEnqueueRequestSchema = Type.Object({
  workspaceId: Type.String(),
  sessionId: Type.String(),
  runId: Type.String(),
  inputText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
