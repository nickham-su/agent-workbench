import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { PluginToolCanonicalNameSchema } from "./plugin.js";

export const AgentUiLocaleSchema = Type.Union([Type.Literal("zh-CN"), Type.Literal("en-US")]);
export type AgentUiLocale = Static<typeof AgentUiLocaleSchema>;

export const AgentSessionKindSchema = Type.Union([Type.Literal("primary"), Type.Literal("subtask")]);
export type AgentSessionKind = Static<typeof AgentSessionKindSchema>;

export const AgentMcpToolNameSchema = Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" });
export const AgentContextToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("apply_patch"),
  Type.Literal("todolist"),
  Type.Literal("subtask"),
  Type.Literal("archive_search"),
  Type.Literal("archive_read"),
  AgentMcpToolNameSchema,
  PluginToolCanonicalNameSchema
]);
export type AgentContextToolName = Static<typeof AgentContextToolNameSchema>;

export const AgentRunStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running")
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
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);
export type AgentContextItemStatus = Static<typeof AgentContextItemStatusSchema>;

export const AgentUserTextOutputSchema = Type.Object({
  type: Type.Literal("user_text"),
  text: Type.String()
});

export const AgentAssistantReasoningSchema = Type.Object({
  text: Type.String()
});

export const AgentAssistantTextOutputSchema = Type.Object({
  type: Type.Literal("assistant_text"),
  text: Type.String(),
  reasoning: Type.Optional(AgentAssistantReasoningSchema),
  error: Type.Optional(Type.String())
});

export type AgentAssistantReasoning = Static<typeof AgentAssistantReasoningSchema>;

export const AgentToolOutputSchema = Type.Object({
  type: Type.Literal("tool"),
  toolName: AgentContextToolNameSchema,
  toolCallId: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Any()),
  text: Type.Optional(Type.String()),
  textTruncated: Type.Optional(Type.Boolean()),
  textArtifactPath: Type.Optional(Type.String({ minLength: 1 })),
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
  archiveAt: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  boundaryReason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  output: AgentContextItemOutputSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});
export type AgentContextItemRecord = Static<typeof AgentContextItemRecordSchema>;

export const AgentContextItemsResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  appliedItemId: Type.Number({ minimum: 0 }),
  hasMoreBefore: Type.Optional(Type.Boolean()),
  items: Type.Array(AgentContextItemRecordSchema)
});
export type AgentContextItemsResponse = Static<typeof AgentContextItemsResponseSchema>;

export const AgentSessionTerminalStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Null()
]);
export type AgentSessionTerminalStatus = Static<typeof AgentSessionTerminalStatusSchema>;

export const AgentSessionRunStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  status: AgentRunStatusSchema,
  activeRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  activeAssistantItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  lastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  nonTerminalItemIds: Type.Array(Type.Number({ minimum: 1 })),
  runNoticeText: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Number(),
  lastTerminalStatus: AgentSessionTerminalStatusSchema,
  appliedItemId: Type.Number({ minimum: 0 })
});
export type AgentSessionRunState = Static<typeof AgentSessionRunStateSchema>;

export const AgentCreateSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.Optional(AgentSessionKindSchema)
});
export type AgentCreateSessionRequest = Static<typeof AgentCreateSessionRequestSchema>;

export const AgentSendMessageRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  clientRequestId: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  uiLocale: Type.Optional(AgentUiLocaleSchema)
}, { additionalProperties: false });
export type AgentSendMessageRequest = Static<typeof AgentSendMessageRequestSchema>;

export const AgentSendMessageResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  messageItemId: Type.Number({ minimum: 1 }),
  runId: Type.String({ minLength: 1 }),
  deduplicated: Type.Boolean()
}, { additionalProperties: false });
export type AgentSendMessageResponse = Static<typeof AgentSendMessageResponseSchema>;

export const AgentControlResultSchema = Type.Object({
  ok: Type.Boolean(),
  session: AgentSessionRecordSchema,
  runState: AgentSessionRunStateSchema
});
export type AgentControlResult = Static<typeof AgentControlResultSchema>;

export const AgentCancelSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentCancelSessionRequest = Static<typeof AgentCancelSessionRequestSchema>;

export const AgentClearSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String()),
  uiLocale: Type.Optional(AgentUiLocaleSchema),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentClearSessionRequest = Static<typeof AgentClearSessionRequestSchema>;

export const AgentContextItemsQuerySchema = Type.Object({
  afterId: Type.Optional(Type.Number({ minimum: 0 })),
  tailLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  beforeId: Type.Optional(Type.Number({ minimum: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  expectedHeadItemId: Type.Optional(Type.Number({ minimum: 1 }))
});
export type AgentContextItemsQuery = Static<typeof AgentContextItemsQuerySchema>;

export const AgentCompactSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  clientRequestId: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  uiLocale: Type.Optional(AgentUiLocaleSchema),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentCompactSessionRequest = Static<typeof AgentCompactSessionRequestSchema>;

export const AgentCompactSessionResponseSchema = Type.Object({
  ok: Type.Boolean(),
  session: AgentSessionRecordSchema,
  runState: AgentSessionRunStateSchema,
  runId: Type.String({ minLength: 1 }),
  scheduled: Type.Boolean(),
  skippedReason: Type.Optional(Type.String())
});
export type AgentCompactSessionResponse = Static<typeof AgentCompactSessionResponseSchema>;

export const AgentRevertSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  itemId: Type.Number({ minimum: 1 }),
  reason: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentRevertSessionRequest = Static<typeof AgentRevertSessionRequestSchema>;

export const AgentForkSessionRequestSchema = Type.Object({
  fromSessionId: Type.String({ minLength: 1 }),
  fromItemId: Type.Number({ minimum: 1 }),
  mode: Type.Union([Type.Literal("with_archive"), Type.Literal("visible_only")]),
  title: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.Optional(AgentSessionKindSchema)
});
export type AgentForkSessionRequest = Static<typeof AgentForkSessionRequestSchema>;
