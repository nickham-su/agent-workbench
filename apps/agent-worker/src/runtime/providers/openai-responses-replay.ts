import type { JSONValue, ModelMessage } from "ai";
import type { AssistantContent } from "@ai-sdk/provider-utils";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type {
  AgentApiPromptContextResponse,
  AgentProviderReplayEnvelope,
} from "@agent-workbench/shared/internal-contracts/agent-api";

export type OpenAiReplayProfile = {
  provider: { id?: string; npm: string };
  model: { id: string; providerModelId?: string };
};

type ReplayFor<T extends AgentProviderReplayEnvelope["item"]["type"]> = AgentProviderReplayEnvelope & {
  item: Extract<AgentProviderReplayEnvelope["item"], { type: T }>;
};

export type OpenAiResponsesReplayPartUpdate =
  | { id: string; type: "text"; text?: string; providerReplay: ReplayFor<"text"> }
  | { id: string; type: "reasoning"; text?: string; providerReplay: ReplayFor<"reasoning"> }
  | { providerToolCallId: string; type: "function_call"; providerReplay: ReplayFor<"function_call"> };

export type OpenAiResponsesToolCallReplay = {
  providerToolCallId: string;
  providerReplay: ReplayFor<"function_call">;
};

type ReplaySource = NonNullable<AgentApiPromptContextResponse["providerReplay"]>[number];

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function openAiMetadata(value: unknown) {
  const source = record(value);
  return record(source?.openai);
}

function phase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

export function finalOpenAiModel(profile: OpenAiReplayProfile) {
  return typeof profile.model.providerModelId === "string" && profile.model.providerModelId.trim()
    ? profile.model.providerModelId.trim()
    : profile.model.id;
}

export function isOfficialOpenAiResponsesProfile(profile: OpenAiReplayProfile) {
  return profile.provider.npm === "@ai-sdk/openai";
}

function provider(profile: OpenAiReplayProfile) {
  const providerId = nonEmptyString(profile.provider.id);
  if (!providerId) return null;
  return {
    npm: "@ai-sdk/openai" as const,
    api: "responses" as const,
    providerId,
    model: finalOpenAiModel(profile),
  };
}

function compatible(replay: AgentProviderReplayEnvelope, profile: OpenAiReplayProfile) {
  const expected = provider(profile);
  return expected != null
    && replay.provider.providerId === expected.providerId
    && replay.provider.model === expected.model;
}

export function buildOpenAiResponsesProviderOptions(existing: unknown): OpenAIResponsesProviderOptions {
  const source = record(existing) ?? {};
  const sanitized: RecordValue = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (
      normalized === "previousresponseid"
      || normalized === "conversation"
      || normalized === "reasoningcontext"
    ) continue;
    sanitized[key] = value;
  }
  const include = Array.isArray(source.include)
    ? source.include.filter((item): item is OpenAIResponsesProviderOptions["include"] extends Array<infer T> | null | undefined ? T : never =>
      item === "file_search_call.results" || item === "message.output_text.logprobs" || item === "reasoning.encrypted_content")
    : [];
  return {
    ...sanitized,
    store: false,
    include: [...new Set([...include, "reasoning.encrypted_content" as const])],
  };
}

function providerOptions(value: Record<string, JSONValue>) {
  return { openai: value };
}

export function applyOpenAiResponsesReplay(params: {
  profile: OpenAiReplayProfile;
  messages: ModelMessage[];
  source: AgentApiPromptContextResponse["providerReplay"];
}): ModelMessage[] {
  if (!params.source?.length) return params.messages;
  const byAssistantOrdinal = new Map<number, ReplaySource>();
  for (const item of params.source) byAssistantOrdinal.set(item.assistantOrdinal, item);
  const result: ModelMessage[] = [];
  for (const [messageIndex, message] of params.messages.entries()) {
    const replay = byAssistantOrdinal.get(messageIndex);
    if (!replay || message.role !== "assistant") {
      result.push(message);
      continue;
    }
    const compatibleParts = isOfficialOpenAiResponsesProfile(params.profile)
      ? replay.parts.filter((part) => compatible(part.providerReplay, params.profile))
      : [];
    if (compatibleParts.length === 0) {
      if (!(Array.isArray(message.content) && message.content.length === 0)) result.push(message);
      continue;
    }
    const originalContent = typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
    const before = new Map<number, typeof compatibleParts>();
    const at = new Map<number, typeof compatibleParts>();
    for (const part of compatibleParts) {
      const target = part.type === "reasoning" ? before : at;
      const list = target.get(part.visibleIndex) ?? [];
      list.push(part);
      target.set(part.visibleIndex, list);
    }
    const content: Exclude<AssistantContent, string> = [];
    const appendReasoning = (index: number) => {
      for (const part of before.get(index) ?? []) {
        if (part.type !== "reasoning" || part.providerReplay.item.type !== "reasoning") continue;
        content.push({
          type: "reasoning",
          text: part.text,
          providerOptions: providerOptions({
            itemId: part.providerReplay.item.itemId,
            reasoningEncryptedContent: part.providerReplay.item.encryptedContent,
          }),
        });
      }
    };
    for (let index = 0; index < originalContent.length; index += 1) {
      appendReasoning(index);
      const original = originalContent[index];
      if (!original) continue;
      let next: Exclude<AssistantContent, string>[number] = original;
      for (const part of at.get(index) ?? []) {
        if (part.type === "text" && part.providerReplay.item.type === "text" && original.type === "text") {
          next = {
            ...next,
            providerOptions: providerOptions({
              itemId: part.providerReplay.item.itemId,
              ...(part.providerReplay.item.phase == null ? {} : { phase: part.providerReplay.item.phase }),
            }),
          };
        }
        if (part.type === "tool_call" && part.providerReplay.item.type === "function_call" && original.type === "tool-call") {
          next = {
            ...next,
            providerOptions: providerOptions({ itemId: part.providerReplay.item.itemId }),
          };
        }
      }
      content.push(next);
    }
    appendReasoning(originalContent.length);
    result.push({ ...message, content });
  }
  return result;
}

function streamPartId(chunk: RecordValue) {
  return nonEmptyString(chunk.id);
}

function summaryIndex(id: string, itemId: string) {
  const prefix = `${itemId}:`;
  if (!id.startsWith(prefix)) return undefined;
  const parsed = Number.parseInt(id.slice(prefix.length), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function collectOpenAiResponsesReplayChunk(params: {
  profile: OpenAiReplayProfile;
  chunk: unknown;
}): OpenAiResponsesReplayPartUpdate | null {
  const replayProvider = provider(params.profile);
  if (!replayProvider) return null;
  const chunk = record(params.chunk);
  if (!chunk) return null;
  const type = chunk.type;
  if (type === "reasoning-start" || type === "reasoning-delta" || type === "reasoning-end") {
    const id = streamPartId(chunk);
    const metadata = openAiMetadata(chunk.providerMetadata);
    const itemId = nonEmptyString(metadata?.itemId);
    const encryptedContent = nonEmptyString(metadata?.reasoningEncryptedContent);
    if (!id || !itemId || !encryptedContent) return null;
    return {
      id,
      type: "reasoning",
      providerReplay: {
        version: 1,
        provider: replayProvider,
        item: {
          type: "reasoning",
          itemId,
          encryptedContent,
          ...(summaryIndex(id, itemId) == null ? {} : { summaryIndex: summaryIndex(id, itemId) }),
        },
      },
    };
  }
  if (type === "text-start" || type === "text-end") {
    const id = streamPartId(chunk);
    const metadata = openAiMetadata(chunk.providerMetadata);
    const itemId = nonEmptyString(metadata?.itemId);
    if (!id || !itemId) return null;
    const itemPhase = phase(metadata?.phase);
    return {
      id,
      type: "text",
      providerReplay: {
        version: 1,
        provider: replayProvider,
        item: { type: "text", itemId, ...(itemPhase == null ? {} : { phase: itemPhase }) },
      },
    };
  }
  return null;
}

export function collectOpenAiResponsesToolCallReplay(params: {
  profile: OpenAiReplayProfile;
  chunk: unknown;
}): OpenAiResponsesToolCallReplay | null {
  const replayProvider = provider(params.profile);
  if (!replayProvider) return null;
  const chunk = record(params.chunk);
  if (!chunk || chunk.type !== "tool-call") return null;
  const callId = nonEmptyString(chunk.toolCallId);
  const itemId = nonEmptyString(openAiMetadata(chunk.providerMetadata)?.itemId);
  if (!callId || !itemId) return null;
  return {
    providerToolCallId: callId,
    providerReplay: { version: 1, provider: replayProvider, item: { type: "function_call", itemId } },
  };
}

function responseCompleted(rawValue: unknown) {
  const value = record(rawValue);
  if (!value || value.type !== "response.completed") return null;
  const response = record(value.response);
  return Array.isArray(response?.output) ? response.output : null;
}

export type OpenAiResponsesTerminalStatus = "completed" | "incomplete" | "failed" | null;

export function openAiResponsesTerminalStatus(rawValue: unknown): OpenAiResponsesTerminalStatus {
  const value = record(rawValue);
  if (!value) return null;
  if (value.type === "response.completed") return "completed";
  if (value.type === "response.incomplete") return "incomplete";
  if (value.type === "response.failed") return "failed";
  return null;
}

export function collectOpenAiResponsesTerminalReplay(params: {
  profile: OpenAiReplayProfile;
  rawValue: unknown;
  reasoningPartIdsByItem: ReadonlyMap<string, readonly string[]>;
}): OpenAiResponsesReplayPartUpdate[] {
  const replayProvider = provider(params.profile);
  const output = responseCompleted(params.rawValue);
  if (!replayProvider || !output) return [];
  const updates: OpenAiResponsesReplayPartUpdate[] = [];
  for (const itemValue of output) {
    const item = record(itemValue);
    if (!item || item.type !== "reasoning") continue;
    const itemId = nonEmptyString(item.id);
    const encryptedContent = nonEmptyString(item.encrypted_content);
    if (!itemId || !encryptedContent) continue;
    for (const id of params.reasoningPartIdsByItem.get(itemId) ?? []) {
      updates.push({
        id,
        type: "reasoning",
        providerReplay: {
          version: 1,
          provider: replayProvider,
          item: {
            type: "reasoning",
            itemId,
            encryptedContent,
            ...(summaryIndex(id, itemId) == null ? {} : { summaryIndex: summaryIndex(id, itemId) }),
          },
        },
      });
    }
  }
  return updates;
}

export function openAiReasoningItemIdFromChunk(chunkValue: unknown) {
  const chunk = record(chunkValue);
  if (!chunk || (chunk.type !== "reasoning-start" && chunk.type !== "reasoning-delta" && chunk.type !== "reasoning-end")) return null;
  const id = streamPartId(chunk);
  const itemId = nonEmptyString(openAiMetadata(chunk.providerMetadata)?.itemId);
  return id && itemId ? { id, itemId } : null;
}
