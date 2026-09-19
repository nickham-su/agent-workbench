import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const NonEmptyStringSchema = Type.String({ minLength: 1 });

export const AgentOpenAiResponsesReplayProviderSchema = Type.Object({
  npm: Type.Literal("@ai-sdk/openai"),
  api: Type.Literal("responses"),
  providerId: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
}, { additionalProperties: false });

export const AgentOpenAiResponsesReasoningReplayItemSchema = Type.Object({
  type: Type.Literal("reasoning"),
  itemId: NonEmptyStringSchema,
  encryptedContent: NonEmptyStringSchema,
  /**
   * 同一原生 reasoning item 内，本地可见 summary segment 的零基序号。
   * 该字段只标识 segment 身份与顺序，不保存或替代 summary 文本。
   */
  summaryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const AgentOpenAiResponsesTextReplayItemSchema = Type.Object({
  type: Type.Literal("text"),
  itemId: NonEmptyStringSchema,
  phase: Type.Optional(Type.Union([
    Type.Literal("commentary"),
    Type.Literal("final_answer"),
  ])),
}, { additionalProperties: false });

export const AgentOpenAiResponsesFunctionCallReplayItemSchema = Type.Object({
  type: Type.Literal("function_call"),
  itemId: NonEmptyStringSchema,
}, { additionalProperties: false });

export const AgentProviderReplayEnvelopeSchema = Type.Object({
  version: Type.Literal(1),
  provider: AgentOpenAiResponsesReplayProviderSchema,
  item: Type.Union([
    AgentOpenAiResponsesReasoningReplayItemSchema,
    AgentOpenAiResponsesTextReplayItemSchema,
    AgentOpenAiResponsesFunctionCallReplayItemSchema,
  ]),
}, { additionalProperties: false });

export type AgentProviderReplayEnvelope = Static<typeof AgentProviderReplayEnvelopeSchema>;

export class AgentProviderReplayUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProviderReplayUpdateError";
  }
}

function normalizeProviderReplay(value: AgentProviderReplayEnvelope): AgentProviderReplayEnvelope {
  const provider = {
    npm: "@ai-sdk/openai" as const,
    api: "responses" as const,
    providerId: value.provider.providerId,
    model: value.provider.model,
  };
  if (value.item.type === "reasoning") {
    return {
      version: 1,
      provider,
      item: {
        type: "reasoning",
        itemId: value.item.itemId,
        encryptedContent: value.item.encryptedContent,
        ...(value.item.summaryIndex == null ? {} : { summaryIndex: value.item.summaryIndex }),
      },
    };
  }
  if (value.item.type === "text") {
    return {
      version: 1,
      provider,
      item: {
        type: "text",
        itemId: value.item.itemId,
        ...(value.item.phase == null ? {} : { phase: value.item.phase }),
      },
    };
  }
  return {
    version: 1,
    provider,
    item: { type: "function_call", itemId: value.item.itemId },
  };
}

/**
 * 内部写入边界使用的严格序列化。仅接受版本化白名单字段，输出稳定 JSON，
 * 避免把 SDK providerMetadata 或未知字段原样落库。
 */
export function serializeAgentProviderReplay(value: unknown): string {
  if (!Value.Check(AgentProviderReplayEnvelopeSchema, value)) {
    throw new Error("invalid agent provider replay envelope");
  }
  return JSON.stringify(normalizeProviderReplay(value));
}

/**
 * 私有读侧的容错解析。损坏或未来版本数据会被安全跳过，且调用方无需记录原文。
 */
export function parseAgentProviderReplay(value: string | null): AgentProviderReplayEnvelope | null {
  if (value == null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Value.Check(AgentProviderReplayEnvelopeSchema, parsed)) return null;
    return normalizeProviderReplay(parsed);
  } catch {
    return null;
  }
}

function isSameAgentProviderReplayIdentity(
  left: AgentProviderReplayEnvelope,
  right: AgentProviderReplayEnvelope,
): boolean {
  return left.version === right.version
    && left.provider.npm === right.provider.npm
    && left.provider.api === right.provider.api
    && left.provider.providerId === right.provider.providerId
    && left.provider.model === right.provider.model
    && left.item.type === right.item.type
    && left.item.itemId === right.item.itemId;
}

function assertKnownFieldIsNotLostOrChanged<T>(label: string, existing: T | undefined, incoming: T | undefined): void {
  if (existing === undefined) return;
  if (incoming === existing) return;
  throw new AgentProviderReplayUpdateError(`agent provider replay ${label} is immutable once known`);
}

/**
 * 校验同一持久化 Part 上的 replay metadata 增量更新。
 *
 * - Provider 与原生 item 身份始终不可变化；
 * - `summaryIndex` / `phase` 允许 unknown → known、known → same；
 * - 已知字段不得改值或退回 unknown；
 * - reasoning 密文允许由终态事件补齐或更新。
 */
export function assertAgentProviderReplayUpdateCompatible(
  existing: AgentProviderReplayEnvelope,
  incoming: AgentProviderReplayEnvelope,
): void {
  if (!isSameAgentProviderReplayIdentity(existing, incoming)) {
    throw new AgentProviderReplayUpdateError("agent provider replay item identity is immutable");
  }
  if (existing.item.type === "reasoning" && incoming.item.type === "reasoning") {
    assertKnownFieldIsNotLostOrChanged("summaryIndex", existing.item.summaryIndex, incoming.item.summaryIndex);
    return;
  }
  if (existing.item.type === "text" && incoming.item.type === "text") {
    assertKnownFieldIsNotLostOrChanged("phase", existing.item.phase, incoming.item.phase);
  }
}
