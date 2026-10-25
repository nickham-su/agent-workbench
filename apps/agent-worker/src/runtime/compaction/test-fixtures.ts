import type { AgentApiCompactionSourceResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ExecutionProfile } from "../apiClient.js";
import type { CompactionSource } from "./types.js";

export const testProfile = {
  resolved: { providerId: "openai", modelId: "model", workspaceId: "ws", sessionId: "session", runId: "run", agentId: "agent" },
  provider: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", options: { baseURL: "https://example.test", apiKey: "secret" } },
  model: { id: "model", providerModelId: "gpt-5", name: "GPT", contextWindowTokens: 128_000 },
  agent: { id: "agent", name: "Agent", summary: "", prompt: "", tools: [], pluginTools: [], mcpServers: [], defaultModel: null },
  runtime: {
    modelIdleTimeoutMs: 0,
    modelTotalTimeoutMs: 0,
    modelRequestMaxRetries: 0,
    modelRequestRetryBackoffMaxMs: 2_000,
    autoCompactThresholdPct: 80,
    maxSubtaskDepth: 3,
    sessionTerminalSoundEnabled: false,
    compactionModel: null,
    updatedAt: 0,
  },
  compaction: null,
} satisfies ExecutionProfile;

type SourceBlock = AgentApiCompactionSourceResponse["blocks"][number];
type SourceMessage = SourceBlock["message"];
type SourcePart = SourceMessage["parts"][number];

function message(input: {
  id: string;
  previousMessageId: string | null;
  index: number;
  type: "user" | "assistant" | "system" | "compaction";
  text: string;
  media: boolean;
}): SourceMessage {
  const textPart = { id: `p${input.index + 1}`, messageId: input.id, position: 0, type: "text" as const, text: input.text, updatedRevision: input.index + 1, createdAt: input.index, updatedAt: input.index };
  const imagePart = { id: "image", messageId: input.id, position: 1, type: "image" as const, attachmentId: "attachment", mediaType: "image/png" as const, filename: "screen.png", updatedRevision: input.index + 1, createdAt: input.index, updatedAt: input.index };
  const base = {
    id: input.id,
    workspaceId: "ws",
    previousMessageId: input.previousMessageId,
    replacesMessageId: null,
    depth: input.index,
    status: "completed" as const,
    originSessionId: "session",
    originRunId: "run",
    updatedRevision: input.index + 1,
    createdAt: input.index,
    updatedAt: input.index,
  };
  if (input.type === "compaction") {
    return {
      ...base,
      type: "compaction",
      retainedFromMessageId: null,
      parts: [textPart],
    } as SourceMessage;
  }
  return {
    ...base,
    type: input.type,
    parts: input.media ? [textPart, imagePart] : [textPart],
  } as SourceMessage;
}

export function testSource(input?: {
  texts?: string[];
  types?: Array<"user" | "assistant" | "system" | "compaction">;
  triggerIndex?: number | null;
  mediaTrigger?: boolean;
  pending?: boolean;
}): CompactionSource {
  const texts = input?.texts ?? ["old context", "recent context", "trigger"];
  const triggerIndex = input?.triggerIndex === undefined ? texts.length - 1 : input.triggerIndex;
  const types = input?.types ?? texts.map(() => "user" as const);
  const blocks: SourceBlock[] = texts.map((text, index) => {
    const messageId = `m${index + 1}`;
    const hasMedia = input?.mediaTrigger === true && index === triggerIndex;
    return {
      sourceMessageId: messageId,
      physical: { previousMessageId: index === 0 ? null : `m${index}`, depth: index, originSessionId: "session", originRunId: "run", updatedRevision: index + 1 },
      message: message({ id: messageId, previousMessageId: index === 0 ? null : `m${index}`, index, type: types[index] ?? "user", text, media: hasMedia }),
      toolExecutions: [],
      attachments: hasMedia ? [{ partId: "image", attachmentId: "attachment", mediaType: "image/png", filename: "screen.png", relativePath: "repo/screen.png" }] : [],
      providerReplay: [],
    };
  });
  return {
    workspaceId: "ws",
    sessionId: "session",
    runId: "run",
    runKind: "manual_compaction",
    triggerMessageId: triggerIndex == null ? null : `m${triggerIndex + 1}`,
    agentId: "agent",
    providerId: "openai",
    modelId: "model",
    subtaskDepth: null,
    headMessageId: texts.length === 0 ? null : `m${texts.length}`,
    contextRootMessageId: null,
    sessionRevision: 7,
    uiLocale: null,
    oneShotSystem: "summary system",
    pendingBoundary: input?.pending ? { reason: "pending_tool_execution", assistantMessageId: "pending", toolExecutionIds: ["execution"] } : null,
    blocks,
  } satisfies CompactionSource;
}

export function addAssistantReplay(block: SourceBlock, npm: "@ai-sdk/openai" | "@ai-sdk/deepseek" | "@ai-sdk/moonshotai") {
  const text = block.message.parts.find((part) => part.type === "text")!;
  const base = { messageId: block.message.id, updatedRevision: 1, createdAt: 0, updatedAt: 0 };
  const reason = { ...base, id: `${block.sourceMessageId}-reason`, position: 0, type: "reasoning" as const, text: "visible analysis" };
  const call = { ...base, id: `${block.sourceMessageId}-call`, position: 2, type: "tool_call" as const, toolName: "bash", input: { command: "example" }, providerToolCallId: `${block.sourceMessageId}-provider-call` };
  block.message.parts = [reason, { ...text, position: 1 }, call];
  block.toolExecutions = [{ id: `${block.sourceMessageId}-execution`, callPartId: call.id, status: "completed", resultPreview: "tool completed", error: null, startedAt: 0, completedAt: 1 }];
  block.providerReplay = block.message.parts.map((part) => ({
    partId: part.id,
    envelope: npm === "@ai-sdk/openai" ? {
      version: 1,
      provider: { npm, api: "responses", providerId: "openai", model: "gpt-5" },
      item: part.type === "reasoning"
        ? { type: "reasoning", itemId: part.id, encryptedContent: "PRIVATE_ENCRYPTED_REPLAY" }
        : part.type === "tool_call"
          ? { type: "function_call", itemId: part.id }
          : { type: "text", itemId: part.id },
    } : {
      version: 1,
      provider: { npm, api: "chat-completions", protocolVersion: 1, providerId: "chat", model: "chat-model", endpointDigest: "a".repeat(64) },
      item: { type: part.type === "tool_call" ? "tool_call" : part.type === "reasoning" ? "reasoning" : "text" },
    },
  }));
  return block;
}

export type { SourcePart };
