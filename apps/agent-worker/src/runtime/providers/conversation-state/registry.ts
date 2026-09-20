import type { ExecutionProfile } from "../../apiClient.js";
import { createOpenAIResponsesConversationStateAdapter } from "./openai-responses-adapter.js";
import type {
  ProviderConversationStateAdapter,
  ProviderConversationStateAdapterRegistry,
} from "./types.js";

/**
 * 只选择当前请求的私有状态协议；模型执行、重试和写入仍由 Runner 管理。
 * Phase A 仅注册官方 OpenAI Responses，其他 Provider 明确没有 Adapter。
 */
export class DefaultProviderConversationStateAdapterRegistry implements ProviderConversationStateAdapterRegistry {
  resolve(profile: ExecutionProfile): ProviderConversationStateAdapter | null {
    return createOpenAIResponsesConversationStateAdapter(profile);
  }
}
