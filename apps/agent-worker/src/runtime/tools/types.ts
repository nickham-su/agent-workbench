import type { PluginToolCanonicalName } from "@agent-workbench/shared";
import type { AgentApiClient, ExecutionProfile, PromptContext } from "../apiClient.js";

export type ToolSource = "builtin" | "mcp" | "plugin";

export type ResolvedToolDefinition = {
  /** 工具名：系统内部、provider、历史消息统一使用的 provider-safe canonical name */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: ToolSource;
};

export type ToolListContext = {
  profile: ExecutionProfile;
  promptContext: PromptContext;
  apiClient: AgentApiClient;
};

export type AvailableToolContext = ToolListContext & {
  availableToolNames: ReadonlySet<string>;
};

export type PendingToolExecution = {
  itemId: number;
  status: "queued" | "running" | "streaming" | "completed" | "failed" | "cancelled";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
};

export type QueuedRunContext = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
};

export type NestedRunContext = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
};

export type ToolTextRenderInput = {
  toolName: string;
  status: "running" | "completed" | "failed";
  headers?: Array<[string, string]>;
  body?: string;
};

export type ToolExecutionContext = {
  profile: ExecutionProfile;
  run: QueuedRunContext;
  pendingTool: PendingToolExecution;
  signal: AbortSignal;
  apiClient: AgentApiClient;
  promptContext: PromptContext;
  processNestedRun: (run: NestedRunContext, signal: AbortSignal) => Promise<void>;
  updateToolItem: (params: { status: "running" | "completed" | "failed"; output: Record<string, unknown> }) => Promise<void>;
  nowMs: () => number;
  reportRunningOutput?: (patch: { text?: string; result?: unknown }) => Promise<void>;
  renderToolText: (input: ToolTextRenderInput) => string;
};

export interface ToolProvider {
  canHandle(toolName: string): boolean;
  listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]>;
  isToolEnabled(toolName: string, ctx: AvailableToolContext | ToolExecutionContext): boolean | Promise<boolean>;
  execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown>;
}

export const BUILTIN_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "apply_patch",
  "scratchpad",
  "todolist",
  "subtask",
  "archive_search",
  "skill",
  "archive_read",
  "visual_analyze"
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export function isBuiltinToolName(toolName: string): toolName is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function isMcpToolName(toolName: string) {
  return toolName.startsWith("mcp_");
}

const PLUGIN_TOOL_NAME_RE = /^plugin_([a-z0-9][a-z0-9-]{0,63})_([A-Za-z][A-Za-z0-9_-]{0,63})$/;

export function isPluginToolName(toolName: string): toolName is PluginToolCanonicalName {
  return PLUGIN_TOOL_NAME_RE.test(toolName);
}

export function parsePluginToolName(toolName: string): { pluginId: string; toolName: string } | null {
  const match = PLUGIN_TOOL_NAME_RE.exec(toolName);
  if (!match) return null;
  return {
    pluginId: match[1] ?? "",
    toolName: match[2] ?? ""
  };
}

export function toPluginToolCanonicalName(pluginId: string, toolName: string): PluginToolCanonicalName {
  return `plugin_${pluginId}_${toolName}`;
}

export function isJsonSerializable(value: unknown): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => isJsonSerializable(item));
  if (kind === "object") {
    return Object.values(value as Record<string, unknown>).every((item) => isJsonSerializable(item));
  }
  return false;
}
