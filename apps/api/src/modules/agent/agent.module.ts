import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentRuntime } from "./agent.runtime.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { AgentService } from "./agent.service.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import { AgentWorkerProcessManager } from "./agent.worker-manager.js";
import { agentWorkerPidPath } from "../../infra/fs/paths.js";
import { AgentPluginHostClient } from "./agent.plugin-host-client.js";
import { AgentPluginHostProcessManager } from "./agent.plugin-host-manager.js";
import { AgentRunCompletedEventHub } from "./run-completed-events.js";
import { ArchiveStorage } from "./archive/archive-storage.js";
import { archiveFaultHookFromLegacyTestFaults } from "./archive/archive-fault-hook.js";
import { SqliteCompactionArchivePersistence } from "./archive/sqlite-compaction-archive-persistence.js";
import { ArchiveStartupReconcileApplication } from "./archive/archive-startup-reconcile-application.js";
import { listAgentSessionsForArchiveReconcile } from "./agent.store.js";

export async function registerAgentModule(app: FastifyInstance, ctx: AppContext) {
  const runCompletedEventHub = new AgentRunCompletedEventHub();
  const archiveStorage = new ArchiveStorage({
    dataDir: ctx.dataDir,
    logger: app.log,
    faultHook: archiveFaultHookFromLegacyTestFaults(ctx.agentTestFaults)
  });
  const compactionArchivePersistence = new SqliteCompactionArchivePersistence(ctx.db);
  const service = new AgentService(ctx, app.log, runCompletedEventHub, {
    archiveStorage,
    compactionArchivePersistence
  });

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
    const localRuntime = new AgentRuntime({
      getPromptContextForRun: (params) => service.getPromptContextForRun(params),
      appendContextItemFromWorker: (params) => service.appendContextItemFromWorker(params),
      updateContextItemFromWorker: (params) => service.updateContextItemFromWorker(params),
      updateRunStateFromWorker: (params) => service.updateRunStateFromWorker(params),
      completeRunFromWorker: (params) => service.completeRunFromWorker(params),
      getSession: (sessionId) => service.getSession(sessionId)
    }, app.log, ctx.agentWorkerConcurrency);
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

  await registerAgentRoutes(app, { service, runtime, pluginHost: pluginHostClient, runCompletedEventHub });

  try {
    service.cleanupSubtaskOrphansOnStartup();
  } catch (err) {
    app.log.warn({ err }, "subtask orphan startup scan failed");
  }
  try {
    await new ArchiveStartupReconcileApplication({
      listSessions: () => listAgentSessionsForArchiveReconcile(ctx.db),
      reconcilePendingBestEffort: (params) => archiveStorage.reconcilePendingBestEffort(params),
      logger: app.log
    }).reconcileAllPendingBestEffort();
  } catch (err) {
    app.log.warn({ err }, "archive pending startup reconcile failed");
  }

  // 开发期默认：fail 模式直接在 listen 前完成 DB 清理，避免外部请求进入后出现竞态。
  if (ctx.agentStartupRecoveryMode === "fail") {
    service.failRunsOnStartup();
  } else {
    app.addHook("onListen", async () => {
      await service.recoverRunsOnStartup({ runtime });
    });
  }

  if (!workerManager) return;
  await workerManager.start();
  app.addHook("onClose", async () => {
    await workerManager?.stop();
  });
}
