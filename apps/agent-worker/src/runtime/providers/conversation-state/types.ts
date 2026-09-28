import type { JSONValue, ModelMessage } from "ai";
import type {
  AgentApiPromptContextResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ExecutionProfile } from "../../apiClient.js";
import type { AgentProviderReplayEnvelope } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentAssistantProvenance } from "@agent-workbench/shared/internal-contracts/agent-provider-provenance";
import type {
  OpenAiResponsesReplayPartUpdate,
  OpenAiResponsesToolCallReplay,
} from "../openai-responses-replay.js";

/**
 * Provider 私有对话状态协议。没有适配器时由 Registry 返回 null，不能伪造 noop 协议。
 */
export type ProviderConversationStateProtocol = "openai-responses" | "moonshot-chat" | "deepseek-chat";

export type ProviderConversationStatePartUpdate = OpenAiResponsesReplayPartUpdate;

export type ProviderConversationStateAttemptContext = Readonly<AgentAssistantProvenance>;
export type ProviderConversationStateToolCallReplay = OpenAiResponsesToolCallReplay;

export type PreparedProviderInvocation = Readonly<{
  messages: ModelMessage[];
  providerOptions: Record<string, unknown>;
  includeRawChunks?: boolean;
  attemptContext: ProviderConversationStateAttemptContext;
}>;

export type ProviderProtocolValidation =
  | Readonly<{ ok: true; allowsReplayOnlyAssistant?: boolean }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
  }>;

export type ProviderConversationStateChunkObservation = Readonly<{
  partUpdate?: ProviderConversationStatePartUpdate;
  toolCallReplay?: ProviderConversationStateToolCallReplay;
  terminalPartUpdates?: ProviderConversationStatePartUpdate[];
}>;

/** 一次 streamText 调用独立拥有的协议状态；不得跨 retry/replacement 复用。 */
export interface ProviderConversationStateAttempt {
  observeChunk(chunk: unknown): ProviderConversationStateChunkObservation;
  /** A local Part has materialized; metadata must match its final identity. */
  createPartReplay?(part: Readonly<{
    id: string;
    type: "text" | "reasoning" | "tool_call";
    providerToolCallId?: string;
  }>): AgentProviderReplayEnvelope | null;
  finalizeAttempt(): ProviderProtocolValidation;
}

export interface ProviderConversationStateAdapter {
  readonly protocol: ProviderConversationStateProtocol;
  /** SDK stream IDs are invocation-local; opt in when local Part IDs must survive across Assistants. */
  readonly scopeStreamPartIds?: true;
  prepareInvocation(input: Readonly<{
    profile: ExecutionProfile;
    messages: ModelMessage[];
    history: AgentApiPromptContextResponse["providerReplay"];
    providerOptions: Record<string, unknown>;
  }>): PreparedProviderInvocation;
  createAttempt(context: ProviderConversationStateAttemptContext): ProviderConversationStateAttempt;
}

export type ProviderConversationStateAdapterRegistry = Readonly<{
  resolve(profile: ExecutionProfile): ProviderConversationStateAdapter | null;
}>;
