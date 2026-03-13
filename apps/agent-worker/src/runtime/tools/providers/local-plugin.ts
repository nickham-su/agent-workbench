import type { AvailableToolContext, ResolvedToolDefinition, ToolExecutionContext, ToolListContext, ToolProvider } from "../types.js";
import { isPluginToolName } from "../types.js";
import { PluginRuntimeManager } from "../../plugins/runtimeManager.js";

export class LocalPluginToolProvider implements ToolProvider {
  constructor(private readonly runtimeManager: PluginRuntimeManager) {}

  canHandle(toolName: string) {
    return isPluginToolName(toolName);
  }

  async listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
    return await this.runtimeManager.listTools(ctx);
  }

  isToolEnabled(toolName: string, ctx: AvailableToolContext | ToolExecutionContext) {
    if (!this.canHandle(toolName)) return false;
    if ("availableToolNames" in ctx) {
      return ctx.availableToolNames.has(toolName);
    }
    return ctx.profile.agent.pluginTools.includes(toolName);
  }

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    return await this.runtimeManager.execute(toolName, args, ctx);
  }
}
