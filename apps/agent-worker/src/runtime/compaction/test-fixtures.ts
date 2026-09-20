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
    visionModel: null,
    compactionModel: null,
    updatedAt: 0,
  },
  vision: null,
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
      attachments: hasMedia ? [{ partId: "image", attachmentId: "attachment", mediaType: "image/png", filename: "screen.png" }] : [],
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

export type { SourcePart };
