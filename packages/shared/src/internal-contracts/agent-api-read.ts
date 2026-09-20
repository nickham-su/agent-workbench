import { Type, type Static } from "@sinclair/typebox";
import {
  AgentContextToolNameSchema,
  AgentImageMediaTypeSchema,
  AgentRunKindSchema,
  AgentUiLocaleSchema
} from "../contracts/agent.js";
import {
  AgentProviderNpmSchema
} from "../contracts/settings.js";
import { AgentMessageSchema } from "../contracts/agent-message.js";
import { PluginToolCanonicalNameSchema } from "../contracts/plugin.js";
import { AgentProviderReplayEnvelopeSchema } from "./agent-provider-replay.js";

const AgentApiProviderSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  npm: AgentProviderNpmSchema,
  options: Type.Object({
    baseURL: Type.String({ minLength: 1 }),
    apiKey: Type.String({ minLength: 1 })
  })
});

const AgentApiModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  providerModelId: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1 }),
  contextWindowTokens: Type.Integer({ minimum: 1 }),
  options: Type.Optional(Type.Any())
});

const AgentApiExecutionAgentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  summary: Type.String({ maxLength: 160 }),
  prompt: Type.String(),
  tools: Type.Array(AgentContextToolNameSchema),
  pluginTools: Type.Array(PluginToolCanonicalNameSchema),
  mcpServers: Type.Array(Type.String({ minLength: 1 })),
  defaultModel: Type.Union([
    Type.Object({ providerId: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) }),
    Type.Null()
  ])
});

const AgentApiReadRunRequestFields = {
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 })
};

export const AgentApiExecutionProfileRequestSchema = Type.Object(AgentApiReadRunRequestFields);
export type AgentApiExecutionProfileRequest = Static<typeof AgentApiExecutionProfileRequestSchema>;

const AgentApiResolvedExecutionProfileSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 })
});

const AgentApiProviderModelProfileSchema = Type.Object({
  provider: AgentApiProviderSchema,
  model: AgentApiModelSchema
});

const AgentApiVisionProfileSchema = Type.Intersect([
  Type.Object({
    source: Type.Union([Type.Literal("runtime_vision"), Type.Literal("agent_default_fallback")])
  }),
  AgentApiProviderModelProfileSchema
]);

const AgentApiCompactionProfileSchema = Type.Intersect([
  Type.Object({ source: Type.Literal("runtime_compaction") }),
  AgentApiProviderModelProfileSchema
]);

export const AgentApiExecutionProfileResponseSchema = Type.Object({
  resolved: AgentApiResolvedExecutionProfileSchema,
  agent: AgentApiExecutionAgentSchema,
  provider: AgentApiProviderSchema,
  model: AgentApiModelSchema,
  runtime: Type.Object({
    modelIdleTimeoutMs: Type.Integer({ minimum: 0 }),
    modelTotalTimeoutMs: Type.Integer({ minimum: 0 }),
    modelRequestMaxRetries: Type.Integer({ minimum: 0, maximum: 100 }),
    modelRequestRetryBackoffMaxMs: Type.Integer({ minimum: 2_000, maximum: 3_600_000 }),
    autoCompactThresholdPct: Type.Integer({ minimum: 50, maximum: 99 }),
    maxSubtaskDepth: Type.Integer({ minimum: 1, maximum: 5 }),
    sessionTerminalSoundEnabled: Type.Boolean(),
    visionModel: Type.Union([
      Type.Object({
        providerId: Type.String({ minLength: 1 }),
        modelId: Type.String({ minLength: 1 })
      }),
      Type.Null()
    ]),
    compactionModel: Type.Union([
      Type.Object({
        providerId: Type.String({ minLength: 1 }),
        modelId: Type.String({ minLength: 1 })
      }),
      Type.Null()
    ]),
    updatedAt: Type.Number()
  }),
  vision: Type.Union([AgentApiVisionProfileSchema, Type.Null()]),
  compaction: Type.Union([AgentApiCompactionProfileSchema, Type.Null()])
});
export type AgentApiExecutionProfileResponse = Static<typeof AgentApiExecutionProfileResponseSchema>;

export const AgentApiPromptContextRequestSchema = Type.Object(AgentApiReadRunRequestFields);
export type AgentApiPromptContextRequest = Static<typeof AgentApiPromptContextRequestSchema>;

/** Provider-neutral, single-snapshot logical source for compaction work. */
export const AGENT_API_COMPACTION_SOURCE_REQUEST_KEYS = ["workspaceId", "sessionId", "runId"] as const;
export const AgentApiCompactionSourceRequestSchema = Type.Object(AgentApiReadRunRequestFields, { additionalProperties: false });
export type AgentApiCompactionSourceRequest = Static<typeof AgentApiCompactionSourceRequestSchema>;

/** Compaction source never exposes artifact paths or unbounded structured tool results. */
const AgentApiContextToolExecutionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  callPartId: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("unknown"),
  ]),
  resultPreview: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  completedAt: Type.Union([Type.Number(), Type.Null()]),
}, { additionalProperties: false });

const AgentApiResolvedContextBlockSchema = Type.Object({
  sourceMessageId: Type.String({ minLength: 1 }),
  physical: Type.Object({
    previousMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    depth: Type.Integer({ minimum: 0 }),
    originSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    originRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    updatedRevision: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  message: AgentMessageSchema,
  toolExecutions: Type.Array(AgentApiContextToolExecutionSchema),
  attachments: Type.Array(Type.Object({
    partId: Type.String({ minLength: 1 }),
    attachmentId: Type.String({ minLength: 1 }),
    mediaType: AgentImageMediaTypeSchema,
    filename: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
  providerReplay: Type.Array(Type.Object({
    partId: Type.String({ minLength: 1 }),
    envelope: AgentProviderReplayEnvelopeSchema,
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const AgentApiCompactionPendingBoundarySchema = Type.Union([
  Type.Null(),
  Type.Object({
    reason: Type.Literal("pending_tool_execution"),
    assistantMessageId: Type.String({ minLength: 1 }),
    toolExecutionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }, { additionalProperties: false }),
]);

export const AgentApiCompactionSourceResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  runKind: AgentRunKindSchema,
  triggerMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  agentId: Type.String({ minLength: 1 }),
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  subtaskDepth: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  headMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  contextRootMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  sessionRevision: Type.Integer({ minimum: 0 }),
  uiLocale: Type.Null(),
  oneShotSystem: Type.String(),
  blocks: Type.Array(AgentApiResolvedContextBlockSchema),
  pendingBoundary: AgentApiCompactionPendingBoundarySchema,
}, { additionalProperties: false });
export type AgentApiCompactionSourceResponse = Static<typeof AgentApiCompactionSourceResponseSchema>;

const AgentApiPromptTextPartSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String()
}, { additionalProperties: false });

export const AgentApiPromptAttachmentRefPartSchema = Type.Object({
  type: Type.Literal("attachment_ref"),
  workspaceId: Type.String({ minLength: 1 }),
  attachmentId: Type.String({ minLength: 1 }),
  mediaType: AgentImageMediaTypeSchema,
  filename: Type.String()
}, { additionalProperties: false });
export type AgentApiPromptAttachmentRefPart = Static<typeof AgentApiPromptAttachmentRefPartSchema>;

const AgentApiPromptToolCallPartSchema = Type.Object({
  type: Type.Literal("tool-call"),
  toolCallId: Type.String({ minLength: 1 }),
  toolName: AgentContextToolNameSchema,
  input: Type.Any()
}, { additionalProperties: false });

const AgentApiPromptToolResultOutputSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("error-text"), value: Type.String() }, { additionalProperties: false })
]);

const AgentApiPromptToolResultPartSchema = Type.Object({
  type: Type.Literal("tool-result"),
  toolCallId: Type.String({ minLength: 1 }),
  toolName: AgentContextToolNameSchema,
  output: AgentApiPromptToolResultOutputSchema
}, { additionalProperties: false });

const AgentApiPromptUserContentPartsSchema = Type.Union([
  Type.Tuple([AgentApiPromptTextPartSchema]),
  Type.Tuple([AgentApiPromptTextPartSchema, AgentApiPromptAttachmentRefPartSchema]),
  Type.Tuple([AgentApiPromptTextPartSchema, AgentApiPromptAttachmentRefPartSchema, AgentApiPromptAttachmentRefPartSchema]),
  Type.Tuple([
    AgentApiPromptTextPartSchema,
    AgentApiPromptAttachmentRefPartSchema,
    AgentApiPromptAttachmentRefPartSchema,
    AgentApiPromptAttachmentRefPartSchema
  ]),
  Type.Tuple([
    AgentApiPromptTextPartSchema,
    AgentApiPromptAttachmentRefPartSchema,
    AgentApiPromptAttachmentRefPartSchema,
    AgentApiPromptAttachmentRefPartSchema,
    AgentApiPromptAttachmentRefPartSchema
  ])
]);

const AgentApiPromptMessageSchema = Type.Union([
  Type.Object({ role: Type.Literal("system"), content: Type.String() }, { additionalProperties: false }),
  Type.Object({
    role: Type.Literal("user"),
    content: Type.Union([Type.String(), AgentApiPromptUserContentPartsSchema])
  }, { additionalProperties: false }),
  Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Union([Type.String(), Type.Array(Type.Union([AgentApiPromptTextPartSchema, AgentApiPromptToolCallPartSchema]))])
  }, { additionalProperties: false }),
  Type.Object({ role: Type.Literal("tool"), content: Type.Array(AgentApiPromptToolResultPartSchema) }, { additionalProperties: false })
]);

const AgentApiPromptProviderReplayPartSchema = Type.Union([
  Type.Object({
    visibleIndex: Type.Integer({ minimum: 0 }),
    type: Type.Literal("reasoning"),
    text: Type.String(),
    providerReplay: AgentProviderReplayEnvelopeSchema
  }, { additionalProperties: false }),
  Type.Object({
    visibleIndex: Type.Integer({ minimum: 0 }),
    type: Type.Literal("text"),
    providerReplay: AgentProviderReplayEnvelopeSchema
  }, { additionalProperties: false }),
  Type.Object({
    visibleIndex: Type.Integer({ minimum: 0 }),
    type: Type.Literal("tool_call"),
    providerReplay: AgentProviderReplayEnvelopeSchema
  }, { additionalProperties: false })
]);

const AgentApiPromptProviderReplaySourceSchema = Type.Object({
  assistantOrdinal: Type.Integer({ minimum: 0 }),
  parts: Type.Array(AgentApiPromptProviderReplayPartSchema)
}, { additionalProperties: false });

export const AgentApiPromptContextResponseSchema = Type.Object({
  headMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  sessionRevision: Type.Integer({ minimum: 0 }),
  system: Type.String(),
  messages: Type.Array(AgentApiPromptMessageSchema),
  providerReplay: Type.Optional(Type.Array(AgentApiPromptProviderReplaySourceSchema)),
  tools: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    inputSchema: Type.Any()
  })),
  pendingTools: Type.Array(Type.Object({
    toolExecutionId: Type.String({ minLength: 1 }),
    callPartId: Type.String({ minLength: 1 }),
    assistantMessageId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("queued"), Type.Literal("running")]),
    toolName: Type.String({ minLength: 1 }),
    toolCallId: Type.Optional(Type.String({ minLength: 1 })),
    args: Type.Any()
  })),
  lastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  uiLocale: Type.Union([AgentUiLocaleSchema, Type.Null()]),
  externalSkillRoots: Type.Array(Type.Object({
    sourceType: Type.Union([Type.Literal("workspace"), Type.Literal("repo")]),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    rootDir: Type.String({ minLength: 1 }),
    rootPath: Type.String({ minLength: 1 })
  }))
});
export type AgentApiPromptContextResponse = Static<typeof AgentApiPromptContextResponseSchema>;

export const AgentApiMessagesContextRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  appendMessage: Type.Optional(Type.Object({
    role: Type.Union([Type.Literal("system"), Type.Literal("user")]),
    content: Type.String({ minLength: 1 })
  }))
});
export type AgentApiMessagesContextRequest = Static<typeof AgentApiMessagesContextRequestSchema>;

export const AgentApiMessagesContextResponseSchema = Type.Object({
  headMessageId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  system: Type.String(),
  messages: Type.Array(AgentApiPromptMessageSchema)
});
export type AgentApiMessagesContextResponse = Static<typeof AgentApiMessagesContextResponseSchema>;

const AgentArchiveRequestFields = {
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

export const AgentApiArchiveReadRequestSchema = Type.Object(AgentArchiveRequestFields, { additionalProperties: false });
export type AgentApiArchiveReadRequest = Static<typeof AgentApiArchiveReadRequestSchema>;

export const AgentApiArchiveSearchRequestSchema = Type.Object({
  ...AgentArchiveRequestFields,
  query: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type AgentApiArchiveSearchRequest = Static<typeof AgentApiArchiveSearchRequestSchema>;

export const AgentApiArchiveEntrySchema = Type.Object({
  partId: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
  messageDepth: Type.Integer({ minimum: 0 }),
  partPosition: Type.Integer({ minimum: 0 }),
  text: Type.String(),
  excerpt: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const AgentApiArchivePageResponseSchema = Type.Object({
  items: Type.Array(AgentApiArchiveEntrySchema),
  nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });
export type AgentApiArchivePageResponse = Static<typeof AgentApiArchivePageResponseSchema>;
