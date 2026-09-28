import type { ExecutionProfile } from "../../apiClient.js";
import { createOpenAIResponsesConversationStateAdapter } from "./openai-responses-adapter.js";
import { createMoonshotConversationStateAdapter } from "./moonshot-adapter.js";
import { createDeepSeekConversationStateAdapter } from "./deepseek-adapter.js";
import type {
  ProviderConversationStateAdapter,
  ProviderConversationStateAdapterRegistry,
} from "./types.js";

/**
 * 只选择当前请求的私有状态协议；模型执行、重试和写入仍由 Runner 管理。
 * Provider-specific protocols are selected here; the Runner does not branch on replay format.
 */
export class DefaultProviderConversationStateAdapterRegistry implements ProviderConversationStateAdapterRegistry {
  resolve(profile: ExecutionProfile): ProviderConversationStateAdapter | null {
    return createOpenAIResponsesConversationStateAdapter(profile)
      ?? createMoonshotConversationStateAdapter(profile)
      ?? createDeepSeekConversationStateAdapter(profile);
  }
}
