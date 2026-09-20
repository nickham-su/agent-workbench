import type { JSONValue, ModelMessage } from "ai";
import type {
  AgentApiPromptContextResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ExecutionProfile } from "../../apiClient.js";
import type {
  OpenAiResponsesReplayPartUpdate,
  OpenAiResponsesToolCallReplay,
} from "../openai-responses-replay.js";

/**
 * Provider 私有对话状态协议。没有适配器时由 Registry 返回 null，不能伪造 noop 协议。
 */
export type ProviderConversationStateProtocol = "openai-responses";

export type ProviderConversationStatePartUpdate = OpenAiResponsesReplayPartUpdate;
export type ProviderConversationStateToolCallReplay = OpenAiResponsesToolCallReplay;

export type PreparedProviderInvocation = Readonly<{
  messages: ModelMessage[];
  providerOptions: Record<string, unknown>;
  includeRawChunks?: boolean;
}>;

export type ProviderProtocolValidation =
  | Readonly<{ ok: true }>
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
  finalizeAttempt(): ProviderProtocolValidation;
}

export interface ProviderConversationStateAdapter {
  readonly protocol: ProviderConversationStateProtocol;
  prepareInvocation(input: Readonly<{
    profile: ExecutionProfile;
    messages: ModelMessage[];
    history: AgentApiPromptContextResponse["providerReplay"];
    providerOptions: Record<string, unknown>;
  }>): PreparedProviderInvocation;
  createAttempt(): ProviderConversationStateAttempt;
}

export type ProviderConversationStateAdapterRegistry = Readonly<{
  resolve(profile: ExecutionProfile): ProviderConversationStateAdapter | null;
}>;
