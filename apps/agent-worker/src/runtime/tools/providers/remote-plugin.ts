import type {
  AvailableToolContext,
  ResolvedToolDefinition,
  ToolExecutionContext,
  ToolListContext,
  ToolProvider
} from "../types.js";
import { isPluginToolName, parsePluginToolName } from "../types.js";

// Feature flag: 远程插件工具执行链路（API internal routes -> plugin-host）。
// 默认关闭以保持当前行为可回滚。
export const REMOTE_PLUGIN_TOOLS_ENABLED = process.env.AWB_AGENT_REMOTE_PLUGIN_TOOLS === "1";

export class RemotePluginToolProvider implements ToolProvider {
  canHandle(toolName: string) {
    return isPluginToolName(toolName);
  }

  async listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
    // 优先仅拉取当前 agent 允许的工具，避免 payload 过大。
    const toolNames = ctx.profile.agent.pluginTools;
    const response = await ctx.apiClient.listPluginTools({ toolNames, includeAll: false });
    return response.tools.map((tool) => ({
      name: tool.toolName,
      description: tool.description,
      inputSchema: (tool.inputSchema as any) ?? {},
      source: "plugin"
    }));
  }

  isToolEnabled(toolName: string, ctx: AvailableToolContext | ToolExecutionContext) {
    if (!this.canHandle(toolName)) return false;
    if ("availableToolNames" in ctx) {
      return ctx.availableToolNames.has(toolName);
    }
    return ctx.profile.agent.pluginTools.includes(toolName);
  }

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    if (!parsePluginToolName(toolName)) {
      throw new Error(`invalid plugin tool name: ${toolName}`);
    }

    // ToolExecutionContext 目前不直接暴露 turnId；这里用 toolCallId 前缀近似。
    // 约定格式：`${turnId}_call_${n}`，在 worker 的 tool call 生成逻辑中已稳定。
    const toolCallId = String(ctx.pendingTool.toolCallId || "");
    const turnId = toolCallId.includes("_call_") ? toolCallId.split("_call_")[0] : undefined;

    return await ctx.apiClient.executePluginTool({
      toolName,
      args,
      allowedToolNames: ctx.profile.agent.pluginTools,
      ctx: {
        workspaceId: ctx.run.workspaceId,
        sessionId: ctx.run.sessionId,
        ...(ctx.run.runId ? { runId: ctx.run.runId } : {}),
        ...(turnId ? { turnId } : {})
      }
    });
  }
}
