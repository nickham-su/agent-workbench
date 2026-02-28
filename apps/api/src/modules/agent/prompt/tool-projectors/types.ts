import type { AgentContextItemStatus, AgentContextToolName } from "@agent-workbench/shared";

export type ToolPromptProjectorContext = {
  toolName: AgentContextToolName;
  status: AgentContextItemStatus;
};

export type ToolPromptProjector = {
  projectCallInput: (args: Record<string, unknown>, ctx: ToolPromptProjectorContext) => Record<string, unknown>;
  projectResult: (result: unknown, ctx: ToolPromptProjectorContext) => unknown;
};
