import { registerAgentMessageQueueRoutes } from "./message-queue/message-queue.routes.js";
import { registerAgentRuntimeReadiness } from "./startup/agent-runtime-readiness.js";
import { randomUUID } from "node:crypto";
import { AgentRuntimeControlStore } from "./runtime-control/runtime-control.store.js";
import { AgentRuntimeControlService } from "./runtime-control/runtime-control.service.js";
import { registerAgentRuntimeControlRoutes } from "./runtime-control/runtime-control.routes.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentRuntime } from "./agent.runtime.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { LocalAnalyticsProducer } from "./analytics-local-producer.js";
import { createAgentComposition } from "./agent.composition.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import { AgentWorkerProcessManager } from "./agent.worker-manager.js";
import { agentWorkerPidPath } from "../../infra/fs/paths.js";
import { AgentPluginHostClient } from "./agent.plugin-host-client.js";
import { AgentPluginHostProcessManager } from "./agent.plugin-host-manager.js";
import { AgentRunCompletedEventHub } from "./run-completed-events.js";
import { registerWorkspaceRuntime, unregisterWorkspaceRuntime } from "./lifecycle/workspace-runtime-registry.js";
import { resumePendingWorkspaceDeletions } from "../workspaces/workspace.service.js";
import { reconcilePendingTerminals } from "../terminals/terminal.service.js";
import { recoverAfterAgentRuntimeReady } from "./agent-runtime-ready.js";
import { ScheduledTaskService } from "../scheduled-tasks/scheduled-task.service.js";
import { ScheduledTaskScheduler } from "../scheduled-tasks/scheduled-task.scheduler.js";
import { registerScheduledTaskRoutes } from "../scheduled-tasks/scheduled-task.routes.js";

export async function registerAgentModule(app: FastifyInstance, ctx: AppContext) {
  const runCompletedEventHub = new AgentRunCompletedEventHub();
  const { service, localRuntimeExecution, startupCoordinator, runtimeHandoffCoordinator, publishCommittedTerminalConvergence, createMessageQueue, dispose } = createAgentComposition(ctx, app.log, runCompletedEventHub);

  let runtime: AgentRuntimePort;
  const ownerApiInstanceId = randomUUID();
  const runtimeReadiness = registerAgentRuntimeReadiness(app);
  const runtimeControlStore = new AgentRuntimeControlStore(ctx.db);
  let runtimeControl: AgentRuntimeControlService;
  let localRuntime: AgentRuntime | null = null;
  let localRuntimeInstanceId: string | null = null;
  let lifecycleOpen = true;
  let closing = false;
  let runtimeRecoveryEpoch = 0;
  let workerManager: AgentWorkerProcessManager | null = null;
  let scheduledScheduler: ScheduledTaskScheduler | null = null;
  let messageQueue: ReturnType<typeof createMessageQueue> | undefined;
  let pluginHostManager: AgentPluginHostProcessManager | null = null;
  let pluginHostClient: AgentPluginHostClient | null = null;

  if (ctx.agentWorkerEnabled) {
    const workerClient = new AgentWorkerClient({
      workerOrigin: `http://${ctx.agentWorkerHost}:${ctx.agentWorkerPort}`,
      workerSocketPath: ctx.agentWorkerSocketPath,
      internalToken: ctx.agentInternalToken,
      responseValidation: ctx.agentWorkerResponseValidation,
      logger: app.log
    });
    runtimeControl = new AgentRuntimeControlService(runtimeControlStore, workerClient, Date.now, publishCommittedTerminalConvergence);
    runtime = runtimeControl;
    workerManager = new AgentWorkerProcessManager({
      repoRoot: ctx.repoRoot,
      dataDir: ctx.dataDir,
      workerHost: ctx.agentWorkerHost,
      workerPort: ctx.agentWorkerPort,
      socketPath: ctx.agentWorkerSocketPath,
      workerConcurrency: ctx.agentWorkerConcurrency,
      apiOrigin: ctx.agentApiOrigin,
      internalToken: ctx.agentInternalToken,
      responseValidation: ctx.agentWorkerResponseValidation,
      pidFilePath: agentWorkerPidPath(ctx.dataDir),
      logger: app.log,
      dispatchAnalyticsSignal: ctx.analyticsSignal,
      diagnoseOutboxCorrupt: ctx.analyticsDiagnostics?.outboxCorrupt,
      onRuntimeStarting: (runtimeInstanceId,processIdentity) => {
        runtimeRecoveryEpoch++;
        runtimeControl.blockAdmission();
        runtimeControlStore.createInstance({runtimeInstanceId,ownerApiInstanceId,runtimeKind:"worker"},processIdentity);
      },
      onRuntimeReady: async (runtimeInstanceId, processIdentity) => {
        const handshake = await workerClient.getRuntimeIdentity();
        if (handshake.runtimeInstanceId !== runtimeInstanceId) throw new Error("AGENT_RUNTIME_INSTANCE_MISMATCH");
        runtimeControlStore.readyInstance(runtimeInstanceId,processIdentity);
        runtimeControl.ready(runtimeInstanceId, false);
      },
      onRuntimeExit: (runtimeInstanceId,evidence) => {
        if (!lifecycleOpen) return;
        if (runtimeControl.currentRuntimeInstanceId === runtimeInstanceId) {
          runtimeRecoveryEpoch++;
          runtimeControl.blockAdmission();
        }
        runtimeControlStore.recordInstanceExit(runtimeInstanceId,ownerApiInstanceId,"child_exit",evidence);
      },
      onReady: async (generation) => {
        if (closing) return;
        const recoveryEpoch = runtimeRecoveryEpoch;
        try {
          runtimeControl.recover();
          await recoverAfterAgentRuntimeReady({
            runtime,
            generation,
            resumeWorkspaceDeletions: () => resumePendingWorkspaceDeletions(ctx, app.log),
            recoverRuns: ({ runtime: readyRuntime, generation: readyGeneration }) =>
              startupCoordinator.recoverWhenRuntimeReady(readyRuntime, readyGeneration),
            reconcileTerminals: () => reconcilePendingTerminals(ctx, app.log),
            logger: app.log,
          });
          await runtimeControl.reconcileStops();
          if (closing || recoveryEpoch !== runtimeRecoveryEpoch) return;
          runtimeControl.openAdmission();
          messageQueue?.openAfterRuntimeRecovery();
          runtimeControl.startReconciler();
          scheduledScheduler?.start();
          runtimeReadiness.complete();
        } catch(error) { runtimeReadiness.fail(error); throw error; }
      },
      });
  } else {
    const localAnalytics = new LocalAnalyticsProducer({ apiOrigin: ctx.agentApiOrigin, internalToken: ctx.agentInternalToken, dataDir: ctx.dataDir, abandonPriorGeneration: ctx.analyticsDiagnostics?.abandonLocalFallbackGeneration, diagnoseOutboxCorrupt: ctx.analyticsDiagnostics?.outboxCorrupt });
    await localAnalytics.start();
    localRuntimeInstanceId = randomUUID();
    runtimeControlStore.createInstance({runtimeInstanceId:localRuntimeInstanceId,ownerApiInstanceId,runtimeKind:"local_fallback"},{pid:process.pid,ownerApiInstanceId});
    const incarnation = localRuntimeInstanceId;
    localRuntime = new AgentRuntime(localRuntimeExecution, app.log, ctx.agentWorkerConcurrency, localAnalytics, {
      runtimeInstanceId:incarnation,
      bindingMatches: run => runtimeControlStore.checkAdmission({...run,runtimeInstanceId:incarnation}).bindingMatches,
      admissionAllowed: run => runtimeControlStore.checkAdmission({...run,runtimeInstanceId:incarnation}).admitted,
      onRunQuiescent: run => { if (!lifecycleOpen) return {retired:false}; const result = runtimeControlStore.retireAdmission({...run,runtimeInstanceId:incarnation}); return result; }
    });
    app.addHook("onClose", async () => { await localAnalytics.close(); });
    localRuntime.bootstrap();
    runtimeControl = new AgentRuntimeControlService(runtimeControlStore,localRuntime,Date.now,publishCommittedTerminalConvergence);
    runtimeControlStore.readyInstance(incarnation,{pid:process.pid,ownerApiInstanceId});
    runtimeControl.ready(incarnation,false);
    runtime = runtimeControl;
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

  messageQueue = createMessageQueue(runtimeControl);
  await registerAgentMessageQueueRoutes(app, { service: messageQueue.service, dataDir: ctx.dataDir });

  await registerAgentRuntimeControlRoutes(app,runtimeControlStore,ctx.agentInternalToken);
  await registerAgentRoutes(app, { service, runtime, internalToken: ctx.agentInternalToken, dataDir: ctx.dataDir, pluginHost: pluginHostClient, runCompletedEventHub });
  const scheduledTasks = new ScheduledTaskService(ctx, service, runtime, Date.now, ({ executionId, reason }) => {
    // No raw Agent errors, Prompt or source content in this bounded diagnostic.
    app.log.warn({ executionId, reason }, "scheduled execution retained active: authoritative state unresolved");
  });
  scheduledScheduler = new ScheduledTaskScheduler(scheduledTasks, Date.now,
    () => app.log.warn("scheduled task tick failed; will retry on the next scan"));
  await registerScheduledTaskRoutes(app, scheduledTasks);
  const workspaceRuntimeRegistration = {
    runtime,
    handoffCoordinator: runtimeHandoffCoordinator,
    settleWorkspaceRunsForDeletion: (workspaceId: string) => service.settleWorkspaceRunsForDeletion(workspaceId),
  };
  registerWorkspaceRuntime(workspaceRuntimeRegistration);
  if (!ctx.agentWorkerEnabled) {
    await resumePendingWorkspaceDeletions(ctx, app.log);
    await reconcilePendingTerminals(ctx, app.log);
  }
  app.addHook("onClose", async () => {
    closing = true;
    // Seal public receipts and internal injection synchronously before awaiting
    // any publisher or runtime. Terminal writeback stays available.
    const queueClosing = messageQueue!.close(1_000);
    runtimeControl.blockAdmission();
    await scheduledScheduler?.stop();
    let queueSettled = await queueClosing;
    await runtimeControl.stopAllForShutdown();
    if (localRuntime) {
      const drained = await localRuntime.drain(1_000);
      if (!drained) {
        if (localRuntimeInstanceId) runtimeControlStore.markInstanceUnknown(localRuntimeInstanceId);
        app.log.warn("waiting for local Agent runtime to drain before releasing application resources");
        // Cancellation/unknown is not an exit proof. A delayed context read
        // can still write back; keep its DB/composition alive until settled.
        while (!await localRuntime.drain(5_000)) { /* retain resources */ }
      }
      await runtimeControl.reconcileStops();
    }
    // An enqueue may only settle after exact cancellation has interrupted it.
    if (!queueSettled) {
      app.log.warn("waiting for Agent queue publishers and scans before releasing application resources");
      while (!queueSettled) queueSettled = await messageQueue!.close(5_000);
    }
    await runtimeControl.close();
    if (workerManager) await workerManager.stop();
    if (localRuntimeInstanceId && localRuntime?.quiescent) runtimeControlStore.recordInstanceExit(localRuntimeInstanceId,ownerApiInstanceId,"local_shutdown",{pid:process.pid,observedAt:Date.now()});
    lifecycleOpen = false;
    unregisterWorkspaceRuntime(workspaceRuntimeRegistration);
    dispose();
  });

  await startupCoordinator.runPreListen();
  // Pre-listen preserves in-flight history and keeps admission closed. Local
  // recovery starts at the same real listening lifecycle as ordinary API work.
  if (!workerManager) {
    app.addHook("onListen", async () => {
      try {
      runtimeControl.recover();
      await startupCoordinator.recoverWhenRuntimeReady(runtime,1);
      await runtimeControl.reconcileStops();
      if (closing) return;
      runtimeControl.openAdmission();
      messageQueue!.openAfterRuntimeRecovery();
      runtimeControl.startReconciler();
      scheduledScheduler?.start();
      runtimeReadiness.complete();
      } catch(error) { runtimeReadiness.fail(error); throw error; }
    });
  }

  if (!workerManager) return;
  try {
    await workerManager.start();
  } catch (error) {
    dispose();
    await workerManager.stop().catch(() => undefined);
    throw error;
  }
}
