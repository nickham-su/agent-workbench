import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentRuntime } from "./agent.runtime.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { AgentService } from "./agent.service.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import { AgentWorkerProcessManager } from "./agent.worker-manager.js";
import {
  AgentConflictError,
  appendContextItem,
  failNonTerminalContextItemsByRunId,
  failRunRecordIfInFlight,
  getLatestSessionItemId,
  getSessionHead,
  listInFlightSessionsWithoutActiveRunId,
  listRecoverableRuns,
  setRunStateIdleIfActiveRunMatches,
  setRunStateIdleIfNoActiveRun
} from "./agent.store.js";
import { agentWorkerPidPath } from "../../infra/fs/paths.js";
import { nowMs } from "../../utils/time.js";

async function enqueueRecoveringRuns(service: AgentService, runtime: AgentRuntimePort, logger: FastifyInstance["log"]) {
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
    try {
      await runtime.enqueueRun({
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        runId: row.runId,
        inputText,
        workspacePath: workspace.path
      });
    } catch (err) {
      // recover 模式下，enqueue 失败不应阻塞服务启动。
      logger.warn({ err, sessionId: row.sessionId, runId: row.runId }, "startup recovery mode=recover: enqueue run failed");
    }
  }
}

async function failRecoveringRuns(service: AgentService, logger: FastifyInstance["log"]) {
  const ctx = service.getContext();
  const ts = nowMs();

  try {
    const rows = listRecoverableRuns(ctx.db);
    for (const row of rows) {
      let contextItemChanges = 0;
      let runRecordChanges = 0;
      let runStateChanges = 0;
      try {
        // 1) 终止所有未落终态的 context items（tool/assistant streaming 等），避免 UI 卡在 pending。
        contextItemChanges = failNonTerminalContextItemsByRunId(ctx.db, { runId: row.runId, updatedAt: ts });
      } catch (err) {
        logger.warn({ err, runId: row.runId }, "fail context items failed on startup recovery");
      }

      try {
        // 2) 将 run 置为 failed（仅对 in-flight 状态生效）。
        runRecordChanges = failRunRecordIfInFlight(ctx.db, { runId: row.runId, updatedAt: ts });
        if (runRecordChanges === 0) {
          logger.debug({ runId: row.runId }, "startup recovery: skip failing run record (already terminal or missing)");
        }
      } catch (err) {
        logger.warn({ err, runId: row.runId }, "fail run record failed on startup recovery");
      }

      // 4) 将会话 run-state 重置为 idle（CAS: 仅当 active_run_id 仍是该 run 时才回收）。
      try {
        const appliedItemId = getLatestSessionItemId(ctx.db, row.workspaceId, row.sessionId);
        runStateChanges = setRunStateIdleIfActiveRunMatches(ctx.db, {
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          runId: row.runId,
          updatedAt: ts,
          appliedItemId
        });
        if (runStateChanges === 0) {
          logger.warn(
            { workspaceId: row.workspaceId, sessionId: row.sessionId, runId: row.runId },
            "startup recovery: skip resetting run-state (active run changed or already idle)"
          );
        }
      } catch (err) {
        logger.warn(
          { err, workspaceId: row.workspaceId, sessionId: row.sessionId, runId: row.runId },
          "set run-state idle failed on startup recovery"
        );
      }

      // 3) 追加 system 提示（best-effort）。
      // 仅当本次确实回收了该 run 的 run-state 时才追加，避免误导（例如 active run 已切换）。
      if (runStateChanges > 0 && (contextItemChanges > 0 || runRecordChanges > 0)) {
        const text =
          runRecordChanges > 0
            ? "[run] marked failed on server restart (startup recovery mode: fail)"
            : "[run] cleaned up inflight context on server restart (startup recovery mode: fail)";
        try {
          const head = getSessionHead(ctx.db, row.workspaceId, row.sessionId);
          appendContextItem(ctx.db, {
            workspaceId: row.workspaceId,
            sessionId: row.sessionId,
            runId: row.runId,
            turnId: null,
            step: null,
            prevId: head,
            kind: "system",
            status: "completed",
            boundaryReason: "startup_terminated",
            output: {
              type: "system_text",
              text
            },
            createdAt: ts
          });
        } catch (err) {
          if (!(err instanceof AgentConflictError)) {
            logger.warn({ err, sessionId: row.sessionId, runId: row.runId }, "append startup termination notice failed");
          }
        }
      }
    }

    // 处理脏数据：状态为 running 但 active_run_id 为空的会话。
    const dirtySessions = listInFlightSessionsWithoutActiveRunId(ctx.db);
    for (const sess of dirtySessions) {
      try {
        const appliedItemId = getLatestSessionItemId(ctx.db, sess.workspaceId, sess.sessionId);
        const changes = setRunStateIdleIfNoActiveRun(ctx.db, { ...sess, updatedAt: ts, appliedItemId });
        if (changes > 0) {
          logger.warn({ ...sess }, "startup recovery: reset in-flight session without active runId to idle");
        }
      } catch (err) {
        logger.warn({ err, ...sess }, "startup recovery: reset in-flight session without active runId failed");
      }
    }

    if (rows.length > 0 || dirtySessions.length > 0) {
      logger.warn(
        { runs: rows.length, sessionsWithoutActiveRunId: dirtySessions.length },
        "startup recovery mode=fail: terminated inflight state"
      );
    }
  } catch (err) {
    logger.error({ err }, "startup recovery mode=fail: unexpected error");
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

  // 开发期默认：fail 模式直接在 listen 前完成 DB 清理，避免外部请求进入后出现竞态。
  if (ctx.agentStartupRecoveryMode === "fail") {
    await failRecoveringRuns(service, app.log);
  } else {
    app.addHook("onListen", async () => {
      await enqueueRecoveringRuns(service, runtime, app.log);
    });
  }

  if (!workerManager) return;
  await workerManager.start();
  app.addHook("onClose", async () => {
    await workerManager?.stop();
  });
}
