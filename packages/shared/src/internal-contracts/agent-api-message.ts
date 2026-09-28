import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AgentMessageSchema,
  AgentOrdinaryMessageSchema,
  AgentMessagePartSchema,
  AgentSessionMessageStateSchema,
  AgentTimelineToolExecutionSchema,
  AgentToolExecutionSchema,
  AgentToolExecutionStatusSchema,
  AgentToolExecutionDetailSchema
} from "../contracts/agent-message.js";
import { AgentProviderReplayEnvelopeSchema } from "./agent-provider-replay.js";
import {
  AgentTerminalResultCodeSchema,
  AgentTerminalRunStatusSchema,
} from "../contracts/agent.js";

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
  message: AgentOrdinaryMessageSchema
}, { additionalProperties: false });
export type AgentApiCreateStreamingAssistantResponse = Static<typeof AgentApiCreateStreamingAssistantResponseSchema>;

const StrictAgentApiStreamingPartInputSchema = Type.Union([
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
      Type.Object({ item: Type.Object({ type: Type.Union([Type.Literal("function_call"), Type.Literal("tool_call")]) }) }),
    ])),
  }, { additionalProperties: false })
]);

// Fastify's Ajv removes additional properties while trying each anyOf branch. The strict
// discriminated replay union (OpenAI vs two Chat providers) would mutate Chat metadata
// into an invalid shape before reaching the matching branch; the same is true for the
// text/reasoning/tool-call part union. Use a non-mutating transport shape, then check
// the original strict schema after authorization; the store also validates replay
// before persisting anything.
const ReplayTransportSchema = Type.Object({
  version: Type.Literal(1),
  provider: Type.Object({
    npm: Type.Union([Type.Literal("@ai-sdk/openai"), Type.Literal("@ai-sdk/moonshotai"), Type.Literal("@ai-sdk/deepseek")]),
    api: Type.Union([Type.Literal("responses"), Type.Literal("chat-completions")]),
    providerId: IdSchema, model: IdSchema,
  }),
  item: Type.Object({ type: Type.Union([
    Type.Literal("text"), Type.Literal("reasoning"), Type.Literal("function_call"), Type.Literal("tool_call"),
  ]) }),
});

const AgentApiStreamingPartInputSchema = Type.Object({
  id: IdSchema, position: Type.Integer({ minimum: 0 }),
  type: Type.Union([Type.Literal("text"), Type.Literal("reasoning"), Type.Literal("tool_call")]),
  text: Type.Optional(Type.String()),
  toolName: Type.Optional(IdSchema), input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  providerToolCallId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  providerReplay: Type.Optional(ReplayTransportSchema),
}, { additionalProperties: false });

export const AgentApiFlushAssistantPartsRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  parts: Type.Array(StrictAgentApiStreamingPartInputSchema),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiFlushAssistantPartsRequest = Static<typeof AgentApiFlushAssistantPartsRequestSchema>;

/** Ajv-facing shape only: retain the exported strict contract for Value.Check callers. */
export const AgentApiFlushAssistantPartsTransportRequestSchema = Type.Object({
  ...AgentApiFlushAssistantPartsRequestSchema.properties,
  parts: Type.Array(AgentApiStreamingPartInputSchema),
}, { additionalProperties: false });

/** Fastify must not mutate a discriminated anyOf during Ajv validation; enforce
 * its original strict contract before dispatching the authenticated write. */
export function hasValidAgentApiStreamingParts(value: unknown): boolean {
  return Array.isArray(value) && value.every((part) => Value.Check(StrictAgentApiStreamingPartInputSchema, part));
}

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
  message: Type.Union([AgentOrdinaryMessageSchema, Type.Null()])
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

export const AgentApiCommitCompactionResponseSchema = Type.Object({
  result: Type.Union([Type.Literal("updated"), Type.Literal("ignored")]),
  summaryMessageId: Type.Union([IdSchema, Type.Null()])
}, { additionalProperties: false });
export type AgentApiCommitCompactionResponse = Static<typeof AgentApiCommitCompactionResponseSchema>;

/**
 * Worker compaction commit; manual requests atomically include terminal intent.
 */
export const AgentApiCommitCompactionWithTerminalIntentRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  textPartId: IdSchema,
  expectedHeadMessageId: Type.Union([IdSchema, Type.Null()]),
  expectedRevision: Type.Integer({ minimum: 0 }),
  retainedFromMessageId: Type.Union([IdSchema, Type.Null()]),
  summaryText: Type.String({ minLength: 1 }),
  intent: Type.Optional(Type.Object({
    status: Type.Literal("completed"),
    code: Type.Literal("compaction_completed"),
    detail: Type.Null(),
  }, { additionalProperties: false })),
  createdAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiCommitCompactionWithTerminalIntentRequest = Static<
  typeof AgentApiCommitCompactionWithTerminalIntentRequestSchema
>;

/** Read-only confirmation for a commit whose HTTP response was lost. */
export const AgentApiConfirmCompactionCommitRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
}, { additionalProperties: false });
export type AgentApiConfirmCompactionCommitRequest = Static<typeof AgentApiConfirmCompactionCommitRequestSchema>;

export const AgentApiConfirmCompactionCommitResponseSchema = Type.Object({
  outcome: Type.Union([Type.Literal("committed"), Type.Literal("not_committed")]),
}, { additionalProperties: false });
export type AgentApiConfirmCompactionCommitResponse = Static<typeof AgentApiConfirmCompactionCommitResponseSchema>;

export const AgentApiCompleteTerminalAssistantRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  responseTotalTokens: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  intent: Type.Object({
    status: Type.Literal("completed"),
    code: Type.Union([Type.Literal("run_completed"), Type.Literal("subtask_completed")]),
    detail: Type.Null(),
  }, { additionalProperties: false }),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiCompleteTerminalAssistantRequest = Static<typeof AgentApiCompleteTerminalAssistantRequestSchema>;

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
