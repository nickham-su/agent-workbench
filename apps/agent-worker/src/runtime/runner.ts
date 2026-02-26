import { randomBytes } from "node:crypto";
import { runBashCommand } from "./bash.js";
import { AgentApiClient, ApiConflictError } from "./apiClient.js";
import { buildTextPayload } from "./text.js";

function nowMs() {
  return Date.now();
}

function newSortableId(prefix: string) {
  const ts = Date.now().toString(36).padStart(10, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${ts}${random}`;
}

type QueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText: string;
  workspacePath: string;
};

export class AgentRunner {
  private readonly queue: QueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private activeCount = 0;

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly logger: Pick<Console, "info" | "warn" | "error">,
    private readonly concurrency: number
  ) {}

  enqueueRun(run: QueuedRun) {
    if (this.queuedRunIds.has(run.runId)) return;
    this.queue.push(run);
    this.queuedRunIds.add(run.runId);
    this.pump();
  }

  cancelSession(sessionId: string) {
    const controller = this.controllers.get(sessionId);
    if (controller) controller.abort();
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

  private startRun(run: QueuedRun) {
    this.activeCount += 1;
    this.runningSessions.add(run.sessionId);
    const controller = new AbortController();
    this.controllers.set(run.sessionId, controller);

    void this.processRun(run, controller.signal)
      .catch((err) => {
        this.logger.error("worker run failed", err);
      })
      .finally(() => {
        this.controllers.delete(run.sessionId);
        this.runningSessions.delete(run.sessionId);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async append(params: {
    workspaceId: string;
    sessionId: string;
    type: string;
    payload: unknown;
    createdAt?: number;
  }) {
    await this.apiClient.appendTimelineEvent(params);
  }

  private async processRun(run: QueuedRun, signal: AbortSignal) {
    try {
      await this.append({
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
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "model.turn.started",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId,
          model: "worker/bash-v1"
        }
      });

      const text = run.inputText || "";
      const bashPrefix = "/bash ";
      if (!text.startsWith(bashPrefix)) {
        await this.append({
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
        await this.append({
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
        await this.append({
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
      await this.append({
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
      await this.append({
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
      await this.append({
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
        await this.append({
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
        await this.append({
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

      await this.append({
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
        await this.append({
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
        await this.append({
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
        this.logger.info(`run aborted: ${run.sessionId} ${run.runId}`);
        return;
      }
      if (err instanceof ApiConflictError) {
        this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.append({
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
      } catch {
        this.logger.error(`run failed and fallback append failed: ${run.sessionId} ${run.runId} ${message}`);
      }
    }
  }
}

export type EnqueuePayload = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText: string;
  workspacePath: string;
};
