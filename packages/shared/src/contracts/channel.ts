import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const ChannelChatTypeSchema = Type.Union([Type.Literal("direct"), Type.Literal("group")]);
export type ChannelChatType = Static<typeof ChannelChatTypeSchema>;

export const ChannelSenderRoleSchema = Type.Union([Type.Literal("admin"), Type.Literal("user")]);
export type ChannelSenderRole = Static<typeof ChannelSenderRoleSchema>;

export const ChannelIngestInboundMessageRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    channelName: Type.String({ minLength: 1 }),
    accountId: Type.String({ minLength: 1 }),
    conversationKey: Type.String({ minLength: 1 }),
    chatType: ChannelChatTypeSchema,
    chatId: Type.String({ minLength: 1 }),
    externalMessageId: Type.String({ minLength: 1 }),
    createdAtExternalMs: Type.Optional(Type.Number({ minimum: 0 })),
    sender: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        displayName: Type.Optional(Type.String())
      },
      { additionalProperties: false }
    ),
    mentionedBot: Type.Optional(Type.Boolean()),
    text: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type ChannelIngestInboundMessageRequest = Static<typeof ChannelIngestInboundMessageRequestSchema>;

export const ChannelIngestInboundMessageResponseSchema = Type.Union(
  [
    Type.Object(
      {
        ok: Type.Literal(true),
        deduplicated: Type.Boolean()
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ok: Type.Literal(false),
        errorCode: Type.Union([Type.Literal("NOT_ALLOWED"), Type.Literal("PAYLOAD_INVALID")]),
        message: Type.String()
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
);
export type ChannelIngestInboundMessageResponse = Static<typeof ChannelIngestInboundMessageResponseSchema>;

export const ChannelAllowlistCheckRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    senderId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type ChannelAllowlistCheckRequest = Static<typeof ChannelAllowlistCheckRequestSchema>;

export const ChannelAllowlistCheckResponseSchema = Type.Object(
  {
    allowed: Type.Boolean(),
    role: Type.Optional(ChannelSenderRoleSchema),
    reason: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);
export type ChannelAllowlistCheckResponse = Static<typeof ChannelAllowlistCheckResponseSchema>;

export const ChannelBuildAggregatedUserPromptRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    channelName: Type.String({ minLength: 1 }),
    accountId: Type.String({ minLength: 1 }),
    conversationKey: Type.String({ minLength: 1 }),
    upperBoundExternalMessageId: Type.String({ minLength: 1 }),
    maxMessages: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 100000 }))
  },
  { additionalProperties: false }
);
export type ChannelBuildAggregatedUserPromptRequest = Static<typeof ChannelBuildAggregatedUserPromptRequestSchema>;

export const ChannelBuildAggregatedUserPromptResponseSchema = Type.Object(
  {
    text: Type.String(),
    consumedExternalMessageId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type ChannelBuildAggregatedUserPromptResponse = Static<typeof ChannelBuildAggregatedUserPromptResponseSchema>;

export const ChannelTriggerRunRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    channelName: Type.String({ minLength: 1 }),
    accountId: Type.String({ minLength: 1 }),
    conversationKey: Type.String({ minLength: 1 }),
    triggerExternalMessageId: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    clientRequestId: Type.Optional(Type.String({ minLength: 1 })),
    watermarkAdvanceExternalMessageId: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);
export type ChannelTriggerRunRequest = Static<typeof ChannelTriggerRunRequestSchema>;

export const ChannelTriggerRunResponseSchema = Type.Union(
  [
    Type.Object(
      {
        ok: Type.Literal(true),
        runId: Type.String({ minLength: 1 }),
        deduplicated: Type.Boolean()
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ok: Type.Literal(false),
        errorCode: Type.String({ minLength: 1 }),
        message: Type.String(),
        statusSummary: Type.Optional(Type.Any())
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
);
export type ChannelTriggerRunResponse = Static<typeof ChannelTriggerRunResponseSchema>;

export const ChannelUpsertConversationBindingRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    channelName: Type.String({ minLength: 1 }),
    accountId: Type.String({ minLength: 1 }),
    conversationKey: Type.String({ minLength: 1 }),
    chatId: Type.String({ minLength: 1 }),
    chatType: ChannelChatTypeSchema,
    sessionId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type ChannelUpsertConversationBindingRequest = Static<typeof ChannelUpsertConversationBindingRequestSchema>;

export const ChannelGetConversationBindingRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    channelName: Type.String({ minLength: 1 }),
    accountId: Type.String({ minLength: 1 }),
    conversationKey: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
export type ChannelGetConversationBindingRequest = Static<typeof ChannelGetConversationBindingRequestSchema>;

export const ChannelConversationBindingSchema = Type.Object(
  {
    pluginId: Type.String(),
    channelName: Type.String(),
    accountId: Type.String(),
    conversationKey: Type.String(),
    chatId: Type.String(),
    chatType: ChannelChatTypeSchema,
    workspaceId: Type.String(),
    sessionId: Type.String(),
    selectedAgentId: Type.Union([Type.String(), Type.Null()]),
    groupMode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    watermarkExternalMessageId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  },
  { additionalProperties: false }
);
export type ChannelConversationBinding = Static<typeof ChannelConversationBindingSchema>;

export const ChannelSetSelectedAgentRequestSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1 }),
    channelName: Type.String({ minLength: 1 }),
    accountId: Type.String({ minLength: 1 }),
    conversationKey: Type.String({ minLength: 1 }),
    selectedAgentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()])
  },
  { additionalProperties: false }
);
export type ChannelSetSelectedAgentRequest = Static<typeof ChannelSetSelectedAgentRequestSchema>;
