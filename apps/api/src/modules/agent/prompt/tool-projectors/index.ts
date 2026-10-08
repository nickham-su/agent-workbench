import type { AgentContextToolName } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentToolExecutionStatus } from "@agent-workbench/shared";
import { defaultToolPromptProjector } from "./default.js";
import { applyPatchToolPromptProjector } from "./apply-patch.js";
import { writeToolPromptProjector } from "./write.js";

const toolPromptProjectorRegistry = new Map<string, typeof defaultToolPromptProjector>([
  ["apply_patch", applyPatchToolPromptProjector],
  ["write", writeToolPromptProjector]
]);

function resolveToolPromptProjector(toolName: AgentContextToolName) {
  return toolPromptProjectorRegistry.get(toolName) ?? defaultToolPromptProjector;
}

export function projectToolCallInputForPrompt(params: {
  toolName: AgentContextToolName;
  status: AgentToolExecutionStatus;
  args: Record<string, unknown>;
}) {
  return resolveToolPromptProjector(params.toolName).projectCallInput(params.args, {
    toolName: params.toolName,
    status: params.status
  });
}

export function projectToolResultForPrompt(params: {
  toolName: AgentContextToolName;
  status: AgentToolExecutionStatus;
  result: unknown;
}) {
  return resolveToolPromptProjector(params.toolName).projectResult(params.result, {
    toolName: params.toolName,
    status: params.status
  });
}
