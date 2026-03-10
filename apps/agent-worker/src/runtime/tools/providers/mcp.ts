import type { McpManager } from "../../mcpManager.js";
import type { AvailableToolContext, ResolvedToolDefinition, ToolExecutionContext, ToolListContext, ToolProvider } from "../types.js";
import { isMcpToolName } from "../types.js";

export class McpToolProvider implements ToolProvider {
  constructor(private readonly mcpManager: McpManager) {}

  canHandle(toolName: string) {
    return isMcpToolName(toolName);
  }

  async listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
    const tools = await this.mcpManager.listTools(ctx.profile.agent.mcpServers);
    return tools.map((item) => ({
      name: item.name,
      description: item.description,
      inputSchema: item.inputSchema,
      source: "mcp" as const
    }));
  }

  isToolEnabled(toolName: string, ctx: AvailableToolContext | ToolExecutionContext) {
    if (!this.canHandle(toolName)) return false;
    if ("availableToolNames" in ctx) {
      return ctx.availableToolNames.has(toolName);
    }
    return true;
  }

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    // TODO(plugin-phase2): 当前 MCP SDK client.callTool 未见显式 AbortSignal 接口；先保留向下透传的扩展点，
    // 待上游 SDK 或本地封装支持取消后继续接入真正的 abort/cancel。
    const result = await this.mcpManager.callTool(toolName, args, { signal: ctx.signal });
    return {
      serverId: result.serverId,
      toolName: result.toolName,
      text: result.text,
      raw: result.raw
    };
  }
}
