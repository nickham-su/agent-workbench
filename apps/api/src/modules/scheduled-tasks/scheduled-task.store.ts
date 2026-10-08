import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { Db } from "../../infra/db/db.js";
import { normalizeSchedule, nextRunAt, ScheduledExecutionReasonCodeSchema } from "@agent-workbench/shared";
import type {
  UtcSchedule, ScheduledTask, ScheduledExecution, ScheduledExecutionStatus, ScheduledSource,
  ScheduledTaskCursor, ScheduledExecutionCursor, ScheduledTriggerMode, ScheduledExecutionReasonCode
} from "@agent-workbench/shared";
import { decodeTaskCursor, encodeTaskCursor, decodeExecutionCursor, encodeExecutionCursor } from "./scheduled-cursor.js";

export type TaskConfiguration = {
  name: string; prompt: string; agentId: string; triggerMode: ScheduledTriggerMode;
  schedule: UtcSchedule; source: ScheduledSource | null;
};
export type ExecutionSnapshot = {
  taskName: string; triggerMode: ScheduledTriggerMode; prompt: string; agentId: string;
  sourceSessionId: string | null; sourceMessageId: string | null;
};
export type TaskRow = TaskConfiguration & {
  id: string; workspaceId: string; enabled: boolean; nextRunAt: number | null;
  createdAt: number; updatedAt: number;
};
export type ExecutionRow = Omit<ScheduledExecution, "sessionAvailable"> & { snapshot: ExecutionSnapshot; clientRequestId: string; updatedAt: number };

const TASK_COLUMNS = `id, workspace_id as workspaceId, name, enabled, trigger_mode as triggerMode,
  prompt, agent_id as agentId, schedule_json as scheduleJson, next_run_at as nextRunAt,
  source_session_id as sourceSessionId, source_message_id as sourceMessageId,
  source_title as sourceTitle, source_message_summary as sourceMessageSummary,
  source_message_created_at as sourceMessageCreatedAt, created_at as createdAt, updated_at as updatedAt`;
const EXEC_COLUMNS = `e.id, e.task_id as taskId, e.trigger_type as triggerType, e.scheduled_for as scheduledFor,
  e.status, e.reason_code as reasonCode, e.reason_detail as reasonMessage, e.task_snapshot_json as snapshotJson,
  e.client_request_id as clientRequestId, e.session_id as sessionId, e.run_id as runId,
  e.created_at as createdAt, e.updated_at as updatedAt, e.started_at as startedAt, e.finished_at as finishedAt`;

type RawTask = {
  id: string; workspaceId: string; name: string; enabled: number; triggerMode: ScheduledTriggerMode;
  prompt: string; agentId: string; scheduleJson: string; nextRunAt: number | null;
  sourceSessionId: string | null; sourceMessageId: string | null; sourceTitle: string | null;
  sourceMessageSummary: string | null; sourceMessageCreatedAt: number | null; createdAt: number; updatedAt: number;
};
type RawExecution = Omit<ExecutionRow, "snapshot" | "clientRequestId"> & { snapshotJson: string; clientRequestId: string };
function taskFrom(row: RawTask): TaskRow {
  return {
    id: row.id, workspaceId: row.workspaceId, name: row.name, enabled: row.enabled === 1,
    triggerMode: row.triggerMode, prompt: row.prompt, agentId: row.agentId,
    schedule: normalizeSchedule(JSON.parse(row.scheduleJson)), nextRunAt: row.nextRunAt,
    source: row.sourceSessionId === null ? null : {
      sessionId: row.sourceSessionId, messageId: row.sourceMessageId!, title: row.sourceTitle!,
      messageSummary: row.sourceMessageSummary!, messageCreatedAt: row.sourceMessageCreatedAt!
    }, createdAt: row.createdAt, updatedAt: row.updatedAt
  };
}
function executionFrom(row: RawExecution): ExecutionRow {
  const { snapshotJson, ...rest } = row;
  return { ...rest, snapshot: JSON.parse(snapshotJson) as ExecutionSnapshot };
}
export function toScheduledExecution(db: Db, workspaceId: string, row: ExecutionRow): ScheduledExecution {
  const { snapshot: _snapshot, clientRequestId: _clientRequestId, updatedAt: _updatedAt, ...publicRow } = row;
  // A reserved ID can also be occupied by an unrelated Session in this Workspace.
  // Only Agent's persisted request-to-Run link proves this Session belongs to
  // this execution; a confirmed ID conflict is never a navigable reference.
  const sessionAvailable = row.reasonCode !== "session_id_conflict" && !!row.sessionId &&
    !!db.prepare(`select 1 from agent_client_request r
      join agent_session s on s.id=r.session_id and s.workspace_id=r.workspace_id
      where r.workspace_id=? and r.session_id=? and r.client_request_id=?
        and (? is null or r.run_id=?) limit 1`).get(
      workspaceId, row.sessionId, row.clientRequestId, row.runId, row.runId);
  return { ...publicRow, sessionAvailable };
}
function validatedConfiguration(config: TaskConfiguration): TaskConfiguration {
  const schedule = normalizeSchedule(config.schedule);
  if (!config.name.trim() || !config.prompt.trim() || config.prompt.length > 20_000 || !config.agentId ||
      (config.triggerMode !== "new_session" && config.triggerMode !== "fork_message") ||
      (config.triggerMode === "new_session" && config.source !== null) ||
      (config.triggerMode === "fork_message" && !config.source)) throw new Error("Invalid scheduled task configuration");
  return { ...config, schedule, prompt: config.prompt.trim() };
}
function ensureWorkspaceWritable(db: Db, workspaceId: string): void {
  const row = db.prepare(`select w.id, d.workspace_id as deleting from workspaces w
    left join workspace_deletion d on d.workspace_id = w.id where w.id = ?`).get(workspaceId) as
    { id: string; deleting: string | null } | undefined;
  if (!row) throw new ScheduledStoreError("SCHEDULED_TASK_NOT_FOUND");
  if (row.deleting) throw new ScheduledStoreError("WORKSPACE_DELETING");
}
export class ScheduledStoreError extends Error {
  constructor(readonly code: "SCHEDULED_TASK_NOT_FOUND" | "WORKSPACE_DELETING" | "TASK_EXECUTION_ALREADY_ACTIVE" | "TASK_DELETE_EXECUTION_ACTIVE") {
    super(code);
  }
}
export function readScheduledTask(db: Db, workspaceId: string, taskId: string): TaskRow | null {
  const row = db.prepare(`select ${TASK_COLUMNS} from scheduled_agent_task where workspace_id = ? and id = ?`)
    .get(workspaceId, taskId) as RawTask | undefined;
  return row ? taskFrom(row) : null;
}
function requireTask(db: Db, workspaceId: string, taskId: string): TaskRow {
  const row = readScheduledTask(db, workspaceId, taskId);
  if (!row) throw new ScheduledStoreError("SCHEDULED_TASK_NOT_FOUND");
  return row;
}
export function createScheduledTask(db: Db, input: {
  workspaceId: string; id: string; configuration: TaskConfiguration; enabled: boolean; nowMs: number;
}): TaskRow {
  return db.transaction(() => {
    ensureWorkspaceWritable(db, input.workspaceId);
    const cfg = validatedConfiguration(input.configuration);
    const next = input.enabled ? nextRunAt(cfg.schedule, input.nowMs) : null;
    db.prepare(`insert into scheduled_agent_task (id, workspace_id, name, enabled, trigger_mode, prompt, agent_id,
      schedule_json, next_run_at, source_session_id, source_message_id, source_title, source_message_summary,
      source_message_created_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.workspaceId, cfg.name, input.enabled ? 1 : 0, cfg.triggerMode, cfg.prompt, cfg.agentId,
      JSON.stringify(cfg.schedule), next, cfg.source?.sessionId ?? null, cfg.source?.messageId ?? null,
      cfg.source?.title ?? null, cfg.source?.messageSummary ?? null, cfg.source?.messageCreatedAt ?? null,
      input.nowMs, input.nowMs
    );
    return requireTask(db, input.workspaceId, input.id);
  })();
}
/** Full replacement: non-schedule changes must not shift the next scheduled slot. */
export function replaceScheduledTask(db: Db, input: {
  workspaceId: string; taskId: string; configuration: TaskConfiguration; nowMs: number | (() => number);
}): TaskRow {
  return db.transaction(() => {
    ensureWorkspaceWritable(db, input.workspaceId);
    const previous = requireTask(db, input.workspaceId, input.taskId);
    const cfg = validatedConfiguration(input.configuration);
    const nowMs = typeof input.nowMs === "function" ? input.nowMs() : input.nowMs;
    const next = !previous.enabled ? null : JSON.stringify(previous.schedule) === JSON.stringify(cfg.schedule)
      ? previous.nextRunAt : nextRunAt(cfg.schedule, nowMs);
    db.prepare(`update scheduled_agent_task set name=?, trigger_mode=?, prompt=?, agent_id=?, schedule_json=?,
      next_run_at=?, source_session_id=?, source_message_id=?, source_title=?, source_message_summary=?,
      source_message_created_at=?, updated_at=? where workspace_id=? and id=?`).run(
      cfg.name, cfg.triggerMode, cfg.prompt, cfg.agentId, JSON.stringify(cfg.schedule), next,
      cfg.source?.sessionId ?? null, cfg.source?.messageId ?? null, cfg.source?.title ?? null,
      cfg.source?.messageSummary ?? null, cfg.source?.messageCreatedAt ?? null,
      nowMs, input.workspaceId, input.taskId
    );
    return requireTask(db, input.workspaceId, input.taskId);
  })();
}
export function setScheduledTaskEnabled(db: Db, input: {
  workspaceId: string; taskId: string; enabled: boolean; nowMs: number;
}): TaskRow {
  return db.transaction(() => {
    ensureWorkspaceWritable(db, input.workspaceId);
    const previous = requireTask(db, input.workspaceId, input.taskId);
    if (previous.enabled === input.enabled) return previous;
    db.prepare(`update scheduled_agent_task set enabled=?, next_run_at=?, updated_at=? where id=? and workspace_id=?`)
      .run(input.enabled ? 1 : 0, input.enabled ? nextRunAt(previous.schedule, input.nowMs) : null,
        input.nowMs, input.taskId, input.workspaceId);
    return requireTask(db, input.workspaceId, input.taskId);
  })();
}
export function deleteScheduledTask(db: Db, workspaceId: string, taskId: string): void {
  db.transaction(() => {
    ensureWorkspaceWritable(db, workspaceId);
    requireTask(db, workspaceId, taskId);
    if (db.prepare(`select 1 from scheduled_agent_execution e join scheduled_agent_task t on t.id=e.task_id
      where t.workspace_id=? and e.task_id=? and e.status in ('starting','running') limit 1`).get(workspaceId, taskId)) {
      throw new ScheduledStoreError("TASK_DELETE_EXECUTION_ACTIVE");
    }
    db.prepare("delete from scheduled_agent_task where workspace_id=? and id=?").run(workspaceId, taskId);
  })();
}
export function readScheduledExecution(db: Db, workspaceId: string, executionId: string): ExecutionRow | null {
  const row = db.prepare(`select ${EXEC_COLUMNS} from scheduled_agent_execution e
    join scheduled_agent_task t on t.id=e.task_id where t.workspace_id=? and e.id=?`)
    .get(workspaceId, executionId) as RawExecution | undefined;
  return row ? executionFrom(row) : null;
}
function snapshot(task: TaskRow): ExecutionSnapshot {
  return { taskName: task.name, triggerMode: task.triggerMode, prompt: task.prompt, agentId: task.agentId,
    sourceSessionId: task.source?.sessionId ?? null, sourceMessageId: task.source?.messageId ?? null };
}
function insertExecution(db: Db, task: TaskRow, input: {
  id: string; triggerType: "scheduled" | "manual"; scheduledFor: number | null; status: "starting" | "skipped";
  nowMs: number; sessionId: string | null;
}): ExecutionRow {
  if ((input.status === "skipped") !== (input.sessionId === null) ||
      (input.status === "skipped" && input.triggerType !== "scheduled")) throw new Error("Invalid execution declaration");
  db.prepare(`insert into scheduled_agent_execution (id, task_id, trigger_type, scheduled_for, status,
    reason_code, reason_detail, task_snapshot_json, client_request_id, session_id,
    created_at, updated_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, task.id, input.triggerType, input.scheduledFor, input.status,
      input.status === "skipped" ? "previous_execution_running" : null, null,
      JSON.stringify(snapshot(task)), `scheduled-execution:${input.id}`, input.sessionId,
      input.nowMs, input.nowMs, input.status === "skipped" ? input.nowMs : null
    );
  return readScheduledExecution(db, task.workspaceId, input.id)!;
}
/** A single transaction owns the slot, its immutable snapshot, and the next future slot. */
export function declareScheduledSlot(db: Db, input: {
  workspaceId: string; taskId: string; scheduledFor: number; nowMs: number;
  executionId?: string; sessionId?: string;
}): ExecutionRow | null {
  return db.transaction(() => {
    ensureWorkspaceWritable(db, input.workspaceId);
    const task = requireTask(db, input.workspaceId, input.taskId);
    if (!task.enabled || task.nextRunAt !== input.scheduledFor || input.scheduledFor > input.nowMs) return null;
    const active = db.prepare(`select 1 from scheduled_agent_execution e join scheduled_agent_task t on t.id=e.task_id
      where t.workspace_id=? and e.task_id=? and e.status in ('starting','running') limit 1`)
      .get(input.workspaceId, input.taskId);
    const executionId = input.executionId ?? randomUUID();
    const execution = insertExecution(db, task, {
      id: executionId, triggerType: "scheduled", scheduledFor: input.scheduledFor,
      status: active ? "skipped" : "starting", nowMs: input.nowMs,
      sessionId: active ? null : input.sessionId ?? `sched_${executionId}`
    });
    db.prepare("update scheduled_agent_task set next_run_at=? where workspace_id=? and id=?")
      .run(nextRunAt(task.schedule, input.nowMs), input.workspaceId, task.id);
    return execution;
  })();
}
export function declareManualExecution(db: Db, input: {
  workspaceId: string; taskId: string; nowMs: number; executionId?: string; sessionId?: string;
}): ExecutionRow {
  return db.transaction(() => {
    ensureWorkspaceWritable(db, input.workspaceId);
    const task = requireTask(db, input.workspaceId, input.taskId);
    if (db.prepare(`select 1 from scheduled_agent_execution e join scheduled_agent_task t on t.id=e.task_id
      where t.workspace_id=? and e.task_id=? and e.status in ('starting','running') limit 1`)
      .get(input.workspaceId, input.taskId)) throw new ScheduledStoreError("TASK_EXECUTION_ALREADY_ACTIVE");
    const executionId = input.executionId ?? randomUUID();
    return insertExecution(db, task, { id: executionId, triggerType: "manual",
      scheduledFor: null, status: "starting", nowMs: input.nowMs, sessionId: input.sessionId ?? `sched_${executionId}` });
  })();
}

const TERMINAL = new Set<ScheduledExecutionStatus>(["completed", "failed", "cancelled", "failed_to_start", "skipped"]);
const PRESTART_REASONS = new Set<ScheduledExecutionReasonCode>([
  "source_unavailable", "source_anchor_invalid", "agent_unavailable", "agent_model_unavailable",
  "worker_unavailable", "startup_interrupted_before_run", "workspace_deleting", "session_id_conflict"
]);
/** Persist a classified Run outcome or a definite pre-start failure; Agent Run evidence is checked by the caller. */
export function transitionScheduledExecution(db: Db, input: {
  workspaceId: string; executionId: string; status: Exclude<ScheduledExecutionStatus, "skipped">;
  nowMs: number; runId?: string | null; reasonCode?: ScheduledExecutionReasonCode | null; reasonDetail?: string | null;
  startedAt?: number | null;
}): ExecutionRow | null {
  return db.transaction(() => {
    const prior = readScheduledExecution(db, input.workspaceId, input.executionId);
    if (!prior) return null;
    const runId = input.runId === undefined ? prior.runId : input.runId;
    const startedAt = input.startedAt === undefined ? prior.startedAt : input.startedAt;
    const reasonCode = input.reasonCode === undefined ? prior.reasonCode : input.reasonCode;
    const reasonDetail = input.reasonDetail === undefined ? prior.reasonMessage : input.reasonDetail;
    const isRunTerminal = input.status === "completed" || input.status === "failed" || input.status === "cancelled";
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < prior.createdAt ||
      TERMINAL.has(prior.status) || (prior.status === "running" && !isRunTerminal) ||
      (prior.runId !== null && runId !== prior.runId) ||
      (runId !== null && (typeof runId !== "string" || runId.length === 0)) ||
      (prior.startedAt !== null && startedAt !== prior.startedAt) ||
      (startedAt !== null && (!Number.isSafeInteger(startedAt) || startedAt < prior.createdAt || startedAt > input.nowMs)) ||
      (reasonCode !== null && !Value.Check(ScheduledExecutionReasonCodeSchema, reasonCode)) ||
      (reasonDetail !== null && (typeof reasonDetail !== "string" || reasonDetail.length > 500 || /[\x00-\x1f\x7f-\x9f]/.test(reasonDetail))) ||
      (reasonDetail !== null && reasonCode === null) ||
      (isRunTerminal && runId === null) ||
      ((input.status === "running" || input.status === "completed" || input.status === "failed") && startedAt === null) ||
      (input.status === "failed_to_start" && (prior.status !== "starting" || startedAt !== null ||
        !PRESTART_REASONS.has(reasonCode as ScheduledExecutionReasonCode))) ||
      (input.status === "cancelled" && reasonCode !== "run_cancelled") ||
      (input.status === "completed" && reasonCode !== null) ||
      ((input.status === "starting" || input.status === "running") && reasonCode !== null) ||
      (input.status === "failed" && reasonCode !== null && reasonCode !== "run_failed")) {
      throw new Error("Invalid execution transition");
    }
    db.prepare(`update scheduled_agent_execution set status=?, run_id=?, reason_code=?, reason_detail=?,
      started_at=?, finished_at=?, updated_at=? where id=? and task_id in
      (select id from scheduled_agent_task where workspace_id=?)`).run(
      input.status, runId, reasonCode, reasonDetail,
      startedAt, TERMINAL.has(input.status) ? input.nowMs : null, input.nowMs, input.executionId, input.workspaceId
    );
    return readScheduledExecution(db, input.workspaceId, input.executionId)!;
  })();
}

export function listDueScheduledTasks(db: Db, nowMs: number): Array<{ workspaceId: string; taskId: string; scheduledFor: number }> {
  return db.prepare(`select t.workspace_id as workspaceId, t.id as taskId, t.next_run_at as scheduledFor
    from scheduled_agent_task t left join workspace_deletion d on d.workspace_id=t.workspace_id
    where t.enabled=1 and t.next_run_at<=? and d.workspace_id is null
    order by t.next_run_at, t.id`).all(nowMs) as Array<{ workspaceId: string; taskId: string; scheduledFor: number }>;
}
export function listScheduledTasks(db: Db, input: {
  workspaceId: string; status?: "all" | "enabled" | "paused"; q?: string; cursor?: string; limit?: number;
}): { items: ScheduledTask[]; nextCursor: string | null } {
  const status = input.status ?? "all";
  const q = input.q?.trim() || null;
  if (q && [...q].length > 100) throw new Error("Search is too long");
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid limit");
  const filter: ScheduledTaskCursor["filter"] = { status, q };
  const after = input.cursor ? decodeTaskCursor(input.cursor, filter, input.workspaceId).after : null;
  const rows = db.prepare(`select ${TASK_COLUMNS} from scheduled_agent_task
    where workspace_id=@workspaceId
      and (@status='all' or enabled=case when @status='enabled' then 1 else 0 end)
      and (@q is null or instr(lower(name),lower(@q))>0)
      and (@afterId is null or enabled<@afterEnabled
        or (enabled=@afterEnabled and updated_at<@afterUpdatedAt)
        or (enabled=@afterEnabled and updated_at=@afterUpdatedAt and id<@afterId))
    order by enabled desc, updated_at desc, id desc limit @fetchLimit`).all({
      workspaceId: input.workspaceId, status, q, afterId: after?.id ?? null,
      afterEnabled: after?.enabled ?? null, afterUpdatedAt: after?.updatedAt ?? null, fetchLimit: limit + 1
    }) as RawTask[];
  const items = rows.slice(0, limit).map(taskFrom).map((row) => toScheduledTask(db, row));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeTaskCursor({ v: 1, filter, after: {
    enabled: last.enabled ? 1 : 0, updatedAt: last.updatedAt, id: last.id
  } }, input.workspaceId) : null };
}
export function listScheduledExecutions(db: Db, input: {
  workspaceId: string; taskId: string; result?: "all" | "completed" | "failed" | "skipped";
  triggerType?: "all" | "scheduled" | "manual"; cursor?: string; limit?: number;
}): { items: ScheduledExecution[]; nextCursor: string | null } {
  const result = input.result ?? "all";
  const triggerType = input.triggerType ?? "all";
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid limit");
  const filter: ScheduledExecutionCursor["filter"] = { result, triggerType };
  const after = input.cursor ? decodeExecutionCursor(input.cursor, filter, input.workspaceId, input.taskId).after : null;
  const rows = db.prepare(`select ${EXEC_COLUMNS} from scheduled_agent_execution e
    join scheduled_agent_task t on t.id=e.task_id
    where t.workspace_id=@workspaceId and t.id=@taskId
      and (@result='all' or e.status=@result or (@result='failed' and e.status='failed_to_start'))
      and (@triggerType='all' or e.trigger_type=@triggerType)
      and (@afterId is null or e.created_at<@afterCreatedAt
        or (e.created_at=@afterCreatedAt and e.id<@afterId))
    order by e.created_at desc, e.id desc limit @fetchLimit`).all({
      workspaceId: input.workspaceId, taskId: input.taskId, result, triggerType,
      afterId: after?.id ?? null, afterCreatedAt: after?.createdAt ?? null, fetchLimit: limit + 1
    }) as RawExecution[];
  const items = rows.slice(0, limit).map(executionFrom).map((row) => toScheduledExecution(db, input.workspaceId, row));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeExecutionCursor({ v: 1, filter, after: {
    createdAt: last.createdAt, id: last.id
  } }, input.workspaceId, input.taskId) : null };
}
export function toScheduledTask(db: Db, row: TaskRow): ScheduledTask {
  const latest = db.prepare(`select ${EXEC_COLUMNS} from scheduled_agent_execution e
    join scheduled_agent_task t on t.id=e.task_id where t.workspace_id=? and t.id=?
    order by e.created_at desc, e.id desc limit 1`).get(row.workspaceId, row.id) as RawExecution | undefined;
  const latestScheduled = db.prepare(`select ${EXEC_COLUMNS} from scheduled_agent_execution e
    join scheduled_agent_task t on t.id=e.task_id where t.workspace_id=? and t.id=? and e.trigger_type='scheduled'
    order by e.created_at desc, e.id desc limit 1`).get(row.workspaceId, row.id) as RawExecution | undefined;
  const active = db.prepare(`select ${EXEC_COLUMNS} from scheduled_agent_execution e
    join scheduled_agent_task t on t.id=e.task_id where t.workspace_id=? and t.id=?
      and e.status in ('starting','running') limit 1`).get(row.workspaceId, row.id) as RawExecution | undefined;
  const publicExecution = (raw: RawExecution | undefined) => raw
    ? toScheduledExecution(db, row.workspaceId, executionFrom(raw)) : null;
  return { ...row, latestExecution: publicExecution(latest),
    latestScheduledExecution: publicExecution(latestScheduled), activeExecution: publicExecution(active) };
}
