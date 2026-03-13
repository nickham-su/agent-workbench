import type {
  AvailableToolContext,
  ResolvedToolDefinition,
  ToolExecutionContext,
  ToolListContext,
  ToolProvider
} from "./types.js";

export class ToolRegistry {
  constructor(private readonly providers: ToolProvider[]) {}

  async listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
    const deduped = new Map<string, ResolvedToolDefinition>();
    for (const provider of this.providers) {
      const tools = await provider.listTools(ctx);
      for (const item of tools) {
        deduped.set(item.name, item);
      }
    }

    return [...deduped.values()];
  }

  async isToolEnabled(toolName: string, ctx: AvailableToolContext | ToolExecutionContext): Promise<boolean> {
    const provider = this.providers.find((item) => item.canHandle(toolName));
    if (!provider) return false;
    return await provider.isToolEnabled(toolName, ctx);
  }

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    const provider = this.providers.find((item) => item.canHandle(toolName));
    if (!provider) {
      throw new Error(`unsupported tool: ${toolName}`);
    }
    return await provider.execute(toolName, args, ctx);
  }
}
