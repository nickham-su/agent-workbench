import type { PluginRuntimeSnapshot } from "@agent-workbench/shared";

export type JsonSerializable =
  | null
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

export type JsonSchema = Record<string, unknown>;

export type PluginMeta = {
  id: string;
  name: string;
  version: string;
  description?: string;
};

export type PluginToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputMode?: "text" | "text+raw";
  riskLevel?: "low" | "medium" | "high";
  execute: (args: unknown, ctx: unknown) => Promise<PluginToolExecutionResult> | PluginToolExecutionResult;
};

export type PluginToolExecutionResult = {
  text: string;
  raw?: JsonSerializable;
};

export type PluginCapabilities = {
  tools?: PluginToolDefinition[];
  channels?: Array<{ name: string }>;
  hooks?: Array<{ name: string }>;
  services?: Array<{ name: string }>;
};

export type PluginLifecycle = {
  onLoad?: (ctx: unknown) => Promise<void> | void;
  onUnload?: (ctx: unknown) => Promise<void> | void;
};

export type PluginDefinition = {
  meta: PluginMeta;
  capabilities: PluginCapabilities;
  lifecycle?: PluginLifecycle;
};

export type LoadedPluginRuntime = {
  snapshot: PluginRuntimeSnapshot;
  definition: PluginDefinition;
  toolMap: Map<string, PluginToolDefinition>;
};
