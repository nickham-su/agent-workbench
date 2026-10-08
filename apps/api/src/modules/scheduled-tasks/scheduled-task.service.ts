import { randomUUID } from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import type { AgentService } from "../agent/agent.service.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import { findMessageClientRequestDedup, getRunRecord } from "../agent/agent-message.store.js";
import { buildScheduledExecutionSessionTitle, normalizeScheduledTaskName } from "../agent/session/session-title.js";
import { getWorkspaceEnabledAgentIds } from "../workspaces/workspace.service.js";
import { getAgentSettings, resolveExecutionProfile } from "../settings/settings.service.js";
import type { CreateScheduledTaskRequest, ReplaceScheduledTaskRequest, ScheduledExecutionReasonCode } from "@agent-workbench/shared";
import { normalizeSchedule, nextRunAt } from "@agent-workbench/shared";
import {
  createScheduledTask, replaceScheduledTask, readScheduledTask, toScheduledTask,
  setScheduledTaskEnabled, deleteScheduledTask, listScheduledTasks, listScheduledExecutions,
  declareManualExecution, declareScheduledSlot, transitionScheduledExecution,
  readScheduledExecution, listDueScheduledTasks, toScheduledExecution, ScheduledStoreError
} from "./scheduled-task.store.js";
import type { TaskConfiguration, ExecutionRow } from "./scheduled-task.store.js";

export type ScheduledRunReferenceDiagnostic = {
  executionId: string;
  reason: "run_reference_conflict" | "run_reference_missing" | "run_reference_query_failed";
};

export class ScheduledTaskService {
  private readonly unresolved = new Set<string>();
  constructor(private readonly ctx: AppContext, private readonly agent: AgentService,
    private readonly runtime: AgentRuntimePort, private readonly now: () => number = Date.now,
    private readonly onUnresolvedRun: (diagnostic: ScheduledRunReferenceDiagnostic) => void = () => {}) {}

  /** Once per execution/process: keep activity locked until a valid Run is authoritative. */
  private unresolvedRun(execution: ExecutionRow, reason: ScheduledRunReferenceDiagnostic["reason"]): ExecutionRow {
    if (!this.unresolved.has(execution.id)) {
      this.unresolved.add(execution.id);
      try { this.onUnresolvedRun({ executionId: execution.id, reason }); }
      catch { /* diagnostics cannot alter scheduling safety */ }
    }
    return execution;
  }

  /** Advisory choices use the exact same resolver as create/replace/execute. */
  readyAgents(workspaceId: string) {
    this.assertWorkspace(workspaceId);
    const agentIds: string[] = [];
    for (const agent of getAgentSettings(this.ctx).agents) {
      if (agent.scope !== "user" && agent.scope !== "both") continue;
      try { this.readyAgent(workspaceId, agent.id); agentIds.push(agent.id); }
      catch (error) {
        if (!(error instanceof HttpError) || error.code !== "AGENT_NOT_READY") throw error;
      }
    }
    return { agentIds };
  }

  private writable(workspaceId: string) {
    const row = this.ctx.db.prepare(`select w.id, d.workspace_id as deleting from workspaces w
      left join workspace_deletion d on d.workspace_id=w.id where w.id=?`).get(workspaceId) as {id: string; deleting: string | null} | undefined;
    if (!row) throw new HttpError(404, "Task not found", "SCHEDULED_TASK_NOT_FOUND");
    if (row.deleting) throw new HttpError(409, "Workspace is deleting", "WORKSPACE_DELETING");
  }

  private readyAgent(workspaceId: string, agentId: string) {
    try {
      resolveExecutionProfile(this.ctx, {
        surface: "user", requestedAgentId: agentId,
        workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, workspaceId)
      });
    } catch {
      throw new HttpError(422, "Agent or its default model is not ready", "AGENT_NOT_READY");
    }
  }

  private configuration(workspaceId: string, body: ReplaceScheduledTaskRequest): TaskConfiguration {
    const name = normalizeScheduledTaskName(body.name);
    if (!name.ok) throw new HttpError(400, "Invalid task name", "SCHEDULE_INVALID");
    const prompt = body.prompt.trim();
    if (!prompt || [...prompt].length > 20000) throw new HttpError(400, "Invalid prompt", "SCHEDULE_INVALID");
    let schedule: TaskConfiguration["schedule"];
    try { schedule = normalizeSchedule(body.schedule); }
    catch { throw new HttpError(400, "Invalid UTC schedule", "SCHEDULE_INVALID"); }
    this.writable(workspaceId);
    if (body.triggerMode === "new_session") {
      if (body.sourceSessionId !== null || body.sourceMessageId !== null) {
        throw new HttpError(400, "Unexpected source", "TASK_TRIGGER_MODE_INVALID");
      }
    } else if (body.triggerMode === "fork_message") {
      if (!body.sourceSessionId || !body.sourceMessageId) {
        throw new HttpError(400, "Source is required", "TASK_TRIGGER_MODE_INVALID");
      }
    } else {
      throw new HttpError(400, "Invalid trigger mode", "TASK_TRIGGER_MODE_INVALID");
    }
    this.readyAgent(workspaceId, body.agentId);
    const source = body.triggerMode === "fork_message"
      ? this.validateSource(workspaceId, body.sourceSessionId!, body.sourceMessageId!) : null;
    return { name: name.title, prompt, agentId: body.agentId, schedule,
      triggerMode: body.triggerMode, source };
  }

  validateSource(workspaceId: string, sessionId: string, messageId: string) {
    this.assertWorkspace(workspaceId);
    return this.agent.validateHistoricalSource({ workspaceId, sourceSessionId: sessionId,
      targetMessageId: messageId });
  }

  create(workspaceId: string, body: CreateScheduledTaskRequest) {
    const cfg = this.configuration(workspaceId, body);
    return toScheduledTask(this.ctx.db, createScheduledTask(this.ctx.db, {
      workspaceId, id: randomUUID(), configuration: cfg, enabled: body.enabled, nowMs: this.now()
    }));
  }
  replace(workspaceId: string, taskId: string, body: ReplaceScheduledTaskRequest) {
    const cfg = this.configuration(workspaceId, body);
    return toScheduledTask(this.ctx.db, replaceScheduledTask(this.ctx.db, {
      workspaceId, taskId, configuration: cfg, nowMs: this.now
    }));
  }
  read(workspaceId: string, taskId: string) {
    const task = readScheduledTask(this.ctx.db, workspaceId, taskId);
    if (!task) throw new HttpError(404, "Task not found", "SCHEDULED_TASK_NOT_FOUND");
    return toScheduledTask(this.ctx.db, task);
  }
  list(input: Parameters<typeof listScheduledTasks>[1]) {
    if (input.q && [...input.q.trim()].length > 100) throw new HttpError(400, "Search is too long", "SCHEDULE_INVALID");
    return listScheduledTasks(this.ctx.db, input);
  }
  assertWorkspace(workspaceId: string) {
    const row = this.ctx.db.prepare("select 1 from workspaces where id=?").get(workspaceId);
    if (!row) throw new HttpError(404, "Workspace not found", "SCHEDULED_TASK_NOT_FOUND");
  }
  history(input: Parameters<typeof listScheduledExecutions>[1]) {
    this.read(input.workspaceId, input.taskId);
    return listScheduledExecutions(this.ctx.db, input);
  }
  enable(workspaceId: string, taskId: string, enabled: boolean) {
    return toScheduledTask(this.ctx.db, setScheduledTaskEnabled(this.ctx.db, {
      workspaceId, taskId, enabled, nowMs: this.now()
    }));
  }
  delete(workspaceId: string, taskId: string) { deleteScheduledTask(this.ctx.db, workspaceId, taskId); }

  /** A failed/unknown RPC is never proof that the Worker did not accept the run. */
  reconcile(execution: ExecutionRow): ExecutionRow {
    if (execution.status !== "starting" && execution.status !== "running") return execution;
    const workspaceId = this.workspaceFor(execution.taskId);
    let dedup: ReturnType<typeof findMessageClientRequestDedup> = null;
    try {
      dedup = execution.sessionId ? findMessageClientRequestDedup(this.ctx.db, {
        workspaceId, sessionId: execution.sessionId, clientRequestId: execution.clientRequestId
      }) : null;
    } catch { return this.unresolvedRun(execution, "run_reference_query_failed"); }
    // Both links may refer to live work. Without a reconciliation barrier that
    // proves neither Worker Run active, a conflict must keep task mutual exclusion.
    if (execution.runId && dedup && execution.runId !== dedup.runId) {
      return this.unresolvedRun(execution, "run_reference_conflict");
    }
    const runId = execution.runId ?? dedup?.runId;
    if (!runId) {
      this.unresolved.delete(execution.id);
      return execution;
    }
    let run: ReturnType<typeof getRunRecord>;
    try { run = getRunRecord(this.ctx.db, runId); }
    catch { return this.unresolvedRun(execution, "run_reference_query_failed"); }
    if (!run || run.workspaceId !== workspaceId || run.sessionId !== execution.sessionId || run.runKind !== "user") {
      // AgentRuntimePort cannot prove a previously accepted run has stopped.
      // Do not guess a terminal result or free the slot even on startup recovery.
      return this.unresolvedRun(execution, "run_reference_missing");
    }
    this.unresolved.delete(execution.id);
    const nowMs = Math.max(this.now(), execution.createdAt, run.createdAt);
    const base = { workspaceId, executionId: execution.id, nowMs, runId };
    // Agent's enqueue-failure settlement writes this code only for work_pending.
    if ((run.executionPhase === "terminal" && run.terminalResultCode === "run_enqueue_failed") ||
        (run.executionPhase === "terminal_intent_persisted" && run.intendedTerminalCode === "run_enqueue_failed")) {
      return transitionScheduledExecution(this.ctx.db, { ...base, status: "failed_to_start", reasonCode: "worker_unavailable" }) ?? execution;
    }
    const wasStarted = run.executionPhase === "work_in_progress" ||
      run.executionPhase === "terminal";
    if (run.status === "running" || run.executionPhase !== "terminal") {
      if (!wasStarted || run.executionPhase === "terminal_intent_persisted") {
        // Terminal intent has not converged: never claim a terminal state early.
        return execution.status === "running" || execution.runId === runId ? execution :
          transitionScheduledExecution(this.ctx.db, { ...base, status: "starting" }) ?? execution;
      }
      if (execution.status === "running") return execution; // Running is not a transition to itself.
      return transitionScheduledExecution(this.ctx.db, { ...base, status: "running", startedAt: Math.max(execution.createdAt, run.createdAt) }) ?? execution;
    }
    const status = run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed";
    return transitionScheduledExecution(this.ctx.db, { ...base, status, startedAt: Math.max(execution.createdAt, run.createdAt),
      reasonCode: status === "cancelled" ? "run_cancelled" : status === "failed" ? "run_failed" : null }) ?? execution;
  }

  private workspaceFor(taskId: string): string {
    const task = this.ctx.db.prepare("select workspace_id as workspaceId from scheduled_agent_task where id=?")
      .get(taskId) as {workspaceId: string} | undefined;
    if (!task) throw new HttpError(404, "Task not found", "SCHEDULED_TASK_NOT_FOUND");
    return task.workspaceId;
  }

  /** The claim and snapshot are durable before any Agent application call. */
  async execute(execution: ExecutionRow): Promise<ExecutionRow> {
    if (execution.status === "skipped") return execution;
    const workspaceId = this.workspaceFor(execution.taskId);
    if (execution.runId || findMessageClientRequestDedup(this.ctx.db, {
      workspaceId, sessionId: execution.sessionId!, clientRequestId: execution.clientRequestId
    })) return this.reconcile(execution);
    const fail = (reasonCode: ScheduledExecutionReasonCode) => transitionScheduledExecution(this.ctx.db, {
      workspaceId, executionId: execution.id, nowMs: Math.max(this.now(), execution.createdAt),
      status: "failed_to_start", reasonCode
    }) ?? execution;
    try {
      this.writable(workspaceId);
      this.readyAgent(workspaceId, execution.snapshot.agentId);
      const title = buildScheduledExecutionSessionTitle(execution.snapshot.taskName);
      let expectedHistoricalFork: import("../agent/lifecycle/run-lifecycle-ports.js").ExpectedHistoricalForkSession | undefined;
      if (execution.snapshot.triggerMode === "new_session") {
        this.agent.createPrimarySessionWithExpectedId({ workspaceId, sessionId: execution.sessionId!, title });
      } else {
        if (!execution.snapshot.sourceSessionId || !execution.snapshot.sourceMessageId) return fail("source_unavailable");
        const forked = this.agent.forkPrimarySessionFromHistoricalAnchorWithExpectedId({
          workspaceId, sessionId: execution.sessionId!, title,
          sourceSessionId: execution.snapshot.sourceSessionId,
          targetMessageId: execution.snapshot.sourceMessageId
        });
        expectedHistoricalFork = { title, headMessageId: execution.snapshot.sourceMessageId,
          contextRootMessageId: forked.contextRootMessageId, revision: forked.revision,
          sourceSessionId: execution.snapshot.sourceSessionId,
          sourceMessageId: execution.snapshot.sourceMessageId };
      }
      // A deleting fence is rechecked by the Agent RunLifecycle activation transaction.
      const response = await this.agent.sendMessage({ sessionId: execution.sessionId!, body: {
        workspaceId, clientRequestId: execution.clientRequestId, agentId: execution.snapshot.agentId,
        text: execution.snapshot.prompt
      }, runtime: this.runtime, expectedHistoricalFork,
      expectedSessionTitle: execution.snapshot.triggerMode === "new_session" ? title : undefined });
      return this.reconcile(transitionScheduledExecution(this.ctx.db, {
        workspaceId, executionId: execution.id, nowMs: Math.max(this.now(), execution.createdAt),
        status: "starting", runId: response.runId
      }) ?? execution);
    } catch (error) {
      const found = this.reconcile(readScheduledExecution(this.ctx.db, workspaceId, execution.id) ?? execution);
      if (found.runId || findMessageClientRequestDedup(this.ctx.db, {
        workspaceId, sessionId: execution.sessionId!, clientRequestId: execution.clientRequestId
      })) return found; // Unknown acceptance is still an active execution.
      if (error instanceof HttpError && error.code === "AGENT_WORKER_ENQUEUE_UNKNOWN") return found;
      if (error instanceof HttpError && error.code === "WORKSPACE_DELETING") return fail("workspace_deleting");
      if (error instanceof HttpError && error.code === "SESSION_ID_CONFLICT") return fail("session_id_conflict");
      if (error instanceof HttpError && error.code === "SOURCE_UNAVAILABLE") return fail("source_unavailable");
      if (error instanceof HttpError && error.code === "SOURCE_MESSAGE_INVALID") return fail("source_anchor_invalid");
      return fail("agent_unavailable");
    }
  }

  async run(workspaceId: string, taskId: string) {
    const execution = declareManualExecution(this.ctx.db, { workspaceId, taskId, nowMs: this.now() });
    const result = await this.execute(execution);
    if (result.status === "failed_to_start") {
      const reason = result.reasonCode;
      const code = reason === "worker_unavailable" ? "AGENT_WORKER_UNAVAILABLE" :
        reason === "workspace_deleting" ? "WORKSPACE_DELETING" :
        reason === "session_id_conflict" ? "SESSION_ID_CONFLICT" :
        reason === "source_unavailable" ? "SOURCE_UNAVAILABLE" :
        reason === "source_anchor_invalid" ? "SOURCE_MESSAGE_INVALID" : "AGENT_NOT_READY";
      const status = code === "AGENT_NOT_READY" ? 422 :
        code === "AGENT_WORKER_UNAVAILABLE" ? 503 :
        code === "WORKSPACE_DELETING" || code === "SESSION_ID_CONFLICT" ? 409 : 400;
      const error = new HttpError(status, "Task could not start", code) as HttpError & {executionId: string};
      error.executionId = result.id;
      throw error;
    }
    return toScheduledExecution(this.ctx.db, workspaceId, result);
  }

  due(nowMs: number) { return listDueScheduledTasks(this.ctx.db, nowMs); }
  claim(workspaceId: string, taskId: string, scheduledFor: number, nowMs: number) {
    return declareScheduledSlot(this.ctx.db, { workspaceId, taskId, scheduledFor, nowMs });
  }
  /** No history or Agent side effects while catching up after an API restart. */
  silentCatchUp(nowMs: number) {
    const due = listDueScheduledTasks(this.ctx.db, nowMs);
    for (const item of due) {
      this.ctx.db.transaction(() => {
        const task = readScheduledTask(this.ctx.db, item.workspaceId, item.taskId);
        if (!task?.enabled || task.nextRunAt !== item.scheduledFor) return;
        this.ctx.db.prepare("update scheduled_agent_task set next_run_at=? where id=? and workspace_id=? and next_run_at=?")
          .run(nextRunAt(task.schedule, nowMs), task.id, item.workspaceId, item.scheduledFor);
      })();
    }
  }
  active(): Array<{ workspaceId: string; executionId: string }> {
    return this.ctx.db.prepare(`select t.workspace_id as workspaceId, e.id as executionId
      from scheduled_agent_execution e join scheduled_agent_task t on t.id=e.task_id
      where e.status in ('starting','running')`).all() as Array<{ workspaceId: string; executionId: string }>;
  }
  reconcileActive(recover = false) {
    const active = this.active();
    const activeIds = new Set(active.map((item) => item.executionId));
    for (const id of this.unresolved) {
      if (!activeIds.has(id)) this.unresolved.delete(id);
    }
    for (const { workspaceId, executionId } of active) {
      const execution = readScheduledExecution(this.ctx.db, workspaceId, executionId);
      if (!execution) continue;
      const updated = this.reconcile(execution);
      if (recover && updated.status === "starting" && !updated.runId && !this.unresolved.has(executionId)) {
        let dedup: ReturnType<typeof findMessageClientRequestDedup>;
        try {
          dedup = findMessageClientRequestDedup(this.ctx.db, {
            workspaceId, sessionId: updated.sessionId!, clientRequestId: updated.clientRequestId
          });
        } catch {
          this.unresolvedRun(updated, "run_reference_query_failed");
          continue;
        }
        if (!dedup) {
          transitionScheduledExecution(this.ctx.db, { workspaceId, executionId,
            status: "failed_to_start", reasonCode: "startup_interrupted_before_run",
            nowMs: Math.max(this.now(), updated.createdAt) });
        }
      }
    }
  }
}

export function scheduledError(error: unknown): never {
  if (error instanceof ScheduledStoreError) {
    const status = error.code === "SCHEDULED_TASK_NOT_FOUND" ? 404 : error.code === "WORKSPACE_DELETING" ? 409 : 409;
    throw new HttpError(status, error.code, error.code);
  }
  if (error instanceof Error && "code" in error && error.code === "CURSOR_INVALID") {
    throw new HttpError(400, "Invalid cursor", "CURSOR_INVALID");
  }
  throw error;
}
