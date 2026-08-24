import type { FastifyBaseLogger } from "fastify";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import type { AgentRuntimePort, AgentRuntimeRun, LocalAgentRuntimeExecutionPort } from "./agent.runtime-port.js";

const DEFAULT_RUNTIME_CONCURRENCY = 2;

type RuntimeQueuedRun = AgentRuntimeRun;

export class AgentRuntime implements AgentRuntimePort {
  private readonly queue: RuntimeQueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private activeCount = 0;

  constructor(
    private readonly execution: LocalAgentRuntimeExecutionPort,
    private readonly logger: FastifyBaseLogger,
    private readonly concurrency = DEFAULT_RUNTIME_CONCURRENCY
  ) {}

  bootstrap() {
    // no-op: worker 关闭时仅提供最小本地回退执行
  }

  enqueueRun(run: RuntimeQueuedRun) {
    if (this.queuedRunIds.has(run.runId)) return;
    this.queue.push(run);
    this.queuedRunIds.add(run.runId);
    this.pump();
  }

  cancelSession(sessionId: string) {
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

    void this.processRun(run)
      .catch((err) => {
        this.logger.error({ err, sessionId: run.sessionId, runId: run.runId }, "agent runtime run failed");
      })
      .finally(() => {
        this.runningSessions.delete(run.sessionId);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async processRun(run: RuntimeQueuedRun) {
    const ts = nowMs();
    try {
      const ctx = await this.execution.getPromptContextForRun({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId
      });

      const turnId = newSortableId("turn");
      const assistant = this.execution.appendContextItemFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId,
        step: 1,
        prevId: ctx.headItemId,
        kind: "assistant",
        status: "streaming",
        output: {
          type: "assistant_text",
          text: ""
        },
        createdAt: ts
      });
      if (assistant.item == null) {
        return;
      }

      this.execution.updateRunStateFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "running",
        activeRunId: run.runId,
        activeAssistantItemId: assistant.item.id,
        updatedAt: ts
      });

      const latestUser = [...ctx.messages].reverse().find((item) => item.role === "user")?.content ?? "";
      const text = latestUser ? `本地回退模式已收到: ${latestUser}` : "本地回退模式已执行。";
      await this.execution.updateContextItemFromWorker({
        itemId: assistant.item.id,
        status: "completed",
        output: {
          type: "assistant_text",
          text
        },
        updatedAt: nowMs()
      });
      this.execution.completeRunFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: "completed",
        updatedAt: nowMs()
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.execution.appendContextItemFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: null,
        step: null,
        prevId: this.execution.getSession(run.sessionId)?.headItemId ?? null,
        kind: "system",
        status: "completed",
        output: {
          type: "system_text",
          text: `[run] ${message}`
        },
        createdAt: nowMs()
      });
      this.execution.completeRunFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: "failed",
        updatedAt: nowMs()
      });
    }
  }
}
