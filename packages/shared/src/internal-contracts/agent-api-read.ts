import { Type, type Static } from "@sinclair/typebox";
import {
  AgentContextItemStatusSchema,
  AgentContextToolNameSchema,
  AgentImageMediaTypeSchema,
  AgentUiLocaleSchema
} from "../contracts/agent.js";
import {
  AgentProviderNpmSchema
} from "../contracts/settings.js";
import { PluginToolCanonicalNameSchema } from "../contracts/plugin.js";

const AgentApiProviderSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  npm: AgentProviderNpmSchema,
  options: Type.Object({
    baseURL: Type.String({ minLength: 1 }),
    apiKey: Type.String({ minLength: 1 }),
    apiMode: Type.Optional(Type.Union([Type.Literal("responses"), Type.Literal("chatCompletions")]))
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

export const AgentApiPromptContextResponseSchema = Type.Object({
  headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  system: Type.String(),
  messages: Type.Array(AgentApiPromptMessageSchema),
  tools: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    inputSchema: Type.Any()
  })),
  pendingTools: Type.Array(Type.Object({
    itemId: Type.Number({ minimum: 1 }),
    status: AgentContextItemStatusSchema,
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
  headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  system: Type.String(),
  messages: Type.Array(AgentApiPromptMessageSchema)
});
export type AgentApiMessagesContextResponse = Static<typeof AgentApiMessagesContextResponseSchema>;
