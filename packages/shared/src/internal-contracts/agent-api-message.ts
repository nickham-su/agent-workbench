import { Type, type Static } from "@sinclair/typebox";
import {
  AgentMessageSchema,
  AgentMessagePartSchema,
  AgentSessionMessageStateSchema,
  AgentTimelineToolExecutionSchema,
  AgentToolExecutionSchema,
  AgentToolExecutionStatusSchema,
  AgentToolExecutionDetailSchema
} from "../contracts/agent-message.js";
import { AgentProviderReplayEnvelopeSchema } from "./agent-provider-replay.js";

const IdSchema = Type.String({ minLength: 1 });

export const AgentApiCreateStreamingAssistantRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  createdAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiCreateStreamingAssistantRequest = Static<typeof AgentApiCreateStreamingAssistantRequestSchema>;

export const AgentApiCreateStreamingAssistantResponseSchema = Type.Object({
  message: AgentMessageSchema
}, { additionalProperties: false });
export type AgentApiCreateStreamingAssistantResponse = Static<typeof AgentApiCreateStreamingAssistantResponseSchema>;

const AgentApiStreamingPartInputSchema = Type.Union([
  Type.Object({
    id: IdSchema, position: Type.Integer({ minimum: 0 }), type: Type.Literal("text"), text: Type.String(),
    providerReplay: Type.Optional(Type.Intersect([
      AgentProviderReplayEnvelopeSchema,
      Type.Object({ item: Type.Object({ type: Type.Literal("text") }) }),
    ])),
  }, { additionalProperties: false }),
  Type.Object({
    id: IdSchema, position: Type.Integer({ minimum: 0 }), type: Type.Literal("reasoning"), text: Type.String(),
    providerReplay: Type.Optional(Type.Intersect([
      AgentProviderReplayEnvelopeSchema,
      Type.Object({ item: Type.Object({ type: Type.Literal("reasoning") }) }),
    ])),
  }, { additionalProperties: false }),
  Type.Object({
    id: IdSchema, position: Type.Integer({ minimum: 0 }), type: Type.Literal("tool_call"),
    toolName: Type.String({ minLength: 1 }), input: Type.Record(Type.String(), Type.Unknown()),
    providerToolCallId: Type.Union([IdSchema, Type.Null()]),
    providerReplay: Type.Optional(Type.Intersect([
      AgentProviderReplayEnvelopeSchema,
      Type.Object({ item: Type.Object({ type: Type.Literal("function_call") }) }),
    ])),
  }, { additionalProperties: false })
]);

export const AgentApiFlushAssistantPartsRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  parts: Type.Array(AgentApiStreamingPartInputSchema),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiFlushAssistantPartsRequest = Static<typeof AgentApiFlushAssistantPartsRequestSchema>;

/** Worker 在恢复 Run 的首次模型调用前认领 API 已准备好的 streaming Assistant。 */
export const AgentApiResumeStreamingAssistantRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema
}, { additionalProperties: false });
export type AgentApiResumeStreamingAssistantRequest = Static<typeof AgentApiResumeStreamingAssistantRequestSchema>;

export const AgentApiFencedWriteResponseSchema = Type.Object({
  result: Type.Union([Type.Literal("updated"), Type.Literal("ignored"), Type.Literal("missing")])
}, { additionalProperties: false });
export type AgentApiFencedWriteResponse = Static<typeof AgentApiFencedWriteResponseSchema>;

/** 将已有部分输出的 streaming Assistant 作废，并原子切换到替代尝试。 */
export const AgentApiReplaceStreamingAssistantRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  oldMessageId: IdSchema,
  newMessageId: IdSchema,
  runNoticeText: Type.String(),
  retryCount: Type.Integer({ minimum: 0 }),
  nextRetryAt: Type.Union([Type.Number(), Type.Null()]),
  createdAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiReplaceStreamingAssistantRequest = Static<typeof AgentApiReplaceStreamingAssistantRequestSchema>;

export const AgentApiReplaceStreamingAssistantResponseSchema = Type.Object({
  result: Type.Union([Type.Literal("updated"), Type.Literal("ignored"), Type.Literal("missing")]),
  message: Type.Union([AgentMessageSchema, Type.Null()])
}, { additionalProperties: false });
export type AgentApiReplaceStreamingAssistantResponse = Static<typeof AgentApiReplaceStreamingAssistantResponseSchema>;

/** 作废当前 streaming Assistant 并将 Session head 回退到其前驱，供外层 compaction 重建上下文。 */
export const AgentApiDiscardStreamingAssistantRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiDiscardStreamingAssistantRequest = Static<typeof AgentApiDiscardStreamingAssistantRequestSchema>;

const AgentApiQueuedToolExecutionSchema = Type.Object({
  id: IdSchema,
  callPartId: IdSchema,
  originSessionId: IdSchema,
  originRunId: IdSchema,
  status: Type.Literal("queued"),
  resultPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resultTruncated: Type.Optional(Type.Boolean()),
  resultArtifactPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  structuredResult: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  startedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  completedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()]))
}, { additionalProperties: false });

export const AgentApiCompleteAssistantRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  executions: Type.Array(AgentApiQueuedToolExecutionSchema),
  responseTotalTokens: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiCompleteAssistantRequest = Static<typeof AgentApiCompleteAssistantRequestSchema>;

export const AgentApiUpdateToolExecutionRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  toolExecutionId: IdSchema,
  status: AgentToolExecutionStatusSchema,
  resultPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resultTruncated: Type.Optional(Type.Boolean()),
  resultArtifactPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  structuredResult: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  startedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  completedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiUpdateToolExecutionRequest = Static<typeof AgentApiUpdateToolExecutionRequestSchema>;

export const AgentApiUpdateRunNoticeRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  runNoticeText: Type.String(),
  retryCount: Type.Optional(Type.Integer({ minimum: 0 })),
  nextRetryAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiUpdateRunNoticeRequest = Static<typeof AgentApiUpdateRunNoticeRequestSchema>;

/** Worker compaction commits a new Message boundary with an explicit Session CAS. */
export const AgentApiCommitCompactionRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  textPartId: IdSchema,
  expectedHeadMessageId: Type.Union([IdSchema, Type.Null()]),
  expectedRevision: Type.Integer({ minimum: 0 }),
  summaryText: Type.String({ minLength: 1 }),
  createdAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiCommitCompactionRequest = Static<typeof AgentApiCommitCompactionRequestSchema>;

export const AgentApiCommitCompactionResponseSchema = Type.Object({
  result: Type.Union([Type.Literal("updated"), Type.Literal("ignored")]),
  summaryMessageId: Type.Union([IdSchema, Type.Null()])
}, { additionalProperties: false });
export type AgentApiCommitCompactionResponse = Static<typeof AgentApiCommitCompactionResponseSchema>;

/**
 * Message Timeline 的内部读取契约。路由会在后续持久化阶段启用；此处先冻结
 * Worker/API 的数据形状，避免继续扩展已退出的内部协议。
 */
export const AgentApiTimelineRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  sinceRevision: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
export type AgentApiTimelineRequest = Static<typeof AgentApiTimelineRequestSchema>;

export const AgentApiTimelineResponseSchema = Type.Object({
  session: AgentSessionMessageStateSchema,
  timelineReset: Type.Boolean(),
  messages: Type.Array(AgentMessageSchema),
  toolExecutions: Type.Array(AgentTimelineToolExecutionSchema)
}, { additionalProperties: false });
export type AgentApiTimelineResponse = Static<typeof AgentApiTimelineResponseSchema>;

export const AgentApiToolExecutionDetailRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  toolExecutionId: Type.String({ minLength: 1 })
}, { additionalProperties: false });
export type AgentApiToolExecutionDetailRequest = Static<typeof AgentApiToolExecutionDetailRequestSchema>;

export const AgentApiToolExecutionDetailResponseSchema = Type.Object({
  toolExecution: AgentToolExecutionDetailSchema
}, { additionalProperties: false });
export type AgentApiToolExecutionDetailResponse = Static<typeof AgentApiToolExecutionDetailResponseSchema>;
