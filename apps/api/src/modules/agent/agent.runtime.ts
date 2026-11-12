import { AgentRuntimeRetirementNotifier } from "@agent-workbench/shared/node/agent-runtime-retirement";
import { createHash } from "node:crypto";
import { AGENT_QUEUE_INPUT_POLICY_VERSION } from "@agent-workbench/shared";
import type { AgentInteractiveInputBinding } from "@agent-workbench/shared/internal-contracts/agent-api";
import { randomUUID } from "node:crypto";
import { AgentRunStopRegistry, AgentRuntimeStopError } from "@agent-workbench/shared/node/agent-run-stop";
import type { AgentWorkerStopRunsRequest } from "@agent-workbench/shared/internal-contracts/agent-worker";
import type { FastifyBaseLogger } from "fastify";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import type { AgentRuntimePort, AgentRuntimeRun, LocalAgentRuntimeExecutionPort } from "./agent.runtime-port.js";
import type { LocalAnalyticsProducer } from "./analytics-local-producer.js";

const DEFAULT_RUNTIME_CONCURRENCY = 2;

type RuntimeQueuedRun = AgentRuntimeRun;

export class AgentRuntime implements AgentRuntimePort {
  private readonly queue: RuntimeQueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly activeRunIds = new Set<string>();
  private activeCount = 0;
  private readonly completions = new Set<Promise<void>>();
  private readonly retirements: AgentRuntimeRetirementNotifier;
  private readonly stopRegistry: AgentRunStopRegistry;
  private readonly stopTokens = new Map<string, symbol>();
  get runtimeInstanceId() { return this.stopRegistry.runtimeInstanceId; }

  constructor(
    private readonly execution: LocalAgentRuntimeExecutionPort,
    private readonly logger: FastifyBaseLogger,
    private readonly concurrency = DEFAULT_RUNTIME_CONCURRENCY,
    private readonly analytics?: LocalAnalyticsProducer,
    private readonly runtimeControl?: {
      runtimeInstanceId: string;
      bindingMatches(input: Pick<AgentRuntimeRun,"workspaceId"|"sessionId"|"runId">): boolean;
      admissionAllowed(input: AgentRuntimeRun): boolean;
      onRunQuiescent?(input: Pick<AgentRuntimeRun,"workspaceId"|"sessionId"|"runId">): void | { retired: boolean };
    }
  ) {
    this.stopRegistry = new AgentRunStopRegistry(runtimeControl?.runtimeInstanceId ?? randomUUID());
    this.retirements = new AgentRuntimeRetirementNotifier(async identity => { return this.runtimeControl?.onRunQuiescent?.(identity) ?? { retired: true }; }, () => this.logger.warn("runtime retirement unconfirmed; retrying"));
  }

  bootstrap() {
    // no-op: worker 关闭时仅提供最小本地回退执行
  }

  enqueueRun(run: RuntimeQueuedRun) {
    if (run.runtimeInstanceId && run.runtimeInstanceId !== this.runtimeInstanceId) throw new AgentRuntimeStopError("AGENT_RUNTIME_INSTANCE_MISMATCH");
    if (this.runtimeControl && !this.runtimeControl.admissionAllowed(run)) throw new Error("AGENT_RUNTIME_ADMISSION_CLOSED");
    if (!this.stopRegistry.mayRegister(run.runId)) throw new Error("AGENT_RUNTIME_ADMISSION_CLOSED");
    if (this.queuedRunIds.has(run.runId) || this.activeRunIds.has(run.runId)) return;
    if (this.runtimeControl) this.retirements.reserve({...run,runtimeInstanceId:this.runtimeInstanceId});
    const token = this.stopRegistry.register(run, () => {
      const index = this.queue.findIndex(item => item.runId === run.runId);
      if (index >= 0) { this.queue.splice(index, 1); this.queuedRunIds.delete(run.runId); this.stopRegistry.unregister(run.runId, token!); this.stopTokens.delete(run.runId); this.retirements.releaseUnstarted({...run,runtimeInstanceId:this.runtimeInstanceId}); }
    });
    if (!token) { this.retirements.releaseUnstarted({...run,runtimeInstanceId:this.runtimeInstanceId}); throw new Error("AGENT_RUNTIME_ADMISSION_CLOSED"); }
    this.stopTokens.set(run.runId, token);
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
      const token = this.stopTokens.get(item.runId);
      if (token) this.stopRegistry.complete(item.runId, token);
      this.stopTokens.delete(item.runId);
      this.retirements.releaseUnstarted({...item,runtimeInstanceId:this.runtimeInstanceId});
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

  stopRunsAndWait(request: AgentWorkerStopRunsRequest) {
    return this.stopRegistry.stopRunsAndWait(request, target => this.runtimeControl?.bindingMatches({workspaceId:request.workspaceId,...target}) ?? false);
  }
  get quiescent() { return this.stopRegistry.size === 0; }

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
    if (this.runtimeControl && !this.runtimeControl.admissionAllowed(run)) {
      const queuedToken=this.stopTokens.get(run.runId);
      if(queuedToken) this.stopRegistry.complete(run.runId,queuedToken);
      this.stopTokens.delete(run.runId);
      this.retirements.releaseUnstarted({...run,runtimeInstanceId:this.runtimeInstanceId});
      return;
    }
    const queuedToken = this.stopTokens.get(run.runId);
    const token = queuedToken ? this.stopRegistry.activate(run, queuedToken, () => undefined) : null;
    if (!token) return;
    this.stopTokens.set(run.runId, token);
    this.activeCount += 1;
    this.activeRunIds.add(run.runId);
    this.runningSessions.add(run.sessionId);

    const completion = this.processRun(run)
      .catch((err) => {
        this.logger.error({ err, sessionId: run.sessionId, runId: run.runId }, "agent runtime run failed");
      })
      .finally(() => {
        this.completions.delete(completion);
        this.runningSessions.delete(run.sessionId);
        this.activeRunIds.delete(run.runId);
        this.activeCount -= 1;
        if (this.runtimeControl) this.stopRegistry.complete(run.runId, token);
        else this.stopRegistry.unregister(run.runId, token);
        this.stopTokens.delete(run.runId);
        if (this.runtimeControl) this.retirements.notifyExited({...run,runtimeInstanceId:this.runtimeInstanceId});
        this.pump();
      });
    this.completions.add(completion);
  }

  async drain(timeoutMs = 5_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...this.completions]).then(()=>this.retirements.drain(timeoutMs)),
        new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,timeoutMs));})
      ]);
    } finally {if(timer) clearTimeout(timer);}
  }

  private async processRun(run: RuntimeQueuedRun) {
    const ts = nowMs();
    this.analytics?.emitExecution({ executionId: run.runId, runId: run.runId, runtimeKind: "api_local_fallback", runKind: run.runKind ?? "user", parentRunId: null, queuedAt: ts, startedAt: ts, endedAt: null, endTimeQuality: "unknown", endReason: null }, "execution_started");
    let analyticsEndReason: "completed" | "failed" | "other" = "other";
    try {
      let ctx = await this.execution.getPromptContextForRun({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId
      });
      if (!this.stopRegistry.mayRegister(run.runId)) return;
      // 本地回退运行时不具备 ToolExecution provider；恢复 continuation 不得越过 queued 工具。
      // 真实 API-managed Worker 会先执行 queued 工具，随后才在模型 step 中消费 continuation。
      if (ctx.pendingTools.length > 0) {
        throw new Error("local fallback cannot recover pending ToolExecution");
      }
      let continuation = run.resumeAssistantMessageId ?? null;
      let steps = 0;
      const configuredSteps = Number(process.env.AWB_AGENT_LOOP_MAX_STEPS);
      const maxSteps = Number.isSafeInteger(configuredSteps) && configuredSteps > 0 ? configuredSteps : 128;
      while (this.stopRegistry.mayRegister(run.runId)) {
        const interactive = ctx.interactiveInput?.interactive === true;
        if (steps++ >= maxSteps) {
          this.execution.updateRunNoticeFromWorker({ ...run, runNoticeText: "budget_exhausted", terminalFailure: true, updatedAt: nowMs() });
          throw new Error("local fallback step budget exhausted");
        }
        if (interactive && !continuation) {
          if (!this.execution.prepareInteractiveInputFromWorker || !this.execution.injectInteractiveInputFromWorker || !this.execution.completeInteractiveAssistantFromWorker) throw new Error("interactive fallback capability unavailable");
          const prepared = await this.execution.prepareInteractiveInputFromWorker({ ...run, operationId: newSortableId("queue-prepare") });
          if (!this.stopRegistry.mayRegister(run.runId)) return;
          if (prepared.decision === "finish") {
            this.execution.convergeRunTerminalFromWorker({ ...run, updatedAt: nowMs() }); analyticsEndReason = "completed"; return;
          }
          if (prepared.decision === "expired") continue;
          if (prepared.decision === "rejected") {
            const reason = prepared.reason === "snapshot_too_large" ? "prepare_snapshot_too_large" : "prepare_cache_capacity";
            this.execution.updateRunNoticeFromWorker({ ...run, runNoticeText: reason, terminalFailure: true, updatedAt: nowMs() });
            throw new Error(reason);
          }
          if (prepared.candidates.length) this.execution.injectInteractiveInputFromWorker({ ...run, operationId: newSortableId("queue-inject"),
            expectedHeadMessageId: prepared.context.headMessageId, expectedRevision: prepared.context.sessionRevision,
            receiptIds: prepared.candidates.map(item => item.receipt.id), preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion });
          ctx = await this.execution.getPromptContextForRun(run);
        }
        let inputBinding: AgentInteractiveInputBinding | undefined = interactive ? { inputReceiptIds: ctx.interactiveInput!.inputReceiptIds,
          effectiveInputPolicyVersion: AGENT_QUEUE_INPUT_POLICY_VERSION, inputRevision: ctx.sessionRevision,
          snapshotHash: createHash("sha256").update(JSON.stringify({ system: ctx.system, messages: ctx.messages, policy: AGENT_QUEUE_INPUT_POLICY_VERSION })).digest("hex") } : undefined;
        const previous = ctx.interactiveInput?.activeAssistantBinding;
        if (inputBinding && previous?.messageId === continuation && previous.inputBinding.snapshotHash === inputBinding.snapshotHash
          && JSON.stringify([...previous.inputBinding.inputReceiptIds].sort()) === JSON.stringify([...inputBinding.inputReceiptIds].sort())) {
          inputBinding = previous.inputBinding;
        }
        let assistantMessageId = continuation;
        continuation = null;
        if (assistantMessageId) {
          const claim = this.execution.resumeStreamingAssistantFromWorker({
            workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, messageId: assistantMessageId, ...(inputBinding ? { inputBinding } : {})
          });
          if (claim.result !== "updated") {
            if (!inputBinding) return;
            const newMessageId = newSortableId("message");
            const replaced = this.execution.replaceStreamingAssistantFromWorker({ ...run, oldMessageId: assistantMessageId, newMessageId,
              inputBinding: { ...inputBinding, mode: "recovery_reprepare" }, runNoticeText: "", retryCount: 0, nextRetryAt: null, createdAt: nowMs() });
            if (replaced.result !== "updated") return;
            assistantMessageId = newMessageId;
          }
        } else {
          assistantMessageId = newSortableId("message");
          this.execution.createStreamingAssistantFromWorker({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            messageId: assistantMessageId,
            ...(inputBinding ? { inputBinding } : {}),
            createdAt: nowMs()
          });
        }

        const content = [...ctx.messages].reverse().find((item) => item.role === "user")?.content ?? "";
        const latestUser = typeof content === "string" ? content : content.map(part =>
          part.type === "text" ? part.text : `[附件：${part.filename}；本地回退仅回显，不执行模型识图]`).join("\n");
        const text = latestUser ? `本地回退模式已收到: ${latestUser}` : "本地回退模式已执行。";
        this.execution.flushAssistantPartsFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: assistantMessageId,
          parts: [{ id: newSortableId("part"), position: 0, type: "text", text }],
          updatedAt: nowMs()
        });
        if (interactive) {
          if (!this.execution.completeInteractiveAssistantFromWorker) throw new Error("interactive fallback completion unavailable");
          const completed = this.execution.completeInteractiveAssistantFromWorker({ ...run, operationId: newSortableId("queue-complete"), messageId: assistantMessageId, responseTotalTokens: null, updatedAt: nowMs() });
          if (completed.decision === "continue") { ctx = await this.execution.getPromptContextForRun(run); continue; }
          this.execution.convergeRunTerminalFromWorker({ ...run, updatedAt: nowMs() }); analyticsEndReason = "completed"; return;
        }
        const completionCode = run.runKind === "subtask" ? "subtask_completed" : "run_completed";
        this.execution.completeTerminalAssistantFromWorker({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: assistantMessageId,
          responseTotalTokens: null,
          intent: { status: "completed", code: completionCode, detail: null },
          updatedAt: nowMs()
        });
        this.execution.convergeRunTerminalFromWorker({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, updatedAt: nowMs() });
        analyticsEndReason = "completed";
        return;
      }
    } catch {
      if (!this.stopRegistry.mayRegister(run.runId)) return;
      analyticsEndReason = "failed";
      const failedCode = run.runKind === "manual_compaction"
        ? "compaction_failed"
        : run.runKind === "subtask"
          ? "subtask_failed"
          : "run_failed";
      this.execution.persistRunTerminalIntentFromWorker({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: "failed", code: failedCode, detail: null,
        updatedAt: nowMs()
      });
      this.execution.convergeRunTerminalFromWorker({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, updatedAt: nowMs() });
    } finally {
      // Even an early resume-claim return must close the Analytics execution
      // interval; Analytics remains observational and never changes the Run.
      this.analytics?.emitExecution({ executionId: run.runId, runId: run.runId, runtimeKind: "api_local_fallback", runKind: run.runKind ?? "user", parentRunId: null, queuedAt: ts, startedAt: ts, endedAt: nowMs(), endTimeQuality: "observed", endReason: analyticsEndReason }, "execution_finished");
    }
  }
}
