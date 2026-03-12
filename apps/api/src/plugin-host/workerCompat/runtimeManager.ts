import { pathToFileURL } from "node:url";
import type { PluginRuntimeSnapshot } from "@agent-workbench/shared";

type JsonSerializable =
  | null
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

type JsonSchema = Record<string, unknown>;

type PluginToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputMode?: "text" | "text+raw";
  riskLevel?: "low" | "medium" | "high";
  execute: (args: unknown, ctx: unknown) => Promise<{ text: string; raw?: JsonSerializable }> | { text: string; raw?: JsonSerializable };
};

type PluginDefinition = {
  meta: { id: string; name: string; version: string; description?: string };
  capabilities: { tools?: PluginToolDefinition[] };
  lifecycle?: { onLoad?: (ctx: unknown) => Promise<void> | void; onUnload?: (ctx: unknown) => Promise<void> | void };
};

type LoadedPluginRuntime = {
  snapshot: PluginRuntimeSnapshot;
  definition: PluginDefinition;
  toolMap: Map<string, PluginToolDefinition>;
};

function toRecord(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function toPluginDefinition(raw: unknown): PluginDefinition {
  const definition = toRecord(raw);
  if (!definition) {
    throw new Error("plugin module must export an object definition");
  }
  const meta = toRecord(definition.meta);
  if (!meta) {
    throw new Error("plugin.meta is required");
  }
  const id = typeof meta.id === "string" ? meta.id.trim() : "";
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const version = typeof meta.version === "string" ? meta.version.trim() : "";
  if (!id) throw new Error("plugin.meta.id is required");
  if (!name) throw new Error("plugin.meta.name is required");
  if (!version) throw new Error("plugin.meta.version is required");

  const capabilities = toRecord(definition.capabilities) ?? {};
  const toolsRaw = Array.isArray((capabilities as any).tools) ? (capabilities as any).tools : [];
  const tools: PluginToolDefinition[] = toolsRaw.map((itemRaw: unknown, index: number) => {
    const item = toRecord(itemRaw);
    if (!item) {
      throw new Error(`plugin tool at index ${index} must be an object`);
    }
    const toolName = typeof item.name === "string" ? item.name.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const inputSchema = toRecord(item.inputSchema);
    const execute = (item as any).execute;
    if (!toolName) throw new Error(`plugin tool at index ${index} is missing name`);
    if (!description) throw new Error(`plugin tool '${toolName}' description is required`);
    if (!inputSchema) throw new Error(`plugin tool '${toolName}' inputSchema must be an object`);
    if (typeof execute !== "function") throw new Error(`plugin tool '${toolName}' execute must be a function`);
    const outputMode = (item as any).outputMode;
    const riskLevel = (item as any).riskLevel;
    return {
      name: toolName,
      description,
      inputSchema,
      ...(outputMode === "text" || outputMode === "text+raw" ? { outputMode } : {}),
      ...(riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" ? { riskLevel } : {}),
      execute
    };
  });

  return {
    meta: {
      id,
      name,
      version,
      ...(typeof (meta as any).description === "string" && String((meta as any).description).trim()
        ? { description: String((meta as any).description).trim() }
        : {})
    },
    capabilities: {
      tools
    },
    ...(toRecord((definition as any).lifecycle) ? { lifecycle: (definition as any).lifecycle } : {})
  };
}

function resolveModuleDefinition(moduleExports: unknown): PluginDefinition {
  const record = toRecord(moduleExports);
  const candidate = (record as any)?.default ?? (record as any)?.plugin ?? moduleExports;
  return toPluginDefinition(candidate);
}

function validateRuntimeAgainstManifest(snapshot: PluginRuntimeSnapshot, definition: PluginDefinition) {
  const manifest = snapshot.manifest;
  if (!manifest) {
    throw new Error("plugin manifest is missing");
  }
  if (definition.meta.id !== manifest.id) {
    throw new Error(`plugin meta.id mismatch: expected '${manifest.id}', got '${definition.meta.id}'`);
  }
  if (definition.meta.version !== manifest.version) {
    throw new Error(`plugin meta.version mismatch: expected '${manifest.version}', got '${definition.meta.version}'`);
  }
  const declared = new Set((manifest.tools ?? []).map((item) => item.name));
  const seen = new Set<string>();
  for (const tool of definition.capabilities.tools ?? []) {
    if (seen.has(tool.name)) {
      throw new Error(`plugin runtime declared duplicate tool '${tool.name}'`);
    }
    seen.add(tool.name);
    if (!declared.has(tool.name)) {
      throw new Error(`plugin runtime declared undeclared tool '${tool.name}'`);
    }
  }
}

function buildLoadKey(snapshot: PluginRuntimeSnapshot) {
  return JSON.stringify({
    id: snapshot.id,
    entryPath: snapshot.entryPath ?? null,
    version: snapshot.manifest?.version ?? null,
    config: snapshot.config ?? null
  });
}

function toPluginToolCanonicalName(pluginId: string, toolName: string) {
  return `plugin_${pluginId}_${toolName}`;
}

export class PluginRuntimeManager {
  private readonly runtimeCache = new Map<string, Promise<LoadedPluginRuntime>>();

  constructor(private readonly logger: Pick<Console, "info" | "warn" | "error">) {}

  private async loadPlugin(snapshot: PluginRuntimeSnapshot): Promise<LoadedPluginRuntime> {
    if (!snapshot.entryPath) {
      throw new Error(`plugin entryPath missing: ${snapshot.id}`);
    }
    const moduleUrl = pathToFileURL(snapshot.entryPath).href;
    const moduleExports = await import(moduleUrl);
    const definition = resolveModuleDefinition(moduleExports);
    validateRuntimeAgainstManifest(snapshot, definition);
    const toolMap = new Map<string, PluginToolDefinition>();
    for (const tool of definition.capabilities.tools ?? []) {
      toolMap.set(toPluginToolCanonicalName(snapshot.id, tool.name), tool);
    }
    return {
      snapshot,
      definition,
      toolMap
    };
  }

  private async getLoadedPlugin(snapshot: PluginRuntimeSnapshot) {
    const key = buildLoadKey(snapshot);
    const existing = this.runtimeCache.get(key);
    if (existing) {
      return await existing;
    }
    const pending = this.loadPlugin(snapshot).catch((err) => {
      this.runtimeCache.delete(key);
      throw err;
    });
    this.runtimeCache.set(key, pending);
    return await pending;
  }

  // plugin-host 专用：暴露给 toolsRuntime 使用。
  async __internalGetLoadedPluginForHost(snapshot: PluginRuntimeSnapshot) {
    try {
      return await this.getLoadedPlugin(snapshot);
    } catch (err) {
      this.logger.warn(`[agent-plugin-host] load plugin failed(${snapshot.id}): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
