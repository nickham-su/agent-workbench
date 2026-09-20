import type { ModelMessage } from "ai";
import type { SummaryInputBlock, SummaryInputMessage, SummaryInputPart } from "./types.js";

function stableJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[Unserializable tool input omitted]";
  }
}

function describeAttachment(part: Extract<SummaryInputPart, { type: "attachment" }>) {
  return `[Attachment omitted: ${part.mediaType}, filename=${part.filename}]`;
}

function renderParts(parts: readonly SummaryInputPart[], context: "user" | "assistant" | "tool") {
  return parts.map((part) => {
    switch (part.type) {
      case "text": return part.text;
      case "reasoning": return `[Assistant reasoning]\n${part.text}`;
      case "attachment": return describeAttachment(part);
      case "tool-call": return `[Tool call: ${part.toolName}]\ninput: ${stableJson(part.input)}`;
      case "tool-result": return `[Tool result: ${part.toolName}]\n${part.output.type === "error-text" ? "error" : "output"}: ${part.output.value}`;
      default: return `[${context} content omitted]`;
    }
  }).join("\n\n");
}

/**
 * Converts provider-neutral summary input into the portable textual subset of
 * AI SDK ModelMessage. It deliberately does not emit provider wire tool parts:
 * their shape differs between OpenAI Responses, OpenAI-compatible chat and
 * Anthropic. Attachments remain metadata-only descriptions and no bytes/IDs,
 * replay state or provider options can enter this boundary.
 */
export function summaryInputToModelMessages(blocks: readonly SummaryInputBlock[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const block of blocks) {
    for (const message of block.messages) {
      appendMessage(result, message);
    }
  }
  return result;
}

function appendMessage(result: ModelMessage[], message: SummaryInputMessage) {
  if (message.role === "system") {
    result.push({ role: "system", content: message.content });
    return;
  }
  const content = renderParts(message.content, message.role);
  if (!content) return;
  if (message.role === "assistant") {
    result.push({ role: "assistant", content });
    return;
  }
  // Tool results are represented as user-visible transcript facts. This avoids
  // cross-provider tool-call ID/wire compatibility requirements.
  result.push({ role: "user", content });
}
