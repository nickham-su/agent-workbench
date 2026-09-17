import type {
  AgentContextToolName,
  AgentImageMediaType,
  AgentMessage,
  AgentToolExecutionStatus
} from "@agent-workbench/shared";

export type RuntimePromptTextPart = { type: "text"; text: string };
export type RuntimePromptAttachmentRefPart = {
  type: "attachment_ref";
  workspaceId: string;
  attachmentId: string;
  mediaType: AgentImageMediaType;
  filename: string;
};
export type RuntimePromptToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: AgentContextToolName;
  input: Record<string, unknown>;
};
export type RuntimePromptToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: AgentContextToolName;
  output: { type: "text"; value: string } | { type: "error-text"; value: string };
};
export type RuntimePromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<RuntimePromptTextPart | RuntimePromptAttachmentRefPart> }
  | { role: "assistant"; content: string | Array<RuntimePromptTextPart | RuntimePromptToolCallPart> }
  | { role: "tool"; content: RuntimePromptToolResultPart[] };

export type RuntimeTranscriptExecution = {
  callPartId: string;
  status: AgentToolExecutionStatus;
  resultPreview: string | null;
  error: string | null;
};

export const UNKNOWN_TOOL_EXECUTION_RESULT = [
  "Tool execution outcome is unknown because the runtime was interrupted.",
  "The operation may or may not have completed and may have produced side effects.",
  "Inspect the current workspace state before deciding whether to retry or take another action."
].join("\n");
export const CANCELLED_TOOL_EXECUTION_RESULT = "工具调用在执行前被取消，未执行";
export const FAILED_TOOL_EXECUTION_RESULT = "工具调用失败，未提供额外错误信息。";
export const EMPTY_COMPLETED_TOOL_EXECUTION_RESULT = "工具调用已成功完成，但未返回文本结果。";

function historicalImagePlaceholder(attachmentCount: number) {
  return `[This user message included ${attachmentCount} image attachment(s). Their image contents are not included in this run.]`;
}

function imageOnlyTriggerText(attachmentCount: number) {
  return `[The user sent ${attachmentCount} image attachment(s) without accompanying text.]`;
}

function safeUserText(text: string, attachmentCount: number) {
  const placeholder = historicalImagePlaceholder(attachmentCount);
  return text ? `${text}\n\n${placeholder}` : placeholder;
}

function reliableText(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

/**
 * The single authority for transforming immutable Message graph data into the
 * provider-neutral transcript. It never reads artifacts or structured output.
 */
export class RuntimeTranscriptProjector {
  project(input: {
    workspaceId: string;
    triggerMessageId: string | null;
    messages: AgentMessage[];
    executions: RuntimeTranscriptExecution[];
    /** Exclude the Assistant that owns any of these non-terminal calls. */
    stopBeforeAssistantMessageIds?: ReadonlySet<string>;
  }): RuntimePromptMessage[] {
    const executionByCallPartId = new Map(input.executions.map((execution) => [execution.callPartId, execution]));
    const messages: RuntimePromptMessage[] = [];

    for (const message of input.messages) {
      if (input.stopBeforeAssistantMessageIds?.has(message.id)) break;
      if (message.type === "runtime" || message.status !== "completed") continue;
      const parts = [...message.parts].sort((left, right) => left.position - right.position);

      if (message.type === "user") {
        const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
        const images = parts.filter((part) => part.type === "image");
        if (images.length === 0) {
          if (text) messages.push({ role: "user", content: text });
          continue;
        }
        if (message.id !== input.triggerMessageId) {
          messages.push({ role: "user", content: safeUserText(text, images.length) });
          continue;
        }
        const content: Array<RuntimePromptTextPart | RuntimePromptAttachmentRefPart> = [{
          type: "text",
          text: text || imageOnlyTriggerText(images.length)
        }];
        for (const image of images) {
          content.push({
            type: "attachment_ref",
            workspaceId: input.workspaceId,
            attachmentId: image.attachmentId,
            mediaType: image.mediaType,
            filename: image.filename
          });
        }
        messages.push({ role: "user", content });
        continue;
      }

      if (message.type === "system" || message.type === "compaction") {
        const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
        if (text) messages.push({ role: "system", content: text });
        continue;
      }

      if (message.type !== "assistant") continue;
      const assistantParts: Array<RuntimePromptTextPart | RuntimePromptToolCallPart> = [];
      const toolResults: RuntimePromptToolResultPart[] = [];
      for (const part of parts) {
        if (part.type === "text") {
          if (part.text) assistantParts.push({ type: "text", text: part.text });
          continue;
        }
        // ReasoningPart is intentionally persisted for UI only and never reaches a provider.
        if (part.type !== "tool_call") continue;
        const toolCallId = part.providerToolCallId ?? part.id;
        assistantParts.push({
          type: "tool-call",
          toolCallId,
          toolName: part.toolName,
          input: part.input
        });
        const execution = executionByCallPartId.get(part.id);
        if (!execution || execution.status === "queued" || execution.status === "running") {
          throw new Error(`completed assistant ${message.id} has non-terminal tool execution for call part ${part.id}`);
        }
        toolResults.push({
          type: "tool-result",
          toolCallId,
          toolName: part.toolName,
          output: projectToolExecutionResult(execution)
        });
      }
      if (assistantParts.length === 1 && assistantParts[0]?.type === "text") {
        messages.push({ role: "assistant", content: assistantParts[0].text });
      } else if (assistantParts.length > 0) {
        messages.push({ role: "assistant", content: assistantParts });
      }
      // Tool calls and their result envelopes always retain Part.position order.
      if (toolResults.length > 0) messages.push({ role: "tool", content: toolResults });
    }
    return messages;
  }
}

export function projectToolExecutionResult(execution: RuntimeTranscriptExecution): RuntimePromptToolResultPart["output"] {
  const error = reliableText(execution.error);
  const preview = reliableText(execution.resultPreview);
  switch (execution.status) {
    case "unknown": {
      const value = preview ? `${UNKNOWN_TOOL_EXECUTION_RESULT}\n\nReliable result preview:\n${preview}` : UNKNOWN_TOOL_EXECUTION_RESULT;
      return { type: "error-text", value };
    }
    case "cancelled":
      return { type: error ? "error-text" : "text", value: error ?? preview ?? CANCELLED_TOOL_EXECUTION_RESULT };
    case "failed":
      return { type: "error-text", value: error ?? preview ?? FAILED_TOOL_EXECUTION_RESULT };
    case "completed":
      return { type: "text", value: preview ?? EMPTY_COMPLETED_TOOL_EXECUTION_RESULT };
    case "queued":
    case "running":
      throw new Error(`non-terminal tool execution ${execution.status} cannot enter a normal transcript`);
  }
}
