import { mergeReasoningProviderOptions, reasoningProviderFixedOptions } from "@agent-workbench/shared";
import type { AgentAssistantProvenance } from "@agent-workbench/shared/internal-contracts/agent-provider-provenance";
import { sameAgentReplayProvenance } from "@agent-workbench/shared/internal-contracts/agent-provider-provenance";
import type { AgentProviderReplayEnvelope } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ExecutionProfile } from "../../apiClient.js";
import { restoreChatReasoning } from "./chat-replay.js";
import { chatEndpointDigest } from "./endpoint-identity.js";
import type {
  ProviderConversationStateAdapter,
  ProviderConversationStateAttempt,
  ProviderConversationStateAttemptContext,
  ProviderProtocolValidation,
} from "./types.js";

function modelId(profile: ExecutionProfile): string {
  return typeof profile.model.providerModelId === "string" && profile.model.providerModelId.trim()
    ? profile.model.providerModelId.trim() : profile.model.id;
}

function identity(profile: ExecutionProfile): AgentAssistantProvenance {
  return {
    providerNpm: "@ai-sdk/deepseek",
    protocol: "deepseek-chat",
    protocolVersion: 1,
    providerId: profile.provider.id,
    model: modelId(profile),
    endpointDigest: chatEndpointDigest(profile),
  };
}

class DeepSeekConversationStateAttempt implements ProviderConversationStateAttempt {
  private readonly openReasoningIds = new Set<string>();
  private incompleteReasoning = false;

  constructor(private readonly invocation: AgentAssistantProvenance) {}

  observeChunk(chunk: unknown) {
    if (chunk && typeof chunk === "object" && "type" in chunk && "id" in chunk
      && typeof chunk.id === "string") {
      if (chunk.type === "reasoning-start") {
        if (this.openReasoningIds.has(chunk.id)) this.incompleteReasoning = true;
        this.openReasoningIds.add(chunk.id);
      } else if (chunk.type === "reasoning-end") {
        if (!this.openReasoningIds.delete(chunk.id)) this.incompleteReasoning = true;
      } else if (chunk.type === "reasoning-delta" && !this.openReasoningIds.has(chunk.id)) {
        this.incompleteReasoning = true;
      }
    }
    return {};
  }

  createPartReplay(part: Readonly<{ id: string; type: "text" | "reasoning" | "tool_call" }>): AgentProviderReplayEnvelope {
    return {
      version: 1,
      provider: {
        npm: "@ai-sdk/deepseek",
        api: "chat-completions",
        protocolVersion: 1,
        providerId: this.invocation.providerId,
        model: this.invocation.model,
        endpointDigest: this.invocation.providerNpm === "@ai-sdk/deepseek" ? this.invocation.endpointDigest : "",
      },
      item: part.type === "reasoning" ? { type: "reasoning" }
        : part.type === "tool_call" ? { type: "tool_call" } : { type: "text" },
    };
  }

  finalizeAttempt(): ProviderProtocolValidation {
    if (this.incompleteReasoning || this.openReasoningIds.size > 0) {
      return { ok: false, code: "DEEPSEEK_REASONING_INCOMPLETE", message: "DeepSeek reasoning stream is incomplete" };
    }
    return { ok: true, allowsReplayOnlyAssistant: true };
  }
}

/** A Provider has one fixed thinking policy; each Attempt independently tracks the reasoning stream. */
export class DeepSeekConversationStateAdapter implements ProviderConversationStateAdapter {
  readonly protocol = "deepseek-chat" as const;
  readonly scopeStreamPartIds = true as const;

  constructor(readonly profile: ExecutionProfile) {
    if (profile.provider.npm !== "@ai-sdk/deepseek") {
      throw new Error("DeepSeek provider identity mismatch");
    }
  }

  prepareInvocation(input: Parameters<ProviderConversationStateAdapter["prepareInvocation"]>[0]) {
    if (input.profile.provider.npm !== "@ai-sdk/deepseek"
      || !sameAgentReplayProvenance(identity(input.profile), identity(this.profile))) {
      throw new Error("DeepSeek invocation identity mismatch");
    }
    const attemptContext = identity(input.profile);
    return {
      // DeepSeek receives all reasoning from the contiguous compatible suffix, regardless of tools.
      messages: restoreChatReasoning({ messages: input.messages, history: input.history, identity: attemptContext }),
      providerOptions: mergeReasoningProviderOptions(input.providerOptions, reasoningProviderFixedOptions("@ai-sdk/deepseek")),
      attemptContext,
    };
  }

  createAttempt(context: ProviderConversationStateAttemptContext): ProviderConversationStateAttempt {
    if (!sameAgentReplayProvenance(context, identity(this.profile))) {
      throw new Error("DeepSeek attempt context identity mismatch");
    }
    return new DeepSeekConversationStateAttempt(context);
  }
}

export function createDeepSeekConversationStateAdapter(profile: ExecutionProfile): DeepSeekConversationStateAdapter | null {
  if (profile.provider.npm !== "@ai-sdk/deepseek") return null;
  return new DeepSeekConversationStateAdapter(profile);
}
