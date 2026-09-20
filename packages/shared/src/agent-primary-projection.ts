import type { AgentMessage } from "./contracts/agent-message.js";
import type { AgentProviderNpm } from "./contracts/settings.js";

/**
 * 只描述 Primary provider-neutral 投影所需的持久 Run 模型身份。
 * 它不包含密钥、Provider options 或任何 Provider wire message。
 */
export type PrimaryProjectionProfile = {
  provider: {
    id: string;
    npm: AgentProviderNpm;
  };
  model: {
    id: string;
    providerModelId?: string;
  };
};

/**
 * 从私有 replay 边界投影出的最小身份描述。
 *
 * 此类型刻意不携带 replay item 的内容或身份；例如 encryptedContent、itemId、
 * summaryIndex、phase 以及任何 Provider 配置均不得进入 Shared Primary 判定。
 */
export type PrimaryReplayProjectionDescriptor = {
  adapter: "openai_responses";
  providerId: string;
  modelId: string;
  itemType: "reasoning" | "text" | "function_call";
};

export function primaryProjectionModelId(profile: PrimaryProjectionProfile) {
  return typeof profile.model.providerModelId === "string" && profile.model.providerModelId.trim()
    ? profile.model.providerModelId.trim()
    : profile.model.id;
}

/** OpenAI 官方 Responses 是目前唯一支持 Assistant retained-tail 起点的适配器。 */
export function isOfficialOpenAiResponsesPrimaryProfile(profile: PrimaryProjectionProfile) {
  return profile.provider.npm === "@ai-sdk/openai";
}

export function isPrimaryReplayCompatible(input: {
  replay: PrimaryReplayProjectionDescriptor | undefined;
  profile: PrimaryProjectionProfile;
  expected: "reasoning" | "text" | "function_call";
}) {
  const { replay, profile, expected } = input;
  return replay != null
    && isOfficialOpenAiResponsesPrimaryProfile(profile)
    && replay.adapter === "openai_responses"
    && replay.providerId === profile.provider.id
    && replay.modelId === primaryProjectionModelId(profile)
    && replay.itemType === expected;
}

/**
 * 与 compaction Primary materializer 一致的最小可见性判定。
 * 不构造 Provider wire message、不估算 token，也不读取附件内容。
 */
export function hasPrimaryBlockVisibleProjection(input: {
  message: AgentMessage;
  profile: PrimaryProjectionProfile;
  replayProjectionByPartId: ReadonlyMap<string, PrimaryReplayProjectionDescriptor>;
}) {
  const { message, profile, replayProjectionByPartId } = input;
  if (message.type === "user") {
    return message.parts.some((part) => (part.type === "text" && part.text.length > 0) || part.type === "image");
  }
  if (message.type === "system" || message.type === "compaction") {
    return message.parts.some((part) => part.type === "text" && part.text.length > 0);
  }
  if (message.type !== "assistant") return false;
  return message.parts.some((part) => {
    if (part.type === "text") return part.text.length > 0;
    if (part.type === "tool_call") return true;
    return part.type === "reasoning" && isPrimaryReplayCompatible({
      replay: replayProjectionByPartId.get(part.id),
      profile,
      expected: "reasoning",
    });
  });
}

/**
 * retainedFromMessageId 只能指向可成为 Primary retained-tail 首块的完整原文块。
 * Assistant 除了必须有可见投影外，还必须由当前 profile 的 adapter 支持作为首块。
 */
export function canStartPrimaryRetainedTail(input: {
  message: AgentMessage;
  profile: PrimaryProjectionProfile;
  replayProjectionByPartId: ReadonlyMap<string, PrimaryReplayProjectionDescriptor>;
}) {
  if (!hasPrimaryBlockVisibleProjection(input)) return false;
  return input.message.type !== "assistant" || isOfficialOpenAiResponsesPrimaryProfile(input.profile);
}
