import type { AgentContextToolName } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentToolExecutionStatus } from "@agent-workbench/shared";

export type ToolPromptProjectorContext = {
  toolName: AgentContextToolName;
  status: AgentToolExecutionStatus;
};

export type ToolPromptProjector = {
  projectCallInput: (args: Record<string, unknown>, ctx: ToolPromptProjectorContext) => Record<string, unknown>;
  projectResult: (result: unknown, ctx: ToolPromptProjectorContext) => unknown;
};
