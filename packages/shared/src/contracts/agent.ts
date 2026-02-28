import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const AgentSessionKindSchema = Type.Union([Type.Literal("primary"), Type.Literal("subtask")]);
export type AgentSessionKind = Static<typeof AgentSessionKindSchema>;

export const AgentMcpToolNameSchema = Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" });
export const AgentContextToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("subtask"),
  AgentMcpToolNameSchema
]);
export type AgentContextToolName = Static<typeof AgentContextToolNameSchema>;

export const AgentRunStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("waiting_permission")
]);
export type AgentRunStatus = Static<typeof AgentRunStatusSchema>;

export const AgentContextItemKindSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("tool"),
  Type.Literal("system")
]);
export type AgentContextItemKind = Static<typeof AgentContextItemKindSchema>;

export const AgentContextItemStatusSchema = Type.Union([
  Type.Literal("streaming"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("awaiting_permission"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("denied"),
  Type.Literal("cancelled")
]);
export type AgentContextItemStatus = Static<typeof AgentContextItemStatusSchema>;

export const AgentUserTextOutputSchema = Type.Object({
  type: Type.Literal("user_text"),
  text: Type.String()
});

export const AgentAssistantTextOutputSchema = Type.Object({
  type: Type.Literal("assistant_text"),
  text: Type.String()
});

export const AgentToolOutputSchema = Type.Object({
  type: Type.Literal("tool"),
  toolName: AgentContextToolNameSchema,
  toolCallId: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Any()),
  approved: Type.Optional(Type.Boolean()),
  result: Type.Optional(Type.Any()),
  error: Type.Optional(Type.String())
});

export const AgentSystemTextOutputSchema = Type.Object({
  type: Type.Literal("system_text"),
  text: Type.String()
});

export const AgentContextItemOutputSchema = Type.Union([
  AgentUserTextOutputSchema,
  AgentAssistantTextOutputSchema,
  AgentToolOutputSchema,
  AgentSystemTextOutputSchema
]);
export type AgentContextItemOutput = Static<typeof AgentContextItemOutputSchema>;

export const AgentSessionRecordSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  kind: AgentSessionKindSchema,
  forkedFromSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  forkedFromItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});
export type AgentSessionRecord = Static<typeof AgentSessionRecordSchema>;

export const AgentContextItemRecordSchema = Type.Object({
  id: Type.Number({ minimum: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  turnId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  step: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  prevId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  kind: AgentContextItemKindSchema,
  status: AgentContextItemStatusSchema,
  output: AgentContextItemOutputSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});
export type AgentContextItemRecord = Static<typeof AgentContextItemRecordSchema>;

export const AgentContextItemsResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  appliedItemId: Type.Number({ minimum: 0 }),
  items: Type.Array(AgentContextItemRecordSchema)
});
export type AgentContextItemsResponse = Static<typeof AgentContextItemsResponseSchema>;

export const AgentSessionRunStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  status: AgentRunStatusSchema,
  activeRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  activeAssistantItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  waitingToolItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  lastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  nonTerminalItemIds: Type.Array(Type.Number({ minimum: 1 })),
  updatedAt: Type.Number(),
  appliedItemId: Type.Number({ minimum: 0 })
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
  fromItemId: Type.Number({ minimum: 1 }),
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
  messageItemId: Type.Number({ minimum: 1 }),
  runId: Type.String({ minLength: 1 }),
  deduplicated: Type.Boolean()
});
export type AgentSendMessageResponse = Static<typeof AgentSendMessageResponseSchema>;

export const AgentRevertSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  toItemId: Type.Number({ minimum: 1 }),
  reason: Type.Optional(Type.String({ minLength: 1 }))
});
export type AgentRevertSessionRequest = Static<typeof AgentRevertSessionRequestSchema>;

export const AgentCancelSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 })
});
export type AgentCancelSessionRequest = Static<typeof AgentCancelSessionRequestSchema>;

export const AgentControlResultSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()])
});
export type AgentControlResult = Static<typeof AgentControlResultSchema>;

export const AgentContextItemsQuerySchema = Type.Object({
  afterId: Type.Optional(Type.Number({ minimum: 0 }))
});
export type AgentContextItemsQuery = Static<typeof AgentContextItemsQuerySchema>;

export const AgentPermissionDecisionSchema = Type.Union([Type.Literal("approve"), Type.Literal("deny")]);
export type AgentPermissionDecision = Static<typeof AgentPermissionDecisionSchema>;

export const AgentToolPermissionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  toolItemId: Type.Number({ minimum: 1 }),
  decision: AgentPermissionDecisionSchema
});
export type AgentToolPermissionRequest = Static<typeof AgentToolPermissionRequestSchema>;
