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
    providerNpm: "@ai-sdk/moonshotai",
    protocol: "moonshot-chat",
    protocolVersion: 1,
    providerId: profile.provider.id,
    model: modelId(profile),
    endpointDigest: chatEndpointDigest(profile),
  };
}

class MoonshotConversationStateAttempt implements ProviderConversationStateAttempt {
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
        npm: "@ai-sdk/moonshotai",
        api: "chat-completions",
        protocolVersion: 1,
        providerId: this.invocation.providerId,
        model: this.invocation.model,
        endpointDigest: this.invocation.providerNpm === "@ai-sdk/moonshotai" ? this.invocation.endpointDigest : "",
      },
      item: part.type === "reasoning" ? { type: "reasoning" }
        : part.type === "tool_call" ? { type: "tool_call" } : { type: "text" },
    };
  }

  finalizeAttempt(): ProviderProtocolValidation {
    if (this.incompleteReasoning || this.openReasoningIds.size > 0) {
      return { ok: false, code: "MOONSHOT_REASONING_INCOMPLETE", message: "Moonshot reasoning stream is incomplete" };
    }
    return { ok: true, allowsReplayOnlyAssistant: true };
  }
}

/** A Provider has a fixed thinking policy; the Adapter owns replay state per invocation. */
export class MoonshotConversationStateAdapter implements ProviderConversationStateAdapter {
  readonly protocol = "moonshot-chat" as const;
  readonly scopeStreamPartIds = true as const;

  constructor(readonly profile: ExecutionProfile) {
    if (profile.provider.npm !== "@ai-sdk/moonshotai") {
      throw new Error("Moonshot provider identity mismatch");
    }
  }

  prepareInvocation(input: Parameters<ProviderConversationStateAdapter["prepareInvocation"]>[0]) {
    if (input.profile.provider.npm !== "@ai-sdk/moonshotai"
      || !sameAgentReplayProvenance(identity(input.profile), identity(this.profile))) {
      throw new Error("Moonshot invocation identity mismatch");
    }
    const attemptContext = identity(input.profile);
    return {
      messages: restoreChatReasoning({ messages: input.messages, history: input.history, identity: attemptContext }),
      providerOptions: mergeReasoningProviderOptions(input.providerOptions, reasoningProviderFixedOptions("@ai-sdk/moonshotai")),
      attemptContext,
    };
  }

  createAttempt(context: ProviderConversationStateAttemptContext): ProviderConversationStateAttempt {
    if (!sameAgentReplayProvenance(context, identity(this.profile))) {
      throw new Error("Moonshot attempt context identity mismatch");
    }
    return new MoonshotConversationStateAttempt(context);
  }
}

export function createMoonshotConversationStateAdapter(profile: ExecutionProfile): MoonshotConversationStateAdapter | null {
  if (profile.provider.npm !== "@ai-sdk/moonshotai") return null;
  return new MoonshotConversationStateAdapter(profile);
}
