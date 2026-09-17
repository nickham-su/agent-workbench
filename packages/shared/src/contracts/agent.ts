import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { AgentItemViewSchema } from "./settings.js";
import { AgentContextToolNameSchema, AgentImageMediaTypeSchema, AgentMcpToolNameSchema, AgentSessionKindSchema } from "./agent-primitives.js";
export { AgentContextToolNameSchema, AgentImageMediaTypeSchema, AgentMcpToolNameSchema, AgentSessionKindSchema } from "./agent-primitives.js";
export type { AgentContextToolName, AgentImageMediaType, AgentSessionKind } from "./agent-primitives.js";

export const AgentUiLocaleSchema = Type.Union([Type.Literal("zh-CN"), Type.Literal("en-US")]);
export type AgentUiLocale = Static<typeof AgentUiLocaleSchema>;

export const AgentRunStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running")
]);
export type AgentRunStatus = Static<typeof AgentRunStatusSchema>;

/** Run 的持久化语义；恢复时不得由输入文本或触发消息猜测。 */
export const AgentRunKindSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("manual_compaction"),
  Type.Literal("subtask"),
]);
export type AgentRunKind = Static<typeof AgentRunKindSchema>;

export const AgentSessionRecordSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  kind: AgentSessionKindSchema,
  forkedFromSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  forkedFromMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  headMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  contextRootMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  revision: Type.Integer({ minimum: 0 }),
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});
export type AgentSessionRecord = Static<typeof AgentSessionRecordSchema>;

/** Configuration source for a session's effective Agent primary model. */
export const AgentSessionModelSourceSchema = Type.Union([
  Type.Literal("session_override"),
  Type.Literal("agent_default")
]);
export type AgentSessionModelSource = Static<typeof AgentSessionModelSourceSchema>;

export const AgentSessionModelStatusSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("invalid"),
  Type.Literal("missing")
]);
export type AgentSessionModelStatus = Static<typeof AgentSessionModelStatusSchema>;

export const AgentSessionModelRefSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 })
}, { additionalProperties: false });
export type AgentSessionModelRef = Static<typeof AgentSessionModelRefSchema>;

export const AgentSessionModelOverrideSchema = Type.Object({
  ...AgentSessionModelRefSchema.properties,
  updatedAt: Type.Number({ exclusiveMinimum: 0 })
}, { additionalProperties: false });
export type AgentSessionModelOverride = Static<typeof AgentSessionModelOverrideSchema>;

export const AgentSessionEffectiveModelSchema = Type.Object({
  ...AgentSessionModelRefSchema.properties,
  providerName: Type.String({ minLength: 1 }),
  modelName: Type.String({ minLength: 1 }),
  contextWindowTokens: Type.Number({ minimum: 1 })
}, { additionalProperties: false });
export type AgentSessionEffectiveModel = Static<typeof AgentSessionEffectiveModelSchema>;

/**
 * Read-side projection for one (sessionId, agentId) primary-model setting.
 * `source` describes the configuration layer only; consumers must use
 * `status` and `reasonCode` to determine whether the model is executable.
 */
export const AgentSessionAgentModelStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  agentName: Type.String({ minLength: 1 }),
  editable: Type.Boolean(),
  agentDefaultModel: Type.Union([AgentSessionModelRefSchema, Type.Null()]),
  override: Type.Union([AgentSessionModelOverrideSchema, Type.Null()]),
  effectiveModel: Type.Union([AgentSessionEffectiveModelSchema, Type.Null()]),
  source: AgentSessionModelSourceSchema,
  status: AgentSessionModelStatusSchema,
  reasonCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  message: Type.Union([Type.String({ minLength: 1 }), Type.Null()])
}, { additionalProperties: false });
export type AgentSessionAgentModelState = Static<typeof AgentSessionAgentModelStateSchema>;

export const AgentSessionModelOverridesResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  items: Type.Array(AgentSessionAgentModelStateSchema)
}, { additionalProperties: false });
export type AgentSessionModelOverridesResponse = Static<typeof AgentSessionModelOverridesResponseSchema>;

export const UpdateAgentSessionModelOverrideRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 })
}, { additionalProperties: false });
export type UpdateAgentSessionModelOverrideRequest = Static<typeof UpdateAgentSessionModelOverrideRequestSchema>;

export const AgentSessionModelWorkspaceQuerySchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 })
}, { additionalProperties: false });
export type AgentSessionModelWorkspaceQuery = Static<typeof AgentSessionModelWorkspaceQuerySchema>;

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

export const AgentCreateSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
export type AgentCreateSessionRequest = Static<typeof AgentCreateSessionRequestSchema>;

export const AgentUpdateSessionTitleRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1, maxLength: 1000 })
}, { additionalProperties: false });
export type AgentUpdateSessionTitleRequest = Static<typeof AgentUpdateSessionTitleRequestSchema>;

export const AgentInternalCreateSessionRequestSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);
export type AgentInternalCreateSessionRequest = Static<typeof AgentInternalCreateSessionRequestSchema>;

export const AgentInternalChannelSenderRoleSchema = Type.Union([Type.Literal("admin"), Type.Literal("user")]);
export type AgentInternalChannelSenderRole = Static<typeof AgentInternalChannelSenderRoleSchema>;

export const AgentChannelAllowlistCheckRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    senderId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type AgentChannelAllowlistCheckRequest = Static<typeof AgentChannelAllowlistCheckRequestSchema>;

export const AgentChannelAllowlistCheckResponseSchema = Type.Object(
  { allowed: Type.Boolean(), role: Type.Optional(AgentInternalChannelSenderRoleSchema), reason: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false }
);
export type AgentChannelAllowlistCheckResponse = Static<typeof AgentChannelAllowlistCheckResponseSchema>;

const AgentSendMessageCommonFields = {
  workspaceId: Type.String({ minLength: 1 }),
  clientRequestId: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  uiLocale: Type.Optional(AgentUiLocaleSchema)
};

export const AgentSendMessageRequestSchema = Type.Object({
  ...AgentSendMessageCommonFields,
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type AgentSendMessageRequest = Static<typeof AgentSendMessageRequestSchema>;

export const AgentSendMessageMultipartPayloadSchema = Type.Object({
  ...AgentSendMessageCommonFields,
  text: Type.Optional(Type.String())
}, { additionalProperties: false });
export type AgentSendMessageMultipartPayload = Static<typeof AgentSendMessageMultipartPayloadSchema>;

export const AgentSendMessageResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  deduplicated: Type.Boolean()
}, { additionalProperties: false });
export type AgentSendMessageResponse = Static<typeof AgentSendMessageResponseSchema>;

export const AgentRevertSessionRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentRevertSessionRequest = Static<typeof AgentRevertSessionRequestSchema>;

export const AgentForkSessionRequestSchema = Type.Object({
  fromSessionId: Type.String({ minLength: 1 }),
  fromMessageId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
export type AgentForkSessionRequest = Static<typeof AgentForkSessionRequestSchema>;
