import Ajv from "ajv";
import type { Db } from "../infra/db/db.js";
import { listPluginRuntimeSnapshots } from "../modules/plugins/plugin.service.js";
import { HttpError } from "../app/errors.js";
import { getWorkspace } from "../modules/workspaces/workspace.store.js";
import type {
  PluginRuntimeSnapshot,
  PluginToolCanonicalName,
  PluginToolRpcExecuteRequest,
  PluginToolRpcExecuteResponse,
  PluginToolRpcListItem,
  PluginToolRpcListRequest,
  PluginToolRpcListResponse
} from "@agent-workbench/shared";
import { PluginRuntimeManager } from "./workerCompat/runtimeManager.js";

const ajv = new Ajv({ allErrors: true, strict: false });

function toRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function isPluginToolName(toolName: string) {
  return /^plugin_([a-z0-9][a-z0-9-]{0,63})_([A-Za-z][A-Za-z0-9_-]{0,63})$/.test(toolName);
}

function parsePluginToolName(toolName: string): { pluginId: string; shortName: string } | null {
  const match = /^plugin_([a-z0-9][a-z0-9-]{0,63})_([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(toolName);
  if (!match) return null;
  return { pluginId: match[1] ?? "", shortName: match[2] ?? "" };
}

function normalizeToolFilter(input: PluginToolRpcListRequest): { includeAll: boolean; names: Set<string> | null } {
  const includeAll = input?.includeAll === true;
  const toolNames = Array.isArray(input?.toolNames) ? input.toolNames : null;
  if (includeAll || !toolNames) return { includeAll, names: null };
  const names = new Set<string>();
  for (const name of toolNames) {
    if (typeof name === "string" && name.trim()) names.add(name.trim());
  }
  return { includeAll, names };
}

export function createPluginToolsRuntime(params: { db: Db; dataDir: string; repoRoot: string }) {
  const runtimeManager = new PluginRuntimeManager(console);

  async function getSnapshots(): Promise<{ updatedAt: number; plugins: PluginRuntimeSnapshot[] }> {
    try {
      const res = await listPluginRuntimeSnapshots({
        db: params.db,
        dataDir: params.dataDir,
        repoRoot: params.repoRoot
      } as any);
      return { updatedAt: res.updatedAt, plugins: res.plugins };
    } catch (err) {
      const code = (err as any)?.code;
      if (code === "SQLITE_BUSY") {
        throw new HttpError(503, "database is busy", "SQLITE_BUSY");
      }
      throw err;
    }
  }

  return {
    async listTools(bodyRaw: unknown): Promise<PluginToolRpcListResponse> {
      const body = (bodyRaw ?? {}) as PluginToolRpcListRequest;
      const { names } = normalizeToolFilter(body);

      const snapshots = await getSnapshots();
      const tools: PluginToolRpcListItem[] = [];
      for (const plugin of snapshots.plugins) {
        if (!plugin.enabled || plugin.state !== "ready" || !plugin.manifest || !plugin.entryPath) continue;
        for (const manifestTool of plugin.capabilities.tools ?? []) {
          if (names && !names.has(manifestTool.canonicalName)) continue;
          const parsed = parsePluginToolName(manifestTool.canonicalName);
          if (!parsed) continue;

          // 为了给 worker 提供 inputSchema，需要实际加载 runtime tool。
          try {
            const runtime = await runtimeManager.__internalGetLoadedPluginForHost(plugin);
            const runtimeTool = runtime.toolMap.get(manifestTool.canonicalName);
            if (!runtimeTool) continue;

            tools.push({
              toolName: manifestTool.canonicalName as PluginToolCanonicalName,
              pluginId: plugin.id,
              shortName: manifestTool.shortName,
              description: runtimeTool.description,
              inputSchema: runtimeTool.inputSchema,
              ...(runtimeTool.outputMode ? { outputMode: runtimeTool.outputMode } : {}),
              ...(runtimeTool.riskLevel ? { riskLevel: runtimeTool.riskLevel } : {})
            });
          } catch {
            // load error -> skip; diagnostics already available in snapshots
          }
        }
      }

      tools.sort((a, b) => a.toolName.localeCompare(b.toolName));
      return {
        updatedAt: snapshots.updatedAt,
        tools
      };
    },

    async executeTool(bodyRaw: unknown): Promise<PluginToolRpcExecuteResponse> {
      const body = (bodyRaw ?? {}) as PluginToolRpcExecuteRequest;
      const toolName = typeof body.toolName === "string" ? body.toolName.trim() : "";
      if (!toolName || !isPluginToolName(toolName)) {
        throw new HttpError(400, "invalid toolName", "PLUGIN_TOOL_ARGS_INVALID");
      }
      const allowedToolNames = Array.isArray(body.allowedToolNames)
        ? body.allowedToolNames.filter((item: unknown) => typeof item === "string" && item.trim())
        : [];
      if (allowedToolNames.length === 0) {
        throw new HttpError(400, "allowedToolNames is required", "PLUGIN_TOOL_ARGS_INVALID");
      }
      const args = toRecord(body.args) ?? {};
      const ctx = toRecord(body.ctx);
      const workspaceId = typeof ctx?.workspaceId === "string" ? String(ctx.workspaceId) : "";
      const sessionId = typeof ctx?.sessionId === "string" ? String(ctx.sessionId) : "";
      const runId = typeof ctx?.runId === "string" ? String(ctx.runId) : null;
      const turnId = typeof ctx?.turnId === "string" ? String(ctx.turnId) : null;
      if (!workspaceId || !sessionId) {
        throw new HttpError(400, "ctx.workspaceId/sessionId is required", "PLUGIN_TOOL_ARGS_INVALID");
      }

      const parsed = parsePluginToolName(toolName);
      if (!parsed) {
        throw new HttpError(400, "invalid toolName", "PLUGIN_TOOL_ARGS_INVALID");
      }

      if (!allowedToolNames.includes(toolName)) {
        throw new HttpError(409, "plugin tool is disabled", "PLUGIN_TOOL_DISABLED");
      }

      const snapshots = await getSnapshots();
      const plugin = snapshots.plugins.find((p) => p.id === parsed.pluginId);
      if (!plugin) {
        throw new HttpError(404, "plugin not found", "PLUGIN_TOOL_NOT_FOUND");
      }
      if (!plugin.enabled || plugin.state !== "ready" || !plugin.entryPath || !plugin.manifest) {
        throw new HttpError(404, "plugin not ready", "PLUGIN_NOT_READY");
      }

      // args schema 校验：基于 runtimeTool.inputSchema。
      const runtime = await runtimeManager.__internalGetLoadedPluginForHost(plugin);
      const runtimeTool = runtime.toolMap.get(toolName);
      if (!runtimeTool) {
        throw new HttpError(404, "plugin tool not found", "PLUGIN_TOOL_NOT_FOUND");
      }
      const validate = ajv.compile(runtimeTool.inputSchema as any);
      const ok = validate(args);
      if (!ok) {
        const details = (validate.errors || []).map((e) => `${e.instancePath || "(root)"} ${e.message || "invalid"}`);
        throw new HttpError(400, `invalid args: ${details.join("; ")}`, "PLUGIN_TOOL_ARGS_INVALID");
      }

      try {
        const workspace = getWorkspace(params.db, workspaceId);
        const workspacePath = workspace?.path || "";
        if (!workspacePath) {
          throw new HttpError(404, "workspace not found", "WORKSPACE_NOT_FOUND");
        }
        const result = await runtimeTool.execute(args, {
          // 兼容现有插件工具：传入类似 worker 的 ToolExecutionContext 子集。
          profile: { agent: { pluginTools: [toolName] } } as any,
          run: {
            workspaceId,
            sessionId,
            runId: runId ?? "",
            workspacePath,
            inputText: undefined
          },
          pendingTool: {
            itemId: 0,
            status: "running",
            toolName,
            toolCallId: turnId ? `${turnId}_call_1` : "",
            args
          },
          signal: new AbortController().signal,
          apiClient: null as any,
          processNestedRun: async () => {},
          updateToolItem: async () => {},
          nowMs: () => Date.now(),
          renderToolText: () => ""
        });

        const value = toRecord(result);
        if (!value || typeof value.text !== "string") {
          throw new Error(`plugin tool '${toolName}' must return { text: string, raw?: JsonSerializable }`);
        }
        return {
         text: value.text,
         ...(Object.prototype.hasOwnProperty.call(value, "raw") ? { raw: (value as any).raw } : {})
        };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(500, err instanceof Error ? err.message : String(err), "PLUGIN_TOOL_EXECUTION_FAILED");
      }
    }
  };
}
