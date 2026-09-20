import {
  applyOpenAiResponsesReplay,
  buildOpenAiResponsesProviderOptions,
  collectOpenAiResponsesReplayChunk,
  collectOpenAiResponsesTerminalReplay,
  collectOpenAiResponsesToolCallReplay,
  isOfficialOpenAiResponsesProfile,
  openAiReasoningItemIdFromChunk,
  openAiResponsesTerminalStatus,
} from "../openai-responses-replay.js";
import type {
  ProviderConversationStateAdapter,
  ProviderConversationStateAttempt,
  ProviderConversationStateChunkObservation,
  ProviderProtocolValidation,
} from "./types.js";

class OpenAIResponsesConversationStateAttempt implements ProviderConversationStateAttempt {
  private readonly reasoningPartIdsByItem = new Map<string, string[]>();
  private sawCompleted = false;
  private sawTerminalFailure = false;
  private sawUnknownFinishReason = false;

  constructor(private readonly adapter: OpenAIResponsesConversationStateAdapter) {}

  observeChunk(chunk: unknown): ProviderConversationStateChunkObservation {
    const reasoningIdentity = openAiReasoningItemIdFromChunk(chunk);
    if (reasoningIdentity) {
      const ids = this.reasoningPartIdsByItem.get(reasoningIdentity.itemId) ?? [];
      if (!ids.includes(reasoningIdentity.id)) ids.push(reasoningIdentity.id);
      this.reasoningPartIdsByItem.set(reasoningIdentity.itemId, ids);
    }

    const partUpdate = collectOpenAiResponsesReplayChunk({
      profile: this.adapter.profile,
      chunk,
    });
    const toolCallReplay = collectOpenAiResponsesToolCallReplay({
      profile: this.adapter.profile,
      chunk,
    });

    let terminalPartUpdates: ProviderConversationStateChunkObservation["terminalPartUpdates"];
    if (isRecord(chunk) && chunk.type === "raw") {
      terminalPartUpdates = collectOpenAiResponsesTerminalReplay({
        profile: this.adapter.profile,
        rawValue: chunk.rawValue,
        reasoningPartIdsByItem: this.reasoningPartIdsByItem,
      });
      const terminalStatus = openAiResponsesTerminalStatus(chunk.rawValue);
      if (terminalStatus === "completed") this.sawCompleted = true;
      if (terminalStatus === "incomplete" || terminalStatus === "failed") {
        this.sawTerminalFailure = true;
      }
    }
    if (isRecord(chunk) && chunk.type === "finish" && chunk.finishReason === "unknown") {
      this.sawUnknownFinishReason = true;
    }

    return {
      ...(partUpdate == null ? {} : { partUpdate }),
      ...(toolCallReplay == null ? {} : { toolCallReplay }),
      ...(terminalPartUpdates == null || terminalPartUpdates.length === 0 ? {} : { terminalPartUpdates }),
    };
  }

  finalizeAttempt(): ProviderProtocolValidation {
    if (this.sawTerminalFailure) {
      return {
        ok: false,
        code: "OPENAI_RESPONSES_TERMINAL_FAILURE",
        message: "OpenAI Responses stream contained a failed or incomplete terminal event",
      };
    }
    if (this.sawUnknownFinishReason) {
      return {
        ok: false,
        code: "OPENAI_RESPONSES_UNKNOWN_FINISH_REASON",
        message: "OpenAI Responses finish reason was unknown",
      };
    }
    if (!this.sawCompleted) {
      return {
        ok: false,
        code: "OPENAI_RESPONSES_COMPLETED_MISSING",
        message: "OpenAI Responses stream ended without response.completed",
      };
    }
    return { ok: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 官方 OpenAI Responses 的私有 replay 与终态协议解释器。 */
export class OpenAIResponsesConversationStateAdapter implements ProviderConversationStateAdapter {
  readonly protocol = "openai-responses" as const;

  constructor(readonly profile: Parameters<typeof applyOpenAiResponsesReplay>[0]["profile"]) {}

  prepareInvocation(input: Parameters<ProviderConversationStateAdapter["prepareInvocation"]>[0]) {
    const messages = applyOpenAiResponsesReplay({
      profile: input.profile,
      messages: input.messages,
      source: input.history,
    });
    return {
      messages,
      providerOptions: buildOpenAiResponsesProviderOptions(input.providerOptions),
      includeRawChunks: true,
    };
  }

  createAttempt(): ProviderConversationStateAttempt {
    return new OpenAIResponsesConversationStateAttempt(this);
  }
}

export function createOpenAIResponsesConversationStateAdapter(profile: Parameters<typeof applyOpenAiResponsesReplay>[0]["profile"]) {
  return isOfficialOpenAiResponsesProfile(profile)
    ? new OpenAIResponsesConversationStateAdapter(profile)
    : null;
}
