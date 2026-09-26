import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Milliseconds = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const NullableMilliseconds = Type.Union([Milliseconds, Type.Null()]);
const NullableId = Type.Union([Id, Type.Null()]);
const Weekday = Type.Integer({ minimum: 0, maximum: 6 });
const Minute = Type.Integer({ minimum: 0, maximum: 59 });
const MinuteOfDay = Type.Integer({ minimum: 0, maximum: 1439 });

export const UtcScheduleSchema = Type.Union([
  StrictObject({ kind: Type.Literal("hourly"), minutesUtc: Type.Array(Minute, { minItems: 1, maxItems: 60 }) }),
  StrictObject({ kind: Type.Literal("daily"), minutesOfDayUtc: Type.Array(MinuteOfDay, { minItems: 1, maxItems: 1440 }) }),
  StrictObject({ kind: Type.Literal("weekly"), slotsUtc: Type.Array(StrictObject({ weekdayUtc: Weekday, minuteOfDayUtc: MinuteOfDay }), { minItems: 1, maxItems: 10080 }) })
]);
export type UtcSchedule = Static<typeof UtcScheduleSchema>;

export const ScheduledTriggerModeSchema = Type.Union([Type.Literal("new_session"), Type.Literal("fork_message")]);
export type ScheduledTriggerMode = Static<typeof ScheduledTriggerModeSchema>;
export const ScheduledExecutionStatusSchema = Type.Union([
  Type.Literal("starting"), Type.Literal("running"), Type.Literal("completed"),
  Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("failed_to_start"), Type.Literal("skipped")
]);
export type ScheduledExecutionStatus = Static<typeof ScheduledExecutionStatusSchema>;
export const ScheduledTriggerTypeSchema = Type.Union([Type.Literal("scheduled"), Type.Literal("manual")]);
export type ScheduledTriggerType = Static<typeof ScheduledTriggerTypeSchema>;
export const ScheduledExecutionReasonCodeSchema = Type.Union([
  Type.Literal("previous_execution_running"), Type.Literal("source_unavailable"),
  Type.Literal("source_anchor_invalid"), Type.Literal("agent_unavailable"),
  Type.Literal("agent_model_unavailable"), Type.Literal("worker_unavailable"),
  Type.Literal("startup_interrupted_before_run"), Type.Literal("workspace_deleting"),
  Type.Literal("session_id_conflict"), Type.Literal("run_cancelled"), Type.Literal("run_failed")
]);
export type ScheduledExecutionReasonCode = Static<typeof ScheduledExecutionReasonCodeSchema>;

export const ScheduledSourceSchema = StrictObject({
  sessionId: Id, messageId: Id, title: Type.String({ maxLength: 200 }),
  messageSummary: Type.String({ maxLength: 1000 }), messageCreatedAt: Milliseconds
});
export type ScheduledSource = Static<typeof ScheduledSourceSchema>;

export const ScheduledExecutionSchema = StrictObject({
  id: Id, taskId: Id, triggerType: ScheduledTriggerTypeSchema,
  scheduledFor: NullableMilliseconds, status: ScheduledExecutionStatusSchema,
  reasonCode: Type.Union([ScheduledExecutionReasonCodeSchema, Type.Null()]),
  reasonMessage: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  sessionId: NullableId, sessionAvailable: Type.Boolean(), runId: NullableId,
  createdAt: Milliseconds, startedAt: NullableMilliseconds, finishedAt: NullableMilliseconds
});
export type ScheduledExecution = Static<typeof ScheduledExecutionSchema>;
export const ScheduledExecutionSummarySchema = ScheduledExecutionSchema;
export type ScheduledExecutionSummary = ScheduledExecution;

export const ScheduledTaskSchema = StrictObject({
  id: Id, workspaceId: Id, name: Type.String({ minLength: 1, maxLength: 200 }), enabled: Type.Boolean(),
  triggerMode: ScheduledTriggerModeSchema, prompt: Type.String({ minLength: 1, maxLength: 20000 }), agentId: Id,
  schedule: UtcScheduleSchema, nextRunAt: NullableMilliseconds,
  source: Type.Union([ScheduledSourceSchema, Type.Null()]),
  activeExecution: Type.Union([ScheduledExecutionSummarySchema, Type.Null()]),
  latestExecution: Type.Union([ScheduledExecutionSummarySchema, Type.Null()]),
  latestScheduledExecution: Type.Union([ScheduledExecutionSummarySchema, Type.Null()]),
  createdAt: Milliseconds, updatedAt: Milliseconds
});
export type ScheduledTask = Static<typeof ScheduledTaskSchema>;

const TaskInputFields = {
  name: Type.String({ minLength: 1, maxLength: 400 }), prompt: Type.String({ minLength: 1, maxLength: 20000 }),
  agentId: Id, schedule: UtcScheduleSchema, triggerMode: ScheduledTriggerModeSchema,
  sourceSessionId: NullableId, sourceMessageId: NullableId
};
export const CreateScheduledTaskRequestSchema = StrictObject({ ...TaskInputFields, enabled: Type.Boolean() });
export type CreateScheduledTaskRequest = Static<typeof CreateScheduledTaskRequestSchema>;
export const ReplaceScheduledTaskRequestSchema = StrictObject(TaskInputFields);
export type ReplaceScheduledTaskRequest = Static<typeof ReplaceScheduledTaskRequestSchema>;
export const ScheduledTaskParamsSchema = StrictObject({ workspaceId: Id, taskId: Id });
export const ScheduledWorkspaceParamsSchema = StrictObject({ workspaceId: Id });
export const ScheduledExecutionParamsSchema = StrictObject({ workspaceId: Id, taskId: Id, executionId: Id });
export const ScheduledEmptyBodySchema = StrictObject({});
export const ScheduledTaskResponseSchema = StrictObject({ task: ScheduledTaskSchema });
export const ScheduledExecutionResponseSchema = StrictObject({ execution: ScheduledExecutionSchema });
export const ValidateScheduledSourceRequestSchema = StrictObject({ sessionId: Id, messageId: Id });
export const ScheduledSourceResponseSchema = StrictObject({ source: ScheduledSourceSchema });
export const ScheduledServerTimeResponseSchema = StrictObject({ now: Milliseconds, protocolVersion: Type.Literal(1) });
export const ScheduledReadyAgentsResponseSchema = StrictObject({ agentIds: Type.Array(Id) });

const Cursor = Type.String({ minLength: 1, maxLength: 4096 });
const Limit = Type.Integer({ minimum: 1, maximum: 100, default: 50 });
export const ScheduledTaskFilterSchema = Type.Union([Type.Literal("all"), Type.Literal("enabled"), Type.Literal("paused")]);
export const ScheduledExecutionResultFilterSchema = Type.Union([
  Type.Literal("all"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("skipped")
]);
export const ScheduledExecutionTriggerFilterSchema = Type.Union([
  Type.Literal("all"), Type.Literal("scheduled"), Type.Literal("manual")
]);
export const ScheduledTaskListQuerySchema = StrictObject({
  status: Type.Optional(ScheduledTaskFilterSchema), q: Type.Optional(Type.String({ maxLength: 200 })),
  cursor: Type.Optional(Cursor), limit: Type.Optional(Limit)
});
export const ScheduledExecutionListQuerySchema = StrictObject({
  result: Type.Optional(ScheduledExecutionResultFilterSchema), triggerType: Type.Optional(ScheduledExecutionTriggerFilterSchema),
  cursor: Type.Optional(Cursor), limit: Type.Optional(Limit)
});
export const ScheduledTaskListResponseSchema = StrictObject({
  items: Type.Array(ScheduledTaskSchema), nextCursor: Type.Union([Cursor, Type.Null()])
});
export const ScheduledExecutionListResponseSchema = StrictObject({
  items: Type.Array(ScheduledExecutionSchema), nextCursor: Type.Union([Cursor, Type.Null()])
});
export const ScheduledTaskCursorSchema = StrictObject({
  v: Type.Literal(1), filter: StrictObject({ status: ScheduledTaskFilterSchema, q: Type.Union([Type.String(), Type.Null()]) }),
  after: StrictObject({ enabled: Type.Union([Type.Literal(0), Type.Literal(1)]), updatedAt: Milliseconds, id: Id })
});
export type ScheduledTaskCursor = Static<typeof ScheduledTaskCursorSchema>;
export const ScheduledExecutionCursorSchema = StrictObject({
  v: Type.Literal(1), filter: StrictObject({ result: ScheduledExecutionResultFilterSchema, triggerType: ScheduledExecutionTriggerFilterSchema }),
  after: StrictObject({ createdAt: Milliseconds, id: Id })
});
export type ScheduledExecutionCursor = Static<typeof ScheduledExecutionCursorSchema>;

export const ScheduledTaskErrorCodeSchema = Type.Union([
  Type.Literal("SCHEDULE_INVALID"), Type.Literal("TASK_TRIGGER_MODE_INVALID"),
  Type.Literal("SOURCE_MESSAGE_INVALID"), Type.Literal("SOURCE_UNAVAILABLE"),
  Type.Literal("SCHEDULED_TASK_NOT_FOUND"), Type.Literal("CURSOR_INVALID"),
  Type.Literal("TASK_EXECUTION_ALREADY_ACTIVE"), Type.Literal("TASK_DELETE_EXECUTION_ACTIVE"),
  Type.Literal("WORKSPACE_DELETING"), Type.Literal("AGENT_NOT_READY"), Type.Literal("SESSION_ID_CONFLICT"),
  Type.Literal("AGENT_WORKER_UNAVAILABLE")
]);
export type ScheduledTaskErrorCode = Static<typeof ScheduledTaskErrorCodeSchema>;
