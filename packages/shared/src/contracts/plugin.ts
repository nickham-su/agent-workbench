import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const PluginIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
export type PluginId = Static<typeof PluginIdSchema>;

// 插件工具短名（manifest.tools[].name）。
// 注意：v1 采用单一 provider-safe 命名体系，因此短名也必须满足 provider 对 tool name 的字符集约束。
// 只允许字母数字、下划线、连字符，并要求以字母开头（与历史约定保持一致）。
export const PluginToolShortNameSchema = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
export type PluginToolShortName = Static<typeof PluginToolShortNameSchema>;

export const PluginToolCanonicalNameSchema = Type.String({
  // 单一 provider-safe 命名体系：plugin_<pluginId>_<toolName>
  // - pluginId 允许小写字母、数字、连字符
  // - toolName 允许字母、数字、下划线、连字符
  // - 不使用双下划线
  pattern: "^plugin_[a-z0-9][a-z0-9-]{0,63}_[A-Za-z][A-Za-z0-9_-]{0,63}$"
});
export type PluginToolCanonicalName = Static<typeof PluginToolCanonicalNameSchema>;

export const PluginCapabilitySchema = Type.Union([
  Type.Literal("tools"),
  Type.Literal("channels"),
  Type.Literal("hooks"),
  Type.Literal("services")
]);
export type PluginCapability = Static<typeof PluginCapabilitySchema>;

export const PluginToolManifestItemSchema = Type.Object({
  name: PluginToolShortNameSchema,
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  riskLevel: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])) ,
  outputMode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("text+raw")]))
});
export type PluginToolManifestItem = Static<typeof PluginToolManifestItemSchema>;

const PluginNamedCapabilityItemSchema = Type.Object({
  name: Type.String({ minLength: 1 })
});

export const PluginManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  id: PluginIdSchema,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  version: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  entry: Type.String({ minLength: 1 }),
  engines: Type.Optional(
    Type.Object({
      agentWorkbench: Type.Optional(Type.String({ minLength: 1 }))
    })
  ),
  capabilities: Type.Array(PluginCapabilitySchema, { minItems: 1, uniqueItems: true }),
  tools: Type.Optional(Type.Array(PluginToolManifestItemSchema)),
  channels: Type.Optional(Type.Array(PluginNamedCapabilityItemSchema)),
  hooks: Type.Optional(Type.Array(PluginNamedCapabilityItemSchema)),
  services: Type.Optional(Type.Array(PluginNamedCapabilityItemSchema)),
  configSchema: Type.Optional(Type.Any())
}, { additionalProperties: false });
export type PluginManifest = Static<typeof PluginManifestSchema>;

export const PluginStateSchema = Type.Union([
  Type.Literal("discovered"),
  Type.Literal("disabled"),
  Type.Literal("invalid_manifest"),
  Type.Literal("incompatible"),
  Type.Literal("config_invalid"),
  Type.Literal("load_failed"),
  Type.Literal("manifest_mismatch"),
  Type.Literal("ready")
]);
export type PluginState = Static<typeof PluginStateSchema>;

export const PluginDiagnosticSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("error")
]);
export type PluginDiagnosticSeverity = Static<typeof PluginDiagnosticSeveritySchema>;

export const PluginDiagnosticSourceSchema = Type.Union([
  Type.Literal("discovery"),
  Type.Literal("manifest"),
  Type.Literal("config"),
  Type.Literal("runtime"),
  Type.Literal("compat")
]);
export type PluginDiagnosticSource = Static<typeof PluginDiagnosticSourceSchema>;

export const PluginDiagnosticCodeSchema = Type.Union([
  Type.Literal("plugin_discovered"),
  Type.Literal("plugin_disabled"),
  Type.Literal("manifest_invalid"),
  Type.Literal("plugin_incompatible"),
  Type.Literal("config_invalid"),
  Type.Literal("entry_not_found"),
  Type.Literal("entry_out_of_root"),
  Type.Literal("entry_extension_unsupported"),
  Type.Literal("plugin_load_failed"),
  Type.Literal("plugin_manifest_mismatch"),
  Type.Literal("tool_name_conflict"),
  Type.Literal("unsupported_capability")
]);
export type PluginDiagnosticCode = Static<typeof PluginDiagnosticCodeSchema>;

export const PluginDiagnosticSchema = Type.Object({
  code: PluginDiagnosticCodeSchema,
  severity: PluginDiagnosticSeveritySchema,
  source: PluginDiagnosticSourceSchema,
  message: Type.String({ minLength: 1 }),
  details: Type.Optional(Type.Any())
});
export type PluginDiagnostic = Static<typeof PluginDiagnosticSchema>;

export const PluginToolRuntimeSnapshotSchema = Type.Object({
  canonicalName: PluginToolCanonicalNameSchema,
  shortName: PluginToolShortNameSchema,
  description: Type.String({ minLength: 1 }),
  enabledForAgent: Type.Optional(Type.Boolean()),
  riskLevel: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]))
});
export type PluginToolRuntimeSnapshot = Static<typeof PluginToolRuntimeSnapshotSchema>;

const PluginNamedRuntimeSnapshotSchema = Type.Object({
  name: Type.String({ minLength: 1 })
});

export const AgentPluginSettingsItemSchema = Type.Object({
  id: PluginIdSchema,
  enabled: Type.Boolean(),
  config: Type.Optional(Type.Any())
}, { additionalProperties: false });
export type AgentPluginSettingsItem = Static<typeof AgentPluginSettingsItemSchema>;

export const AgentPluginSettingsSchema = Type.Object({
  plugins: Type.Array(AgentPluginSettingsItemSchema),
  updatedAt: Type.Number()
});
export type AgentPluginSettings = Static<typeof AgentPluginSettingsSchema>;

export const UpdateAgentPluginSettingsRequestSchema = Type.Object({
  plugins: Type.Array(AgentPluginSettingsItemSchema)
}, { additionalProperties: false });
export type UpdateAgentPluginSettingsRequest = Static<typeof UpdateAgentPluginSettingsRequestSchema>;

export const PluginRuntimeSnapshotSchema = Type.Object({
  id: PluginIdSchema,
  path: Type.String({ minLength: 1 }),
  manifest: Type.Union([PluginManifestSchema, Type.Null()]),
  entryPath: Type.Optional(Type.String({ minLength: 1 })),
  enabled: Type.Boolean(),
  state: PluginStateSchema,
  diagnostics: Type.Array(PluginDiagnosticSchema),
  config: Type.Optional(Type.Any()),
  loadedAt: Type.Optional(Type.String({ minLength: 1 })),
  capabilities: Type.Object({
    tools: Type.Optional(Type.Array(PluginToolRuntimeSnapshotSchema)),
    channels: Type.Optional(Type.Array(PluginNamedRuntimeSnapshotSchema)),
    hooks: Type.Optional(Type.Array(PluginNamedRuntimeSnapshotSchema)),
    services: Type.Optional(Type.Array(PluginNamedRuntimeSnapshotSchema))
  })
});
export type PluginRuntimeSnapshot = Static<typeof PluginRuntimeSnapshotSchema>;

export const PluginRuntimeSnapshotsResponseSchema = Type.Object({
  plugins: Type.Array(PluginRuntimeSnapshotSchema),
  updatedAt: Type.Number()
});
export type PluginRuntimeSnapshotsResponse = Static<typeof PluginRuntimeSnapshotsResponseSchema>;
