import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../app/errors.js";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import { runBashCommand } from "./agent.bash.js";
import { buildTextPayload } from "./agent.text.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentQueuedRun, AgentService } from "./agent.service.js";
import { findRunCreatedEvent, getSessionTimelineEvents, listRunningSessions } from "./agent.store.js";

const DEFAULT_RUNTIME_CONCURRENCY = 2;

type RuntimeQueuedRun = AgentQueuedRun & {
  inputText: string;
  workspacePath: string;
};

export class AgentRuntime implements AgentRuntimePort {
  private readonly queue: RuntimeQueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private activeCount = 0;

  constructor(
    private readonly service: AgentService,
    private readonly logger: FastifyBaseLogger,
    private readonly concurrency = DEFAULT_RUNTIME_CONCURRENCY
  ) {}

  bootstrap() {
    const ctx = this.service.getContext();
    const running = listRunningSessions(ctx.db);
    for (const row of running) {
      if (!row.activeRunId) continue;
      const runCreated = findRunCreatedEvent(ctx.db, {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        runId: row.activeRunId
      });
      if (!runCreated) continue;
      const payload = runCreated.payload as any;
      const messageId = typeof payload?.triggerMessageId === "string" ? payload.triggerMessageId : "";
      if (!messageId) continue;

      const session = this.service.getSession(row.sessionId);
      if (!session) continue;
      const workspace = this.service.getWorkspace(session.workspaceId);
      if (!workspace) continue;
      const timeline = getSessionTimelineEvents(ctx.db, session.workspaceId, session.id);
      const trigger = timeline.find((event) => {
        if (event.type !== "user.message.created") return false;
        const body = event.payload as any;
        return body.messageId === messageId;
      });
      if (!trigger) continue;
      const triggerPayload = trigger.payload as any;
      const text = typeof triggerPayload?.text?.preview === "string" ? triggerPayload.text.preview : "";

      this.enqueueRun({
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        runId: row.activeRunId,
        triggerMessageId: messageId,
        inputText: text,
        workspacePath: workspace.path
      });
    }
  }

  enqueueRun(run: RuntimeQueuedRun) {
    if (this.queuedRunIds.has(run.runId)) return;
    this.queue.push(run);
    this.queuedRunIds.add(run.runId);
    this.pump();
  }

  cancelSession(sessionId: string) {
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.abort();
    }
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      if (!item || item.sessionId !== sessionId) continue;
      this.queuedRunIds.delete(item.runId);
      this.queue.splice(i, 1);
    }
  }

  private pump() {
    while (this.activeCount < this.concurrency) {
      const index = this.queue.findIndex((item) => !this.runningSessions.has(item.sessionId));
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1);
      if (!next) return;
      this.queuedRunIds.delete(next.runId);
      this.startRun(next);
    }
  }

  private startRun(run: RuntimeQueuedRun) {
    this.activeCount += 1;
    this.runningSessions.add(run.sessionId);
    const controller = new AbortController();
    this.controllers.set(run.sessionId, controller);

    void this.processRun(run, controller.signal)
      .catch((err) => {
        this.logger.error({ err, sessionId: run.sessionId, runId: run.runId }, "agent runtime run failed");
      })
      .finally(() => {
        this.controllers.delete(run.sessionId);
        this.runningSessions.delete(run.sessionId);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async processRun(run: RuntimeQueuedRun, signal: AbortSignal) {
    try {
      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "run.started",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          startedAt: nowMs()
        }
      });

      if (signal.aborted) return;

      const turnId = newSortableId("turn");
      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "model.turn.started",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId,
          model: "runtime/bash-v1"
        }
      });

      const text = run.inputText || "";
      const bashPrefix = "/bash ";
      if (!text.startsWith(bashPrefix)) {
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "model.turn.committed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            turnId,
            assistantText: `已收到: ${text}`,
            toolRequests: []
          }
        });
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "run.completed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            finishedAt: nowMs(),
            tokens: { input: 0, output: 0, total: 0 }
          }
        });
        return;
      }

      const command = text.slice(bashPrefix.length).trim();
      if (!command) {
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "run.failed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            error: "empty bash command",
            retryable: false
          }
        });
        return;
      }

      const toolCallId = newSortableId("call");
      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "model.turn.committed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId,
          assistantText: "收到,开始执行 bash 命令。",
          toolRequests: [
            {
              toolCallId,
              toolName: "bash",
              args: { command, workdir: run.workspacePath },
              raw: command
            }
          ]
        }
      });

      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "tool.requested",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId,
          toolCallId,
          toolName: "bash",
          args: { command, workdir: run.workspacePath },
          summary: `执行 bash: ${command}`
        }
      });
      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "tool.running",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          toolCallId,
          startedAt: nowMs()
        }
      });

      const result = await runBashCommand({
        command,
        cwd: run.workspacePath,
        timeoutMs: 120_000,
        maxOutputBytes: 512 * 1024,
        signal
      });
      const resultText = [
        `command: ${command}`,
        `exitCode: ${String(result.code)}`,
        `timedOut: ${result.timedOut ? "true" : "false"}`,
        `outputLimitExceeded: ${result.outputLimitExceeded ? "true" : "false"}`,
        "",
        "stdout:",
        result.stdout,
        "",
        "stderr:",
        result.stderr
      ].join("\n");

      const output = await buildTextPayload({ workspacePath: run.workspacePath, text: resultText });
      if (signal.aborted) return;

      if (result.ok) {
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "tool.completed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            toolCallId,
            finishedAt: nowMs(),
            output,
            summary: "bash 执行完成"
          }
        });
      } else {
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "tool.failed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            toolCallId,
            finishedAt: nowMs(),
            error: result.timedOut ? "bash timeout" : result.outputLimitExceeded ? "bash output limit exceeded" : "bash failed",
            output,
            summary: "bash 执行失败"
          }
        });
      }

      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "model.turn.committed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId: newSortableId("turn"),
          assistantText: result.ok ? "bash 已完成,可查看工具输出。" : "bash 执行失败,请查看工具输出。",
          toolRequests: []
        }
      });
      if (result.ok) {
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "run.completed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            finishedAt: nowMs(),
            tokens: { input: 0, output: 0, total: 0 }
          }
        });
      } else {
        this.service.appendTimelineFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "run.failed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            error: result.timedOut ? "bash timeout" : result.outputLimitExceeded ? "bash output limit exceeded" : "bash failed",
            retryable: false
          }
        });
      }
    } catch (err) {
      if (signal.aborted) {
        this.logger.info({ sessionId: run.sessionId, runId: run.runId }, "agent runtime run aborted");
        return;
      }

      const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
      this.service.appendTimelineFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "run.failed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          error: message,
          retryable: false
        }
      });
    }
  }
}
