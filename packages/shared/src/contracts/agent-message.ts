import { Type, type Static } from "@sinclair/typebox";
import { AgentContextToolNameSchema, AgentImageMediaTypeSchema, AgentSessionKindSchema } from "./agent-primitives.js";

export const AGENT_TIMELINE_TEXT_MAX_LENGTH = 3_000;

const IdSchema = Type.String({ minLength: 1 });
const NullableIdSchema = Type.Union([IdSchema, Type.Null()]);

export const AgentMessageTypeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("system"),
  Type.Literal("compaction"),
  Type.Literal("runtime")
]);
export type AgentMessageType = Static<typeof AgentMessageTypeSchema>;

export const AgentMessageStatusSchema = Type.Union([
  Type.Literal("streaming"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("superseded")
]);
export type AgentMessageStatus = Static<typeof AgentMessageStatusSchema>;

export const AgentMessagePartTypeSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("reasoning"),
  Type.Literal("image"),
  Type.Literal("tool_call")
]);
export type AgentMessagePartType = Static<typeof AgentMessagePartTypeSchema>;

export const AgentToolExecutionStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("unknown")
]);
export type AgentToolExecutionStatus = Static<typeof AgentToolExecutionStatusSchema>;

const AgentPartRecordFields = {
  id: IdSchema,
  messageId: IdSchema,
  position: Type.Integer({ minimum: 0 }),
  updatedRevision: Type.Integer({ minimum: 0 }),
  createdAt: Type.Number(),
  updatedAt: Type.Number()
};

export const AgentTextPartSchema = Type.Object({
  ...AgentPartRecordFields,
  type: Type.Literal("text"),
  text: Type.String()
}, { additionalProperties: false });
export type AgentTextPart = Static<typeof AgentTextPartSchema>;

export const AgentReasoningPartSchema = Type.Object({
  ...AgentPartRecordFields,
  type: Type.Literal("reasoning"),
  text: Type.String()
}, { additionalProperties: false });
export type AgentReasoningPart = Static<typeof AgentReasoningPartSchema>;

export const AgentImagePartSchema = Type.Object({
  ...AgentPartRecordFields,
  type: Type.Literal("image"),
  attachmentId: IdSchema,
  mediaType: AgentImageMediaTypeSchema,
  filename: Type.String({ minLength: 1 })
}, { additionalProperties: false });
export type AgentImagePart = Static<typeof AgentImagePartSchema>;

export const AgentToolCallPartSchema = Type.Object({
  ...AgentPartRecordFields,
  type: Type.Literal("tool_call"),
  toolName: AgentContextToolNameSchema,
  input: Type.Record(Type.String(), Type.Unknown()),
  providerToolCallId: Type.Union([IdSchema, Type.Null()])
}, { additionalProperties: false });
export type AgentToolCallPart = Static<typeof AgentToolCallPartSchema>;

export const AgentMessagePartSchema = Type.Union([
  AgentTextPartSchema,
  AgentReasoningPartSchema,
  AgentImagePartSchema,
  AgentToolCallPartSchema
]);
export type AgentMessagePart = Static<typeof AgentMessagePartSchema>;

export const AgentMessageSchema = Type.Object({
  id: IdSchema,
  workspaceId: IdSchema,
  previousMessageId: NullableIdSchema,
  replacesMessageId: NullableIdSchema,
  depth: Type.Integer({ minimum: 0 }),
  type: AgentMessageTypeSchema,
  status: AgentMessageStatusSchema,
  originSessionId: NullableIdSchema,
  originRunId: NullableIdSchema,
  /** Timeline 读侧标记：false 表示该消息仅供历史浏览，不会进入当前运行时上下文。 */
  inActiveContext: Type.Optional(Type.Boolean()),
  updatedRevision: Type.Integer({ minimum: 0 }),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  parts: Type.Array(AgentMessagePartSchema)
}, { additionalProperties: false });
export type AgentMessage = Static<typeof AgentMessageSchema>;

export const AgentToolExecutionSchema = Type.Object({
  id: IdSchema,
  callPartId: IdSchema,
  originSessionId: NullableIdSchema,
  originRunId: NullableIdSchema,
  status: AgentToolExecutionStatusSchema,
  resultPreview: Type.Union([Type.String(), Type.Null()]),
  resultTruncated: Type.Boolean(),
  resultArtifactPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  structuredResult: Type.Union([Type.Any(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  updatedRevision: Type.Integer({ minimum: 0 }),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  completedAt: Type.Union([Type.Number(), Type.Null()])
}, { additionalProperties: false });
export type AgentToolExecution = Static<typeof AgentToolExecutionSchema>;

/** 高频 timeline 只携带状态和短预览；artifact/structuredResult 通过详情接口按需读取。 */
export const AgentTimelineToolExecutionSchema = Type.Object({
  id: IdSchema,
  callPartId: IdSchema,
  status: AgentToolExecutionStatusSchema,
  resultPreview: Type.Union([Type.String({ maxLength: AGENT_TIMELINE_TEXT_MAX_LENGTH }), Type.Null()]),
  resultTruncated: Type.Boolean(),
  error: Type.Union([Type.String({ maxLength: AGENT_TIMELINE_TEXT_MAX_LENGTH }), Type.Null()]),
  updatedRevision: Type.Integer({ minimum: 0 }),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  completedAt: Type.Union([Type.Number(), Type.Null()])
}, { additionalProperties: false });
export type AgentTimelineToolExecution = Static<typeof AgentTimelineToolExecutionSchema>;

export const AgentToolExecutionDetailSchema = AgentToolExecutionSchema;
export type AgentToolExecutionDetail = Static<typeof AgentToolExecutionDetailSchema>;

export const AgentSessionMessageStateSchema = Type.Object({
  id: IdSchema,
  workspaceId: IdSchema,
  title: Type.String({ minLength: 1 }),
  kind: AgentSessionKindSchema,
  headMessageId: NullableIdSchema,
  contextRootMessageId: NullableIdSchema,
  revision: Type.Integer({ minimum: 0 }),
  forkedFromSessionId: NullableIdSchema,
  forkedFromMessageId: NullableIdSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentSessionMessageState = Static<typeof AgentSessionMessageStateSchema>;

export const AgentMessageSessionRunStateSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
  activeRunId: NullableIdSchema,
  runNoticeText: Type.String(),
  retryCount: Type.Integer({ minimum: 0 }),
  lastResponseTotalTokens: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  contextTokenRatio: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  activeRunStartedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  lastRunDurationMs: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  nextRetryAt: Type.Union([Type.Number(), Type.Null()]),
  activeAssistantMessageId: NullableIdSchema,
  nonTerminalMessageIds: Type.Array(IdSchema),
  nonTerminalToolExecutionIds: Type.Array(IdSchema),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentMessageSessionRunState = Static<typeof AgentMessageSessionRunStateSchema>;

export const AgentTimelineReadModeSchema = Type.Union([
  Type.Literal("snapshot"),
  Type.Literal("delta"),
  Type.Literal("before")
]);
export type AgentTimelineReadMode = Static<typeof AgentTimelineReadModeSchema>;

export const AgentTimelineDeltaRequestSchema = Type.Object({
  workspaceId: IdSchema,
  /** snapshot 整体替换、delta 增量更新、before 向前加载历史页。 */
  mode: Type.Optional(AgentTimelineReadModeSchema),
  sinceRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  /** delta 仅当旧 head 仍为当前链祖先时才允许增量，避免 retry/revert/compaction 的旧分支残留。 */
  knownHeadMessageId: Type.Optional(IdSchema),
  knownContextRootMessageId: Type.Optional(IdSchema),
  /** before 模式中早于此 Message 的一页；snapshot/delta 的全量结果都受 limit 约束。 */
  beforeMessageId: Type.Optional(IdSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
}, { additionalProperties: false });
export type AgentTimelineDeltaRequest = Static<typeof AgentTimelineDeltaRequestSchema>;

export const AgentTimelineDeltaResponseSchema = Type.Object({
  session: AgentSessionMessageStateSchema,
  /** true 表示调用方必须丢弃本地 timeline，以本响应作为新的尾部 snapshot。 */
  timelineReset: Type.Boolean(),
  messages: Type.Array(AgentMessageSchema),
  toolExecutions: Type.Array(AgentTimelineToolExecutionSchema),
  hasMore: Type.Optional(Type.Boolean()),
  /** 下一页 before 参数；null 表示已到当前展示分支链首。 */
  nextBeforeMessageId: Type.Optional(NullableIdSchema)
}, { additionalProperties: false });
export type AgentTimelineDeltaResponse = Static<typeof AgentTimelineDeltaResponseSchema>;

export const AgentMessageDetailRequestSchema = Type.Object({
  workspaceId: IdSchema
}, { additionalProperties: false });
export type AgentMessageDetailRequest = Static<typeof AgentMessageDetailRequestSchema>;

export const AgentMessageDetailResponseSchema = Type.Object({
  message: AgentMessageSchema
}, { additionalProperties: false });
export type AgentMessageDetailResponse = Static<typeof AgentMessageDetailResponseSchema>;

/** 渠道插件的窄化读取：仅返回当前可见链最后一个完成 Assistant 的文本。 */
export const AgentSessionLastAssistantTextResponseSchema = Type.Object({
  found: Type.Boolean(),
  text: Type.String()
}, { additionalProperties: false });
export type AgentSessionLastAssistantTextResponse = Static<typeof AgentSessionLastAssistantTextResponseSchema>;

/** 渠道插件需要的 todolist 结果投影；不得暴露 ToolExecution 的内部元数据或 artifact。 */
export const AgentSessionLatestTodolistExecutionSchema = Type.Object({
  resultPreview: Type.Union([Type.String(), Type.Null()]),
  structuredResult: Type.Union([Type.Any(), Type.Null()])
}, { additionalProperties: false });
export type AgentSessionLatestTodolistExecution = Static<typeof AgentSessionLatestTodolistExecutionSchema>;

/** 渠道插件的窄化读取：返回当前可见链最新 todolist 的最小结果投影。 */
export const AgentSessionLatestTodolistResponseSchema = Type.Object({
  isRunning: Type.Boolean(),
  execution: Type.Union([AgentSessionLatestTodolistExecutionSchema, Type.Null()])
}, { additionalProperties: false });
export type AgentSessionLatestTodolistResponse = Static<typeof AgentSessionLatestTodolistResponseSchema>;

export const AgentMessageTimelineSnapshotSchema = Type.Intersect([
  AgentTimelineDeltaResponseSchema,
  Type.Object({ runState: AgentMessageSessionRunStateSchema }, { additionalProperties: false })
]);
export type AgentMessageTimelineSnapshot = Static<typeof AgentMessageTimelineSnapshotSchema>;

/** Schedules a Worker-owned compaction without materializing intermediate Messages. */
export const AgentCompactSessionRequestSchema = Type.Object({
  workspaceId: IdSchema,
  clientRequestId: IdSchema,
  agentId: Type.Optional(IdSchema),
  uiLocale: Type.Optional(Type.Union([Type.Literal("zh-CN"), Type.Literal("en-US")])),
  updatedAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
export type AgentCompactSessionRequest = Static<typeof AgentCompactSessionRequestSchema>;

export const AgentCompactSessionResponseSchema = Type.Object({
  ok: Type.Boolean(),
  session: AgentSessionMessageStateSchema,
  runState: AgentMessageSessionRunStateSchema,
  runId: IdSchema,
  scheduled: Type.Boolean(),
  skippedReason: Type.Optional(Type.String())
}, { additionalProperties: false });
export type AgentCompactSessionResponse = Static<typeof AgentCompactSessionResponseSchema>;

export const AgentMessageControlResultSchema = Type.Object({
  ok: Type.Boolean(),
  session: AgentSessionMessageStateSchema,
  runState: AgentMessageSessionRunStateSchema
}, { additionalProperties: false });
export type AgentMessageControlResult = Static<typeof AgentMessageControlResultSchema>;

export const AgentCancelSessionRequestSchema = Type.Object({
  workspaceId: IdSchema,
  updatedAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
export type AgentCancelSessionRequest = Static<typeof AgentCancelSessionRequestSchema>;
