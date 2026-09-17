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
  private readonly activeRunIds = new Set<string>();
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
    if (this.queuedRunIds.has(run.runId) || this.activeRunIds.has(run.runId)) return;
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

  async cancelSessionAndWait(input: { sessionId: string; timeoutMs: number }): Promise<boolean> {
    this.cancelSession(input.sessionId);
    const deadline = Date.now() + input.timeoutMs;
    while (this.queue.some((run) => run.sessionId === input.sessionId) || this.runningSessions.has(input.sessionId)) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    return true;
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
    this.activeRunIds.add(run.runId);
    this.runningSessions.add(run.sessionId);

    void this.processRun(run)
      .catch((err) => {
        this.logger.error({ err, sessionId: run.sessionId, runId: run.runId }, "agent runtime run failed");
      })
      .finally(() => {
        this.runningSessions.delete(run.sessionId);
        this.activeRunIds.delete(run.runId);
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
      // 本地回退运行时不具备 ToolExecution provider；恢复 continuation 不得越过 queued 工具。
      // 真实 API-managed Worker 会先执行 queued 工具，随后才在模型 step 中消费 continuation。
      if (ctx.pendingTools.length > 0) {
        throw new Error("local fallback cannot recover pending ToolExecution");
      }
      let assistantMessageId = run.resumeAssistantMessageId ?? null;
      if (assistantMessageId) {
        const claim = this.execution.resumeStreamingAssistantFromWorker({
          workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, messageId: assistantMessageId
        });
        if (claim.result !== "updated") return;
      } else {
        assistantMessageId = newSortableId("message");
        this.execution.createStreamingAssistantFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: assistantMessageId,
          createdAt: ts
        });
      }

      const latestUser = [...ctx.messages].reverse().find((item) => item.role === "user")?.content ?? "";
      const text = latestUser ? `本地回退模式已收到: ${latestUser}` : "本地回退模式已执行。";
      this.execution.flushAssistantPartsFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: assistantMessageId,
        parts: [{ id: newSortableId("part"), position: 0, type: "text", text }],
        updatedAt: nowMs()
      });
      this.execution.completeAssistantFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: assistantMessageId,
        executions: [],
        updatedAt: nowMs()
      });
      this.execution.completeRunFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: "completed",
        updatedAt: nowMs()
      });
    } catch {
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
