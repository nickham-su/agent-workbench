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
  /** 同一原生 reasoning item 内，本地可见 summary segment 的零基序号。 */
  summaryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  encryptedContent: NonEmptyStringSchema,
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

export const AgentOpenAiResponsesReplayEnvelopeSchema = Type.Object({
  version: Type.Literal(1),
  provider: AgentOpenAiResponsesReplayProviderSchema,
  item: Type.Union([
    AgentOpenAiResponsesReasoningReplayItemSchema,
    AgentOpenAiResponsesTextReplayItemSchema,
    AgentOpenAiResponsesFunctionCallReplayItemSchema,
  ]),
}, { additionalProperties: false });

const ChatReplayItemSchema = Type.Union([
  Type.Object({ type: Type.Literal("text") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("reasoning") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("tool_call") }, { additionalProperties: false }),
]);

function chatEnvelope(npm: "@ai-sdk/moonshotai" | "@ai-sdk/deepseek") {
  return Type.Object({
    version: Type.Literal(1),
    provider: Type.Object({
      npm: Type.Literal(npm),
      api: Type.Literal("chat-completions"),
      protocolVersion: Type.Literal(1),
      providerId: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
      endpointDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    }, { additionalProperties: false }),
    item: ChatReplayItemSchema,
  }, { additionalProperties: false });
}
export const AgentMoonshotReplayEnvelopeSchema = chatEnvelope("@ai-sdk/moonshotai");
export const AgentDeepSeekReplayEnvelopeSchema = chatEnvelope("@ai-sdk/deepseek");

// Recognition only, never replay: early v1 Chat Parts predate endpoint identity.
// Keep the old shape closed; unknown fields/versions and malformed JSON remain errors.
const LegacyChatReplayEnvelopeSchema = Type.Object({
  version: Type.Literal(1),
  provider: Type.Object({
    npm: Type.Union([Type.Literal("@ai-sdk/moonshotai"), Type.Literal("@ai-sdk/deepseek")]),
    api: Type.Literal("chat-completions"),
    protocolVersion: Type.Literal(1),
    providerId: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
  }, { additionalProperties: false }),
  item: ChatReplayItemSchema,
}, { additionalProperties: false });

/** Accept only the identifiable pre-digest Chat shape as an unreadable replay boundary. */
export function isLegacyChatReplayWithoutEndpointDigest(value: string): boolean {
  try {
    return Value.Check(LegacyChatReplayEnvelopeSchema, JSON.parse(value));
  } catch {
    return false;
  }
}

/** Provider discrimination is strict: OpenAI item ids/encrypted data cannot enter chat replay. */
export const AgentProviderReplayEnvelopeSchema = Type.Union([
  AgentOpenAiResponsesReplayEnvelopeSchema,
  AgentMoonshotReplayEnvelopeSchema,
  AgentDeepSeekReplayEnvelopeSchema,
]);
export type AgentProviderReplayEnvelope = Static<typeof AgentProviderReplayEnvelopeSchema>;
export type AgentChatReplayEnvelope = Static<typeof AgentMoonshotReplayEnvelopeSchema> | Static<typeof AgentDeepSeekReplayEnvelopeSchema>;
type OpenAiReplayEnvelope = Static<typeof AgentOpenAiResponsesReplayEnvelopeSchema>;

function isOpenAiReplay(value: AgentProviderReplayEnvelope): value is OpenAiReplayEnvelope {
  return value.provider.npm === "@ai-sdk/openai";
}

export class AgentProviderReplayUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProviderReplayUpdateError";
  }
}

function normalizeProviderReplay(value: AgentProviderReplayEnvelope): AgentProviderReplayEnvelope {
  if (!isOpenAiReplay(value)) {
    return {
      version: 1,
      provider: {
        npm: value.provider.npm,
        api: "chat-completions",
        protocolVersion: 1,
        providerId: value.provider.providerId,
        model: value.provider.model,
        endpointDigest: value.provider.endpointDigest,
      },
      item: value.item.type === "reasoning" ? { type: "reasoning" }
        : value.item.type === "tool_call" ? { type: "tool_call" } : { type: "text" },
    };
  }
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
  return { version: 1, provider, item: { type: "function_call", itemId: value.item.itemId } };
}

/** Strict allowlist serialization; no untrusted SDK metadata or message content is retained. */
export function serializeAgentProviderReplay(value: unknown): string {
  if (!Value.Check(AgentProviderReplayEnvelopeSchema, value)) {
    throw new Error("invalid agent provider replay envelope");
  }
  return JSON.stringify(normalizeProviderReplay(value));
}

/** Damaged or future-version historical metadata is a replay boundary, not an exception. */
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

function isSameAgentProviderReplayIdentity(left: AgentProviderReplayEnvelope, right: AgentProviderReplayEnvelope): boolean {
  if (left.provider.npm !== right.provider.npm) return false;
  if (left.version !== right.version || left.provider.api !== right.provider.api
    || left.provider.providerId !== right.provider.providerId || left.provider.model !== right.provider.model
    || left.item.type !== right.item.type) return false;
  if (!isOpenAiReplay(left) || !isOpenAiReplay(right)) {
    return !isOpenAiReplay(left) && !isOpenAiReplay(right)
      && left.provider.protocolVersion === right.provider.protocolVersion
      && left.provider.endpointDigest === right.provider.endpointDigest;
  }
  return left.item.itemId === right.item.itemId;
}

function assertKnownFieldIsNotLostOrChanged<T>(label: string, existing: T | undefined, incoming: T | undefined): void {
  if (existing === undefined || incoming === existing) return;
  throw new AgentProviderReplayUpdateError(`agent provider replay ${label} is immutable once known`);
}

/** Same local Part: chat provenance is immutable; existing OpenAI metadata may gain terminal fields. */
export function assertAgentProviderReplayUpdateCompatible(existing: AgentProviderReplayEnvelope, incoming: AgentProviderReplayEnvelope): void {
  if (!isSameAgentProviderReplayIdentity(existing, incoming)) {
    throw new AgentProviderReplayUpdateError("agent provider replay item identity is immutable");
  }
  if (!isOpenAiReplay(existing) || !isOpenAiReplay(incoming)) return;
  if (existing.item.type === "reasoning" && incoming.item.type === "reasoning") {
    assertKnownFieldIsNotLostOrChanged("summaryIndex", existing.item.summaryIndex, incoming.item.summaryIndex);
    return;
  }
  if (existing.item.type === "text" && incoming.item.type === "text") {
    assertKnownFieldIsNotLostOrChanged("phase", existing.item.phase, incoming.item.phase);
  }
}
