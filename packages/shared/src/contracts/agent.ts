import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { PluginToolCanonicalNameSchema } from "./plugin.js";
import { AgentItemViewSchema } from "./settings.js";

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
  Type.Literal("scratchpad"),
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

export const AgentSessionActiveRunSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    startedAt: Type.Number()
  },
  { additionalProperties: false }
);
export type AgentSessionActiveRun = Static<typeof AgentSessionActiveRunSchema>;

export const AgentSessionLastRunStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);
export type AgentSessionLastRunStatus = Static<typeof AgentSessionLastRunStatusSchema>;

export const AgentSessionLastRunSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: AgentSessionLastRunStatusSchema,
    startedAt: Type.Number(),
    endedAt: Type.Number(),
    durationMs: Type.Number({ minimum: 0 })
  },
  { additionalProperties: false }
);
export type AgentSessionLastRun = Static<typeof AgentSessionLastRunSchema>;

export const AgentSessionRunStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  status: AgentRunStatusSchema,
  activeRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  activeAssistantItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  // Optional for backward compatibility; server may include it.
  //
  // Semantics:
  // - When present, `activeRun` describes the currently running run (if any).
  // - It is meant for persistent display (e.g. header elapsed timer) during `status: "running"`.
  activeRun: Type.Optional(Type.Union([AgentSessionActiveRunSchema, Type.Null()])),
  lastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  nonTerminalItemIds: Type.Array(Type.Number({ minimum: 1 })),
  runNoticeText: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Number(),

  // Semantics (event-like):
  // - `lastTerminalStatus` is a strict, time-aligned terminal status intended to represent
  //   the run that *just finished*.
  // - It is computed with additional constraints (e.g. timestamps) to avoid mis-reporting
  //   an older run as the just-finished one.
  // - Consumers should NOT use it as the persistent "most recent run" status.
  lastTerminalStatus: AgentSessionTerminalStatusSchema,
  appliedItemId: Type.Number({ minimum: 0 }),

  // Optional for backward compatibility; server may include it.
  //
  // Semantics (persistent):
  // - `lastRun` represents the most recent *terminal* run (completed/failed/cancelled).
  // - It is designed for persistent display (e.g. show last elapsed after run finishes).
  // - It may be present even when `status: "running"` (meaning it refers to the previous run).
  lastRun: Type.Optional(Type.Union([AgentSessionLastRunSchema, Type.Null()]))
});
export type AgentSessionRunState = Static<typeof AgentSessionRunStateSchema>;

export const AgentSessionStatusSummaryRequestSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    // Compatibility:
    // - IM design doc v1 used `agentId`
    // - current implementation used `selectedAgentId`
    // Accept both. If both are provided, `selectedAgentId` wins.
    agentId: Type.Optional(Type.String({ minLength: 1 })),
    selectedAgentId: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);
export type AgentSessionStatusSummaryRequest = Static<typeof AgentSessionStatusSummaryRequestSchema>;

// Compatibility: IM design doc uses `terminalStatus`, while existing run-state uses `lastTerminalStatus`.
// Keep both in status-summary response.
export const AgentSessionRunStateWithTerminalStatusSchema = Type.Intersect(
  [
    AgentSessionRunStateSchema,
    Type.Object({
      terminalStatus: AgentSessionTerminalStatusSchema
    })
  ],
  { additionalProperties: false }
);

export const AgentSessionStatusSummaryResponseSchema = Type.Object(
  {
    updatedAt: Type.Number(),
    generatedAt: Type.Optional(Type.Number()),
    session: AgentSessionRecordSchema,
    agent: Type.Union([
      Type.Object({
        id: Type.String({ minLength: 1 }),
        name: Type.String({ minLength: 1 })
      }),
      Type.Null()
    ]),
    runState: AgentSessionRunStateWithTerminalStatusSchema,
    startedAt: Type.Union([Type.Number(), Type.Null()]),
    elapsedMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    contextWindowTokens: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    contextTokenRatio: Type.Union([Type.Number({ minimum: 0 }), Type.Null()])
  },
  { additionalProperties: false }
);
export type AgentSessionStatusSummaryResponse = Static<typeof AgentSessionStatusSummaryResponseSchema>;

// --------------------------------------------------------------------------------------
// IM plugins helpers (internal-only)
// --------------------------------------------------------------------------------------

export const AgentRecentSessionsRequestSchema = Type.Object(
  {
    kind: Type.Optional(
      Type.Union([
        Type.Literal("primary"),
        Type.Literal("subtask"),
        Type.Literal("all")
      ])
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
  },
  { additionalProperties: false }
);
export type AgentRecentSessionsRequest = Static<typeof AgentRecentSessionsRequestSchema>;

export const AgentRecentSessionItemSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    sessionTitle: Type.String({ minLength: 1 }),
    sessionUpdatedAt: Type.Number(),
    workspaceId: Type.String({ minLength: 1 }),
    workspaceTitle: Type.String({ minLength: 1 }),
    workspaceDirName: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type AgentRecentSessionItem = Static<typeof AgentRecentSessionItemSchema>;

export const AgentRecentSessionsResponseSchema = Type.Object(
  {
    items: Type.Array(AgentRecentSessionItemSchema)
  },
  { additionalProperties: false }
);
export type AgentRecentSessionsResponse = Static<typeof AgentRecentSessionsResponseSchema>;

export const AgentRecentWorkspacesRequestSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
  },
  { additionalProperties: false }
);
export type AgentRecentWorkspacesRequest = Static<typeof AgentRecentWorkspacesRequestSchema>;

export const AgentRecentWorkspaceItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    dirName: Type.String({ minLength: 1 }),
    updatedAt: Type.Number(),
    lastUsedAt: Type.Union([Type.Number(), Type.Null()])
  },
  { additionalProperties: false }
);
export type AgentRecentWorkspaceItem = Static<typeof AgentRecentWorkspaceItemSchema>;

export const AgentRecentWorkspacesResponseSchema = Type.Object(
  {
    items: Type.Array(AgentRecentWorkspaceItemSchema)
  },
  { additionalProperties: false }
);
export type AgentRecentWorkspacesResponse = Static<typeof AgentRecentWorkspacesResponseSchema>;

export const AgentListAvailableAgentsRequestSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    surface: Type.Optional(Type.Literal("user"))
  },
  { additionalProperties: false }
);
export type AgentListAvailableAgentsRequest = Static<typeof AgentListAvailableAgentsRequestSchema>;

export const AgentListAvailableAgentsResponseSchema = Type.Object(
  {
    agents: Type.Array(AgentItemViewSchema)
  },
  { additionalProperties: false }
);
export type AgentListAvailableAgentsResponse = Static<typeof AgentListAvailableAgentsResponseSchema>;

export const AgentSessionContextItemsTailRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    tailLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
  },
  { additionalProperties: false }
);
export type AgentSessionContextItemsTailRequest = Static<typeof AgentSessionContextItemsTailRequestSchema>;

export const AgentSessionContextItemsTailResponseSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
    appliedItemId: Type.Number({ minimum: 0 }),
    items: Type.Array(AgentContextItemRecordSchema)
  },
  { additionalProperties: false }
);
export type AgentSessionContextItemsTailResponse = Static<typeof AgentSessionContextItemsTailResponseSchema>;

export const AgentCreateSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.Optional(AgentSessionKindSchema)
});
export type AgentCreateSessionRequest = Static<typeof AgentCreateSessionRequestSchema>;

export const AgentInternalCreateSessionRequestSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
    kind: Type.Optional(AgentSessionKindSchema)
  },
  { additionalProperties: false }
);
export type AgentInternalCreateSessionRequest = Static<typeof AgentInternalCreateSessionRequestSchema>;

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
