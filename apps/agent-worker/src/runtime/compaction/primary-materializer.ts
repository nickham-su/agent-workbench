import type { ExecutionProfile } from "../apiClient.js";
import {
  hasPrimaryBlockVisibleProjection,
  isOfficialOpenAiResponsesPrimaryProfile,
  isPrimaryReplayCompatible,
  type PrimaryReplayProjectionDescriptor,
} from "@agent-workbench/shared";
import { sourceBlockContainsTriggerMedia, validateCompactionSourceBlock } from "./source-block-invariants.js";
import { projectCompactionToolExecutionResult } from "./tool-execution-result.js";
import type {
  CompactionSource,
  CompactionSourceBlock,
  PrimaryAssistantPart,
  PrimaryMaterializedBlock,
  PrimaryProviderNeutralMessage,
  PrimaryReplay,
  PrimaryToolResultPart,
  PrimaryUserPart,
} from "./types.js";
export { PRIMARY_MATERIALIZER_VERSION } from "./types.js";

function toPrimaryReplayProjectionDescriptor(
  envelope: CompactionSourceBlock["providerReplay"][number]["envelope"],
): PrimaryReplayProjectionDescriptor | undefined {
  if (envelope.provider.npm !== "@ai-sdk/openai") return undefined;
  const openai = envelope as Extract<typeof envelope, { provider: { npm: "@ai-sdk/openai" } }>;
  return {
    adapter: "openai_responses",
    providerId: openai.provider.providerId,
    modelId: openai.provider.model,
    itemType: openai.item.type,
  };
}

function asCompatibleReplay(input: {
  envelope: CompactionSourceBlock["providerReplay"][number]["envelope"];
  profile: ExecutionProfile;
  expected: "reasoning" | "text" | "function_call";
}): PrimaryReplay | undefined {
  const { envelope, profile, expected } = input;
  if (!isPrimaryReplayCompatible({
    replay: toPrimaryReplayProjectionDescriptor(envelope),
    profile,
    expected,
  })) return undefined;
  // The only replay protocol supported by Primary materialization is OpenAI Responses.
  if (envelope.provider.npm !== "@ai-sdk/openai") return undefined;
  const openaiEnvelope = envelope as Extract<typeof envelope, { provider: { npm: "@ai-sdk/openai" } }>;
  if (openaiEnvelope.item.type === "reasoning") {
    return {
      provider: openaiEnvelope.provider,
      item: {
        type: "reasoning",
        itemId: openaiEnvelope.item.itemId,
        encryptedContent: openaiEnvelope.item.encryptedContent,
        ...(openaiEnvelope.item.summaryIndex == null ? {} : { summaryIndex: openaiEnvelope.item.summaryIndex }),
      },
    };
  }
  if (openaiEnvelope.item.type === "text") {
    return {
      provider: openaiEnvelope.provider,
      item: { type: "text", itemId: openaiEnvelope.item.itemId, ...(openaiEnvelope.item.phase == null ? {} : { phase: openaiEnvelope.item.phase }) },
    };
  }
  return { provider: openaiEnvelope.provider, item: { type: "function_call", itemId: openaiEnvelope.item.itemId } };
}

function imageOnlyTriggerText(attachmentCount: number) {
  return `[The user sent ${attachmentCount} image attachment(s) without accompanying text.]`;
}

function historicalImagePlaceholder(attachmentCount: number) {
  return `[This user message included ${attachmentCount} image attachment(s). Their image contents are not included in this run.]`;
}

/**
 * Mirrors PromptContext's base transcript: only non-empty text and tool calls
 * are visible. Compatible OpenAI Responses replay then injects reasoning and
 * identity metadata without turning incompatible private state into context.
 */
function materializeBlock(input: { source: CompactionSource; block: CompactionSourceBlock; profile: ExecutionProfile }): PrimaryMaterializedBlock {
  const { source, block, profile } = input;
  const validated = validateCompactionSourceBlock(block);
  const messages: PrimaryProviderNeutralMessage[] = [];
  const containsTriggerMedia = sourceBlockContainsTriggerMedia(block, source.triggerMessageId);

  if (block.message.type === "user") {
    const text = validated.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    const images = validated.parts.filter((part) => part.type === "image");
    if (images.length === 0) {
      if (text) messages.push({ role: "user", content: text });
    } else if (block.sourceMessageId === source.triggerMessageId) {
      const content: PrimaryUserPart[] = [{ type: "text", text: text || imageOnlyTriggerText(images.length) }];
      for (const image of images) {
        const attachment = validated.attachmentsByPartId.get(image.id);
        if (!attachment) throw new Error("validated image attachment unexpectedly missing");
        content.push({
          type: "attachment_ref",
          workspaceId: source.workspaceId,
          attachmentId: attachment.attachmentId,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
        });
      }
      messages.push({ role: "user", content });
    } else {
      const placeholder = historicalImagePlaceholder(images.length);
      messages.push({ role: "user", content: text ? `${text}\n\n${placeholder}` : placeholder });
    }
  } else if (block.message.type === "system" || block.message.type === "compaction") {
    const text = validated.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (text) messages.push({ role: "system", content: text });
  } else if (block.message.type === "assistant") {
    const assistantParts: PrimaryAssistantPart[] = [];
    const toolParts: PrimaryToolResultPart[] = [];
    for (const part of validated.parts) {
      if (part.type === "text" && part.text) {
        const replay = validated.replayByPartId.get(part.id);
        const providerReplay = replay == null ? undefined : asCompatibleReplay({ envelope: replay, profile, expected: "text" });
        assistantParts.push({ type: "text", text: part.text, ...(providerReplay == null ? {} : { providerReplay }) });
        continue;
      }
      if (part.type === "reasoning") {
        const replay = validated.replayByPartId.get(part.id);
        const providerReplay = replay == null ? undefined : asCompatibleReplay({ envelope: replay, profile, expected: "reasoning" });
        if (providerReplay) assistantParts.push({ type: "reasoning", text: part.text, providerReplay });
        continue;
      }
      if (part.type !== "tool_call") continue;
      const toolCallId = part.providerToolCallId ?? part.id;
      const replay = validated.replayByPartId.get(part.id);
      const providerReplay = replay == null ? undefined : asCompatibleReplay({ envelope: replay, profile, expected: "function_call" });
      assistantParts.push({ type: "tool-call", toolCallId, toolName: part.toolName, input: part.input, ...(providerReplay == null ? {} : { providerReplay }) });
      const execution = validated.executionsByCallPartId.get(part.id);
      if (!execution) throw new Error("validated tool execution unexpectedly missing");
      toolParts.push({ type: "tool-result", toolCallId, toolName: part.toolName, output: projectCompactionToolExecutionResult(execution) });
    }
    if (assistantParts.length === 1 && assistantParts[0]!.type === "text" && assistantParts[0]!.providerReplay == null) {
      messages.push({ role: "assistant", content: assistantParts[0].text });
    } else if (assistantParts.length > 0) {
      messages.push({ role: "assistant", content: assistantParts });
    }
    if (toolParts.length > 0) messages.push({ role: "tool", content: toolParts });
  }

  const isProjectionEmpty = !hasPrimaryBlockVisibleProjection({
    message: block.message,
    profile,
    replayProjectionByPartId: new Map([...validated.replayByPartId].flatMap(([partId, envelope]) => {
      const descriptor = toPrimaryReplayProjectionDescriptor(envelope);
      return descriptor ? [[partId, descriptor] as const] : [];
    })),
  });
  const hasAssistantMessage = messages.some((message) => message.role === "assistant");
  return {
    sourceBlockId: block.sourceMessageId,
    sourceMessageType: block.message.type,
    messages,
    isProjectionEmpty,
    canStartRetainedTail: !isProjectionEmpty && (block.message.type === "user" || block.message.type === "system" || (block.message.type === "assistant" && hasAssistantMessage)),
    containsTriggerMedia,
  };
}

/**
 * Only converts the API's single-snapshot source. It neither reads attachment
 * bytes nor produces Provider wire messages, so it is safe for planning.
 */
export function materializePrimaryBlocks(input: { source: CompactionSource; profile: ExecutionProfile }): PrimaryMaterializedBlock[] {
  if (input.source.pendingBoundary != null && input.source.blocks.some((block) => block.sourceMessageId === input.source.pendingBoundary!.assistantMessageId)) {
    throw new Error("compaction source contains its pending boundary block");
  }
  return input.source.blocks.map((block) => materializeBlock({ ...input, block }));
}

export function primaryMaterializerAdapterIdentity(profile: ExecutionProfile) {
  return isOfficialOpenAiResponsesPrimaryProfile(profile)
    ? `${profile.provider.npm}:responses`
    : `${profile.provider.npm}:default`;
}

export function canProfileStartRetainedTailAtAssistant(profile: ExecutionProfile) {
  return isOfficialOpenAiResponsesPrimaryProfile(profile);
}
