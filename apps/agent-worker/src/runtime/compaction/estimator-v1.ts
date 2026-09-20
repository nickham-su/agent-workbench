import type {
  EstimatorCanonicalMessage,
  EstimatorCanonicalJsonValue,
  EstimatorCanonicalReplay,
  EstimatorEstimate,
  PrimaryMaterializedBlock,
  PrimaryProviderNeutralMessage,
  PrimaryReplay,
} from "./types.js";

export const ESTIMATOR_VERSION = "estimator-v1";

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalJson(value: unknown, seen = new Set<object>()): EstimatorCanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("estimator received a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("estimator received cyclic tool input");
    seen.add(value);
    const result = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return result;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("estimator received a non-JSON tool input value");
  }
  if (seen.has(value)) throw new Error("estimator received cyclic tool input");
  seen.add(value);
  const result: Record<string, EstimatorCanonicalJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      throw new Error("estimator received a non-JSON tool input value");
    }
    result[key] = canonicalJson(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalStringify(value: EstimatorCanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key]!)}`).join(",")}}`;
}

function canonicalReplay(replay: PrimaryReplay | undefined): EstimatorCanonicalReplay | undefined {
  if (!replay) return undefined;
  if (replay.item.type === "reasoning") {
    return { provider: replay.provider, item: { type: "reasoning", itemId: replay.item.itemId, encryptedContent: "<encrypted>" } };
  }
  if (replay.item.type === "text") {
    return { provider: replay.provider, item: { type: "text", itemId: replay.item.itemId, ...(replay.item.phase == null ? {} : { phase: replay.item.phase }) } };
  }
  return { provider: replay.provider, item: { type: "function_call", itemId: replay.item.itemId } };
}

function mapMessage(message: PrimaryProviderNeutralMessage): EstimatorCanonicalMessage {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "user") {
    if (typeof message.content === "string") return { role: "user", content: message.content };
    return {
      role: "user",
      content: message.content.map((part) => part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "attachment_ref" as const, mediaType: part.mediaType, filename: "<filename>" as const }),
    };
  }
  if (message.role === "assistant") {
    const parts = typeof message.content === "string"
      ? (message.content ? [{ type: "text" as const, text: message.content }] : [])
      : message.content;
    const content: Extract<EstimatorCanonicalMessage, { role: "assistant" }>["content"] = parts.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text, ...(canonicalReplay(part.providerReplay) == null ? {} : { replay: canonicalReplay(part.providerReplay) }) };
      if (part.type === "reasoning") return { type: "reasoning", text: part.text, replay: canonicalReplay(part.providerReplay)! };
      return {
        type: "tool-call" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: canonicalJson(part.input),
        ...(canonicalReplay(part.providerReplay) == null ? {} : { replay: canonicalReplay(part.providerReplay) }),
      };
    });
    return {
      role: "assistant",
      content,
    };
  }
  return {
    role: "tool",
    content: message.content.map((part) => ({
      type: "tool-result" as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: part.output.type, value: part.output.value },
    })),
  };
}

function countCosts(messages: EstimatorCanonicalMessage[], sourceMessages: PrimaryProviderNeutralMessage[]) {
  let contentPartCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let attachmentCount = 0;
  let replayEncryptedExtra = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      contentPartCount += 1;
      if (part.type === "tool-call") toolCallCount += 1;
      if (part.type === "tool-result") toolResultCount += 1;
      if (part.type === "attachment_ref") attachmentCount += 1;
    }
  }
  for (const message of sourceMessages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if ("providerReplay" in part && part.providerReplay?.item.type === "reasoning") {
        replayEncryptedExtra += 64 + Math.ceil(utf8ByteLength(part.providerReplay.item.encryptedContent) / 4);
      }
    }
  }
  return {
    messageCount: messages.length,
    contentPartCount,
    toolCallCount,
    toolResultCount,
    attachmentCount,
    replayEncryptedExtra,
  };
}

/** 唯一生产估算入口：仅接受附件展开前的 PrimaryMaterializedBlock。 */
export function estimatePrimaryMaterializedBlock(block: PrimaryMaterializedBlock): EstimatorEstimate {
  if (block.isProjectionEmpty) {
    return {
      canonicalMessages: [],
      canonicalJson: "[]",
      utf8Bytes: 2,
      textTokens: 1,
      messageCount: 0,
      contentPartCount: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      attachmentCount: 0,
      replayEncryptedExtra: 0,
      fixedCosts: 0,
      estimatedTokens: 0,
    };
  }
  const canonicalMessages = block.messages.map(mapMessage);
  const canonicalJson = canonicalStringify(canonicalMessages);
  const utf8Bytes = utf8ByteLength(canonicalJson);
  const textTokens = Math.ceil(utf8Bytes / 3);
  const counts = countCosts(canonicalMessages, block.messages);
  const fixedCosts = counts.messageCount * 8
    + counts.contentPartCount * 4
    + counts.toolCallCount * 8
    + counts.toolResultCount * 8
    + counts.attachmentCount * 1024
    + counts.replayEncryptedExtra;
  return {
    canonicalMessages,
    canonicalJson,
    utf8Bytes,
    textTokens,
    ...counts,
    fixedCosts,
    estimatedTokens: Math.ceil((textTokens + fixedCosts) * 1.10),
  };
}

export function estimatePrimaryMaterializedBlocks(blocks: readonly PrimaryMaterializedBlock[]) {
  return blocks.reduce((total, block) => total + estimatePrimaryMaterializedBlock(block).estimatedTokens, 0);
}

/** Summary is persisted as one compaction text part; estimate that exact neutral shape. */
export function estimateCompactionSummaryText(text: string) {
  if (!text) return 0;
  const canonicalJson = canonicalStringify([{ role: "system", content: text }]);
  const textTokens = Math.ceil(utf8ByteLength(canonicalJson) / 3);
  // One message and one textual content part, matching the persisted compaction message.
  return Math.ceil((textTokens + 8 + 4) * 1.10);
}
