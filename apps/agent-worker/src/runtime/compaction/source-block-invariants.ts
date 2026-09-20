import type { CompactionSourceBlock } from "./types.js";

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled", "unknown"]);

type SourcePart = CompactionSourceBlock["message"]["parts"][number];
type ToolExecution = CompactionSourceBlock["toolExecutions"][number];
type ReplayEntry = CompactionSourceBlock["providerReplay"][number];
type Attachment = CompactionSourceBlock["attachments"][number];

export class CompactionSourceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionSourceInvariantError";
  }
}

function fail(block: CompactionSourceBlock, message: string): never {
  throw new CompactionSourceInvariantError(`compaction source ${block.sourceMessageId} ${message}`);
}

function sortedParts(block: CompactionSourceBlock) {
  return [...block.message.parts].sort((left, right) => left.position - right.position);
}

function replayPartType(part: SourcePart): "reasoning" | "text" | "function_call" | null {
  if (part.type === "reasoning") return "reasoning";
  if (part.type === "text") return "text";
  if (part.type === "tool_call") return "function_call";
  return null;
}

export type ValidatedCompactionSourceBlock = {
  parts: SourcePart[];
  attachmentsByPartId: ReadonlyMap<string, Attachment>;
  executionsByCallPartId: ReadonlyMap<string, ToolExecution>;
  replayByPartId: ReadonlyMap<string, ReplayEntry["envelope"]>;
};

/**
 * API resolver has already produced a single-snapshot source. This validates the
 * relations that must remain atomic while Worker materializes either Primary or
 * Summary semantics; it never reads history, artifacts, or attachment bytes.
 */
export function validateCompactionSourceBlock(block: CompactionSourceBlock): ValidatedCompactionSourceBlock {
  if (block.message.status !== "completed") fail(block, "contains a non-completed message");
  if (block.message.type === "runtime") fail(block, "contains a runtime message outside the resolved logical context");
  const parts = sortedParts(block);
  const partsById = new Map<string, SourcePart>();
  for (const part of parts) {
    if (partsById.has(part.id)) fail(block, "contains duplicate message part ids");
    partsById.set(part.id, part);
  }

  const attachmentsByPartId = new Map<string, Attachment>();
  for (const attachment of block.attachments) {
    if (attachmentsByPartId.has(attachment.partId)) fail(block, "contains duplicate attachment metadata");
    const part = partsById.get(attachment.partId);
    if (!part || part.type !== "image") fail(block, "contains attachment metadata without an image part");
    if (part.attachmentId !== attachment.attachmentId || part.mediaType !== attachment.mediaType || part.filename !== attachment.filename) {
      fail(block, "contains attachment metadata that does not match its image part");
    }
    attachmentsByPartId.set(attachment.partId, attachment);
  }
  for (const part of parts) {
    if (part.type === "image" && !attachmentsByPartId.has(part.id)) fail(block, "contains an image part without attachment metadata");
  }

  const calls = parts.filter((part) => part.type === "tool_call");
  if (block.message.type !== "assistant" && (calls.length > 0 || block.toolExecutions.length > 0)) {
    fail(block, "contains tool-call state outside an assistant message");
  }
  const executionsByCallPartId = new Map<string, ToolExecution>();
  for (const execution of block.toolExecutions) {
    if (executionsByCallPartId.has(execution.callPartId)) fail(block, "contains duplicate tool executions");
    if (!TERMINAL_TOOL_STATUSES.has(execution.status)) fail(block, "contains an incomplete tool execution");
    executionsByCallPartId.set(execution.callPartId, execution);
  }
  if (calls.length !== executionsByCallPartId.size) fail(block, "has a tool-call and execution set mismatch");
  for (const call of calls) {
    if (!executionsByCallPartId.has(call.id)) fail(block, "contains a tool-call without its execution");
  }

  const replayByPartId = new Map<string, ReplayEntry["envelope"]>();
  for (const replay of block.providerReplay) {
    if (replayByPartId.has(replay.partId)) fail(block, "contains duplicate provider replay entries");
    if (block.message.type !== "assistant") fail(block, "contains provider replay outside an assistant message");
    const part = partsById.get(replay.partId);
    const expected = part == null ? null : replayPartType(part);
    if (!part || !expected || replay.envelope.item.type !== expected) fail(block, "contains provider replay without a matching assistant part");
    replayByPartId.set(replay.partId, replay.envelope);
  }

  return { parts, attachmentsByPartId, executionsByCallPartId, replayByPartId };
}

export function validateCompactionSource(source: { blocks: readonly CompactionSourceBlock[] }) {
  for (const block of source.blocks) validateCompactionSourceBlock(block);
}

export function sourceBlockContainsTriggerMedia(block: CompactionSourceBlock, triggerMessageId: string | null) {
  const validated = validateCompactionSourceBlock(block);
  return block.sourceMessageId === triggerMessageId && validated.attachmentsByPartId.size > 0;
}
