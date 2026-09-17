import { Type, type Static } from "@sinclair/typebox";
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
