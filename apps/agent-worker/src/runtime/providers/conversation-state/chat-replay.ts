import type { ModelMessage } from "ai";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import {
  agentReplayProvenance,
  sameAgentReplayProvenance,
  type AgentAssistantProvenance,
} from "@agent-workbench/shared/internal-contracts/agent-provider-provenance";

type History = AgentApiPromptContextResponse["providerReplay"];

/**
 * Recover only the contiguous, trustworthy Assistant suffix of the current protected
 * prompt. `assistantOrdinal` is the index in messages, not the Assistant ordinal.
 * Never queries outside PromptContext: Fork/Revert and compaction have already applied.
 */
export function restoreChatReasoning(input: {
  messages: ModelMessage[];
  history: History;
  identity: AgentAssistantProvenance;
}): ModelMessage[] {
  const sources = new Map((input.history ?? []).map((source) => [source.assistantOrdinal, source]));
  const eligible = new Set<number>();
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i]?.role !== "assistant") continue;
    const source = sources.get(i);
    if (!source?.assistantProvenance || !sameAgentReplayProvenance(source.assistantProvenance, input.identity)) break;
    eligible.add(i);
  }
  return input.messages.flatMap((message, i): ModelMessage[] => {
    if (message.role !== "assistant") return [message];
    const content = typeof message.content === "string"
      ? (message.content ? [{ type: "text" as const, text: message.content }] : [])
      : [...message.content];
    if (!eligible.has(i)) return content.length ? [message] : [];
    const source = sources.get(i)!;
    const before = new Map<number, Array<{ type: "reasoning"; text: string }>>();
    for (const part of source.parts) {
      if (part.type !== "reasoning" || !part.text || part.providerReplay.item.type !== "reasoning"
        || !sameAgentReplayProvenance(agentReplayProvenance(part.providerReplay), input.identity)
        || part.visibleIndex > content.length) continue;
      const list = before.get(part.visibleIndex) ?? [];
      list.push({ type: "reasoning", text: part.text });
      before.set(part.visibleIndex, list);
    }
    const restored = content.flatMap((part, index) => [...(before.get(index) ?? []), part]);
    restored.push(...(before.get(content.length) ?? []));
    return restored.length ? [{ ...message, content: restored }] : [];
  });
}
