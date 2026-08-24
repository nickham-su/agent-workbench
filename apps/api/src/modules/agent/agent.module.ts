import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentRuntime } from "./agent.runtime.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { createAgentComposition } from "./agent.composition.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import { AgentWorkerProcessManager } from "./agent.worker-manager.js";
import { agentWorkerPidPath } from "../../infra/fs/paths.js";
import { AgentPluginHostClient } from "./agent.plugin-host-client.js";
import { AgentPluginHostProcessManager } from "./agent.plugin-host-manager.js";
import { AgentRunCompletedEventHub } from "./run-completed-events.js";

export async function registerAgentModule(app: FastifyInstance, ctx: AppContext) {
  const runCompletedEventHub = new AgentRunCompletedEventHub();
  const { service, localRuntimeExecution, startupCoordinator } = createAgentComposition(ctx, app.log, runCompletedEventHub);

  let runtime: AgentRuntimePort;
  let workerManager: AgentWorkerProcessManager | null = null;
  let pluginHostManager: AgentPluginHostProcessManager | null = null;
  let pluginHostClient: AgentPluginHostClient | null = null;

  if (ctx.agentWorkerEnabled) {
    runtime = new AgentWorkerClient({
      workerOrigin: `http://${ctx.agentWorkerHost}:${ctx.agentWorkerPort}`,
      workerSocketPath: ctx.agentWorkerSocketPath,
      internalToken: ctx.agentInternalToken,
      responseValidation: ctx.agentWorkerResponseValidation,
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
      responseValidation: ctx.agentWorkerResponseValidation,
      pidFilePath: agentWorkerPidPath(ctx.dataDir),
      logger: app.log
    });
  } else {
    const localRuntime = new AgentRuntime(localRuntimeExecution, app.log, ctx.agentWorkerConcurrency);
    localRuntime.bootstrap();
    runtime = localRuntime;
  }

  if (ctx.agentPluginHostEnabled) {
    pluginHostClient = new AgentPluginHostClient({
      pluginHostSocketPath: ctx.agentPluginHostSocketPath,
      internalToken: ctx.agentInternalToken,
      logger: app.log
    });
    // pid path 与 worker 复用同目录，避免新增 paths helper。
    const pidFilePath = agentWorkerPidPath(ctx.dataDir).replace("agent-worker.pid", "agent-plugin-host.pid");
    pluginHostManager = new AgentPluginHostProcessManager({
      repoRoot: ctx.repoRoot,
      socketPath: ctx.agentPluginHostSocketPath,
      apiDataDir: ctx.dataDir,
      apiOrigin: ctx.agentApiOrigin,
      internalToken: ctx.agentInternalToken,
      pidFilePath,
      devMode: ctx.version === "test" ? true : undefined,
      logger: app.log
    });
    await pluginHostManager.start();
    app.addHook("onClose", async () => {
      await pluginHostManager?.stop();
    });
  }

  await registerAgentRoutes(app, { service, runtime, internalToken: ctx.agentInternalToken, pluginHost: pluginHostClient, runCompletedEventHub });

  await startupCoordinator.runPreListen();
  startupCoordinator.registerRecoverOnListen(app, runtime);

  if (!workerManager) return;
  await workerManager.start();
  app.addHook("onClose", async () => {
    await workerManager?.stop();
  });
}
