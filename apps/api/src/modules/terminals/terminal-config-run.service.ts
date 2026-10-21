import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../app/context.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { createTerminal, type TerminalRuntimeOperations } from "./terminal.service.js";
import { normalizeTerminalConfig, requireTerminalConfig, requireTerminalConfigWorkspace } from "./terminal-config.service.js";

export async function runWorkspaceTerminalConfig(
  ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string, configId: string,
  runtimeOperations?: TerminalRuntimeOperations
) {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
    requireTerminalConfigWorkspace(ctx, workspaceId);
    const config = normalizeTerminalConfig(requireTerminalConfig(ctx, workspaceId, configId));
    // A snapshot, not an association: every request creates an independent terminal.
    return createTerminal(ctx, logger, { workspaceId, startup: { cwd: config.cwd, command: config.command }, runtimeOperations });
  });
}
