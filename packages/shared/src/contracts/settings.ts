import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const NetworkSettingsSchema = Type.Object({
  httpProxy: Type.Union([Type.String(), Type.Null()]),
  httpsProxy: Type.Union([Type.String(), Type.Null()]),
  noProxy: Type.Union([Type.String(), Type.Null()]),
  caCertPem: Type.Union([Type.String(), Type.Null()]),
  applyToTerminal: Type.Boolean(),
  updatedAt: Type.Number()
});
export type NetworkSettings = Static<typeof NetworkSettingsSchema>;

export const UpdateNetworkSettingsRequestSchema = Type.Object({
  httpProxy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  httpsProxy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  noProxy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  caCertPem: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  applyToTerminal: Type.Optional(Type.Boolean())
});
export type UpdateNetworkSettingsRequest = Static<typeof UpdateNetworkSettingsRequestSchema>;

export const SearchSettingsSchema = Type.Object({
  excludeGlobs: Type.Array(Type.String()),
  updatedAt: Type.Number()
});
export type SearchSettings = Static<typeof SearchSettingsSchema>;

export const UpdateSearchSettingsRequestSchema = Type.Object({
  excludeGlobs: Type.Optional(Type.Array(Type.String()))
});
export type UpdateSearchSettingsRequest = Static<typeof UpdateSearchSettingsRequestSchema>;

export const AgentProviderModelOptionsSchema = Type.Object({
  aiSdk: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Any())),
  providerOptionsByKey: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.Record(Type.String({ minLength: 1 }), Type.Any()))
  )
});
export type AgentProviderModelOptions = Static<typeof AgentProviderModelOptionsSchema>;

export const AgentProviderModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  providerModelId: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1 }),
  options: Type.Optional(AgentProviderModelOptionsSchema)
});
export type AgentProviderModel = Static<typeof AgentProviderModelSchema>;

export const AgentProviderNpmSchema = Type.Union([Type.Literal("@ai-sdk/openai"), Type.Literal("@ai-sdk/anthropic")]);
export type AgentProviderNpm = Static<typeof AgentProviderNpmSchema>;

export const AgentProviderOptionsInputSchema = Type.Object({
  baseURL: Type.String({ minLength: 1 }),
  apiKey: Type.Optional(Type.Union([Type.String(), Type.Null()]))
});
export type AgentProviderOptionsInput = Static<typeof AgentProviderOptionsInputSchema>;

export const AgentProviderItemInputSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  npm: AgentProviderNpmSchema,
  options: AgentProviderOptionsInputSchema,
  models: Type.Array(AgentProviderModelSchema)
});
export type AgentProviderItemInput = Static<typeof AgentProviderItemInputSchema>;

export const AgentProvidersDefaultSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 })
});
export type AgentProvidersDefault = Static<typeof AgentProvidersDefaultSchema>;

export const AgentProvidersSettingsSchema = Type.Object({
  default: Type.Union([AgentProvidersDefaultSchema, Type.Null()]),
  providers: Type.Array(AgentProviderItemInputSchema),
  updatedAt: Type.Number()
});
export type AgentProvidersSettings = Static<typeof AgentProvidersSettingsSchema>;

export const UpdateAgentProvidersSettingsRequestSchema = Type.Object({
  default: Type.Union([AgentProvidersDefaultSchema, Type.Null()]),
  providers: Type.Array(AgentProviderItemInputSchema)
});
export type UpdateAgentProvidersSettingsRequest = Static<typeof UpdateAgentProvidersSettingsRequestSchema>;

export const AgentProviderOptionsViewSchema = Type.Object({
  baseURL: Type.String({ minLength: 1 }),
  hasApiKey: Type.Boolean(),
  apiKeyMasked: Type.Union([Type.String(), Type.Null()])
});
export type AgentProviderOptionsView = Static<typeof AgentProviderOptionsViewSchema>;

export const AgentProviderItemViewSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  npm: AgentProviderNpmSchema,
  options: AgentProviderOptionsViewSchema,
  models: Type.Array(AgentProviderModelSchema)
});
export type AgentProviderItemView = Static<typeof AgentProviderItemViewSchema>;

export const AgentProvidersSettingsViewSchema = Type.Object({
  default: Type.Union([AgentProvidersDefaultSchema, Type.Null()]),
  providers: Type.Array(AgentProviderItemViewSchema),
  updatedAt: Type.Number()
});
export type AgentProvidersSettingsView = Static<typeof AgentProvidersSettingsViewSchema>;

export const AgentMcpServerLocalConfigSchema = Type.Object({
  type: Type.Literal("local"),
  command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  environment: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  timeout: Type.Optional(Type.Number({ minimum: 1 }))
});
export type AgentMcpServerLocalConfig = Static<typeof AgentMcpServerLocalConfigSchema>;

export const AgentMcpServerOAuthConfigSchema = Type.Object({
  clientId: Type.Optional(Type.String({ minLength: 1 })),
  clientSecret: Type.Optional(Type.String({ minLength: 1 })),
  scope: Type.Optional(Type.String({ minLength: 1 }))
});
export type AgentMcpServerOAuthConfig = Static<typeof AgentMcpServerOAuthConfigSchema>;

export const AgentMcpServerRemoteConfigSchema = Type.Object({
  type: Type.Literal("remote"),
  url: Type.String({ minLength: 1 }),
  headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  oauth: Type.Optional(Type.Union([AgentMcpServerOAuthConfigSchema, Type.Literal(false)])),
  timeout: Type.Optional(Type.Number({ minimum: 1 }))
});
export type AgentMcpServerRemoteConfig = Static<typeof AgentMcpServerRemoteConfigSchema>;

export const AgentMcpServerConfigSchema = Type.Union([AgentMcpServerLocalConfigSchema, AgentMcpServerRemoteConfigSchema]);
export type AgentMcpServerConfig = Static<typeof AgentMcpServerConfigSchema>;

export const AgentMcpServerSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  enabled: Type.Boolean(),
  config: AgentMcpServerConfigSchema
});
export type AgentMcpServer = Static<typeof AgentMcpServerSchema>;

export const AgentMcpSettingsSchema = Type.Object({
  servers: Type.Array(AgentMcpServerSchema),
  updatedAt: Type.Number()
});
export type AgentMcpSettings = Static<typeof AgentMcpSettingsSchema>;

export const UpdateAgentMcpSettingsRequestSchema = Type.Object({
  servers: Type.Array(AgentMcpServerSchema)
});
export type UpdateAgentMcpSettingsRequest = Static<typeof UpdateAgentMcpSettingsRequestSchema>;

export const AgentToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("apply_patch"),
  Type.Literal("subtask")
]);
export type AgentToolName = Static<typeof AgentToolNameSchema>;

export const AgentPermissionsSchema = Type.Object({
  allowRead: Type.Boolean(),
  allowWrite: Type.Boolean(),
  allowBash: Type.Boolean()
});
export type AgentPermissions = Static<typeof AgentPermissionsSchema>;

export const AgentDefaultModelSchema = Type.Union([AgentProvidersDefaultSchema, Type.Null()]);
export type AgentDefaultModel = Static<typeof AgentDefaultModelSchema>;

export const AgentItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  summary: Type.String({ maxLength: 160 }),
  prompt: Type.String(),
  tools: Type.Array(AgentToolNameSchema),
  mcpServers: Type.Array(Type.String({ minLength: 1 })),
  permissions: AgentPermissionsSchema,
  defaultModel: AgentDefaultModelSchema
});
export type AgentItem = Static<typeof AgentItemSchema>;

export const AgentSettingsDefaultSchema = Type.Object({
  agentId: Type.String({ minLength: 1 })
});
export type AgentSettingsDefault = Static<typeof AgentSettingsDefaultSchema>;

export const AgentSettingsSchema = Type.Object({
  default: Type.Union([AgentSettingsDefaultSchema, Type.Null()]),
  agents: Type.Array(AgentItemSchema),
  updatedAt: Type.Number()
});
export type AgentSettings = Static<typeof AgentSettingsSchema>;

export const UpdateAgentSettingsRequestSchema = Type.Object({
  default: Type.Union([AgentSettingsDefaultSchema, Type.Null()]),
  agents: Type.Array(AgentItemSchema)
});
export type UpdateAgentSettingsRequest = Static<typeof UpdateAgentSettingsRequestSchema>;

export const MasterKeySourceSchema = Type.Union([Type.Literal("env"), Type.Literal("file"), Type.Literal("generated")]);
export type MasterKeySource = Static<typeof MasterKeySourceSchema>;

export const SecurityStatusSchema = Type.Object({
  credentialMasterKey: Type.Object({
    source: MasterKeySourceSchema,
    keyId: Type.String(),
    createdAt: Type.Union([Type.Number(), Type.Null()])
  }),
  sshKnownHostsPath: Type.String()
});
export type SecurityStatus = Static<typeof SecurityStatusSchema>;

export const ResetKnownHostRequestSchema = Type.Object({
  host: Type.String({ minLength: 1 })
});
export type ResetKnownHostRequest = Static<typeof ResetKnownHostRequestSchema>;

export const GitGlobalIdentitySchema = Type.Object({
  name: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()])
});
export type GitGlobalIdentity = Static<typeof GitGlobalIdentitySchema>;

export const UpdateGitGlobalIdentityRequestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 })
});
export type UpdateGitGlobalIdentityRequest = Static<typeof UpdateGitGlobalIdentityRequestSchema>;

export const ClearAllGitIdentityResponseSchema = Type.Object({
  ok: Type.Boolean(),
  clearedGlobal: Type.Boolean(),
  clearedRepos: Type.Number(),
  errors: Type.Array(
    Type.Object({
      workspaceId: Type.String(),
      path: Type.String(),
      error: Type.String()
    })
  )
});
export type ClearAllGitIdentityResponse = Static<typeof ClearAllGitIdentityResponseSchema>;
