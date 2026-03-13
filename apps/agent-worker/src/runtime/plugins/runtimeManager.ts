import { pathToFileURL } from "node:url";
import type { PluginRuntimeSnapshot } from "@agent-workbench/shared";
import type { AgentApiClient, ExecutionProfile } from "../apiClient.js";
import type { ToolExecutionContext, ToolListContext } from "../tools/types.js";
import {
  isJsonSerializable,
  isPluginToolName,
  parsePluginToolName,
  toPluginToolCanonicalName,
  type ResolvedToolDefinition
} from "../tools/types.js";
import type { LoadedPluginRuntime, PluginDefinition, PluginToolDefinition, PluginToolExecutionResult } from "./types.js";

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
  const toolsRaw = Array.isArray(capabilities.tools) ? capabilities.tools : [];
  const tools: PluginToolDefinition[] = toolsRaw.map((itemRaw, index) => {
    const item = toRecord(itemRaw);
    if (!item) {
      throw new Error(`plugin tool at index ${index} must be an object`);
    }
    const toolName = typeof item.name === "string" ? item.name.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const inputSchema = toRecord(item.inputSchema);
    const execute = item.execute;
    if (!toolName) throw new Error(`plugin tool at index ${index} is missing name`);
    if (!description) throw new Error(`plugin tool '${toolName}' description is required`);
    if (!inputSchema) throw new Error(`plugin tool '${toolName}' inputSchema must be an object`);
    if (typeof execute !== "function") throw new Error(`plugin tool '${toolName}' execute must be a function`);
    const outputMode = item.outputMode;
    const riskLevel = item.riskLevel;
    return {
      name: toolName,
      description,
      inputSchema,
      ...(outputMode === "text" || outputMode === "text+raw" ? { outputMode } : {}),
      ...(riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" ? { riskLevel } : {}),
      execute: execute as PluginToolDefinition["execute"]
    };
  });

  return {
    meta: {
      id,
      name,
      version,
      ...(typeof meta.description === "string" && meta.description.trim() ? { description: meta.description.trim() } : {})
    },
    capabilities: {
      tools
    },
    ...(toRecord(definition.lifecycle) ? { lifecycle: definition.lifecycle as PluginDefinition["lifecycle"] } : {})
  };
}

function resolveModuleDefinition(moduleExports: unknown): PluginDefinition {
  const record = toRecord(moduleExports);
  const candidate = record?.default ?? record?.plugin ?? moduleExports;
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

export class PluginRuntimeManager {
  private readonly runtimeCache = new Map<string, Promise<LoadedPluginRuntime>>();

  constructor(private readonly logger: Pick<Console, "info" | "warn" | "error">) {}

  async getSnapshots(apiClient: AgentApiClient) {
    const response = await apiClient.getPluginRuntimeSnapshots();
    return response.plugins;
  }

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

  private selectSnapshots(profile: ExecutionProfile, snapshots: PluginRuntimeSnapshot[]) {
    const selected = new Set(profile.agent.pluginTools);
    return snapshots.filter((snapshot) => {
      if (!snapshot.enabled || snapshot.state !== "ready" || !snapshot.manifest || !snapshot.entryPath) {
        return false;
      }
      const tools = snapshot.capabilities.tools ?? [];
      return tools.some((tool) => selected.has(tool.canonicalName));
    });
  }

  async listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
    const snapshots = await this.getSnapshots(ctx.apiClient);
    const selected = this.selectSnapshots(ctx.profile, snapshots);
    const tools: ResolvedToolDefinition[] = [];
    for (const snapshot of selected) {
      try {
        const runtime = await this.getLoadedPlugin(snapshot);
        for (const manifestTool of snapshot.capabilities.tools ?? []) {
          if (!ctx.profile.agent.pluginTools.includes(manifestTool.canonicalName)) continue;
          const runtimeTool = runtime.toolMap.get(manifestTool.canonicalName);
          if (!runtimeTool) continue;
          tools.push({
            name: manifestTool.canonicalName,
            description: runtimeTool.description,
            inputSchema: runtimeTool.inputSchema,
            source: "plugin"
          });
        }
      } catch (err) {
        this.logger.warn(`[agent-worker] load plugin failed(${snapshot.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return tools;
  }

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<PluginToolExecutionResult> {
    if (!isPluginToolName(toolName)) {
      throw new Error(`unsupported plugin tool: ${toolName}`);
    }
    if (!ctx.profile.agent.pluginTools.includes(toolName)) {
      throw new Error(`plugin tool is disabled for current agent: ${toolName}`);
    }
    const parsed = parsePluginToolName(toolName);
    if (!parsed) {
      throw new Error(`invalid plugin tool name: ${toolName}`);
    }

    const snapshots = await this.getSnapshots(ctx.apiClient);
    const snapshot = this.selectSnapshots(ctx.profile, snapshots).find((item) => item.id === parsed.pluginId);
    if (!snapshot) {
      throw new Error(`plugin is unavailable: ${parsed.pluginId}`);
    }

    const runtime = await this.getLoadedPlugin(snapshot);
    const runtimeTool = runtime.toolMap.get(toolName);
    if (!runtimeTool) {
      throw new Error(`plugin tool is unavailable: ${toolName}`);
    }

    const result = await runtimeTool.execute(args, ctx);
    const value = toRecord(result);
    if (!value || typeof value.text !== "string") {
      throw new Error(`plugin tool '${toolName}' must return { text: string, raw?: JsonSerializable }`);
    }
    const raw = value.raw;
    if (raw !== undefined && !isJsonSerializable(raw)) {
      throw new Error(`plugin tool '${toolName}' raw must be JSON-serializable`);
    }
    return {
      text: value.text,
      ...(raw === undefined ? {} : { raw: raw as PluginToolExecutionResult["raw"] })
    };
  }
}
