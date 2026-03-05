import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentRuntime } from "./agent.runtime.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { AgentService } from "./agent.service.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import { AgentWorkerProcessManager } from "./agent.worker-manager.js";
import { listRecoverableRuns } from "./agent.store.js";
import { agentWorkerPidPath } from "../../infra/fs/paths.js";

async function enqueueRecoveringRuns(service: AgentService, runtime: AgentRuntimePort) {
  const rows = listRecoverableRuns(service.getContext().db);
  for (const row of rows) {
    const session = service.getSession(row.sessionId);
    if (!session) continue;
    const workspace = service.getWorkspace(session.workspaceId);
    if (!workspace) continue;
    let inputText = "";
    if (row.triggerItemId) {
      const trigger = service.getContextItemById(row.triggerItemId);
      if (trigger?.output.type === "user_text") {
        inputText = trigger.output.text;
      }
    }
    await runtime.enqueueRun({
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      runId: row.runId,
      inputText,
      workspacePath: workspace.path
    });
  }
}

export async function registerAgentModule(app: FastifyInstance, ctx: AppContext) {
  const service = new AgentService(ctx, app.log);

  let runtime: AgentRuntimePort;
  let workerManager: AgentWorkerProcessManager | null = null;
  if (ctx.agentWorkerEnabled) {
    runtime = new AgentWorkerClient({
      workerOrigin: `http://${ctx.agentWorkerHost}:${ctx.agentWorkerPort}`,
      workerSocketPath: ctx.agentWorkerSocketPath,
      internalToken: ctx.agentInternalToken,
      logger: app.log
    });
    workerManager = new AgentWorkerProcessManager({
      repoRoot: ctx.repoRoot,
      workerHost: ctx.agentWorkerHost,
      workerPort: ctx.agentWorkerPort,
      socketPath: ctx.agentWorkerSocketPath,
      workerConcurrency: ctx.agentWorkerConcurrency,
      apiOrigin: ctx.agentApiOrigin,
      internalToken: ctx.agentInternalToken,
      pidFilePath: agentWorkerPidPath(ctx.dataDir),
      logger: app.log
    });
  } else {
    const localRuntime = new AgentRuntime(service, app.log, ctx.agentWorkerConcurrency);
    localRuntime.bootstrap();
    runtime = localRuntime;
  }

  await registerAgentRoutes(app, { service, runtime });

  if (workerManager) {
    await workerManager.start();
    app.addHook("onListen", async () => {
      await enqueueRecoveringRuns(service, runtime);
    });
    app.addHook("onClose", async () => {
      await workerManager?.stop();
    });
  }
}
