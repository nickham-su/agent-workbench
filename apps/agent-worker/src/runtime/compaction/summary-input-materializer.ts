import { validateCompactionSourceBlock } from "./source-block-invariants.js";
import { projectCompactionToolExecutionResult } from "./tool-execution-result.js";
import type { CompactionSourceBlock, SummaryInputBlock, SummaryInputMessage, SummaryInputPart } from "./types.js";
export { SUMMARY_INPUT_MATERIALIZER_VERSION } from "./types.js";

const REPLAY_ONLY_ASSISTANT_PLACEHOLDER = "[Prior assistant replay state omitted from summary input]";

/**
 * Summary semantics deliberately retain visible tool input/output and user text
 * because these are the summarizer's business input. It never includes replay,
 * encrypted reasoning, provider options, attachment IDs, paths, or bytes.
 */
export function materializeSummaryInputBlock(block: CompactionSourceBlock): SummaryInputBlock {
  const validated = validateCompactionSourceBlock(block);
  const messages: SummaryInputMessage[] = [];
  if (block.message.type === "user") {
    const content: SummaryInputPart[] = [];
    for (const part of validated.parts) {
      if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
      if (part.type === "image") content.push({ type: "attachment", mediaType: part.mediaType, filename: part.filename });
    }
    if (content.length > 0) messages.push({ role: "user", content });
  } else if (block.message.type === "system" || block.message.type === "compaction") {
    const content = validated.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (content) messages.push({ role: "system", content });
  } else if (block.message.type === "assistant") {
    const content: SummaryInputPart[] = [];
    const toolContent: SummaryInputPart[] = [];
    for (const part of validated.parts) {
      if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
      if (part.type === "reasoning" && part.text) content.push({ type: "reasoning", text: part.text });
      if (part.type !== "tool_call") continue;
      content.push({ type: "tool-call", toolName: part.toolName, input: part.input });
      const execution = validated.executionsByCallPartId.get(part.id);
      if (!execution) throw new Error("validated tool execution unexpectedly missing");
      toolContent.push({ type: "tool-result", toolName: part.toolName, output: projectCompactionToolExecutionResult(execution) });
    }
    const hasReasoningReplay = validated.parts.some((part) =>
      part.type === "reasoning"
      && validated.replayByPartId.get(part.id)?.item.type === "reasoning",
    );
    if (content.length === 0 && hasReasoningReplay) {
      content.push({ type: "text", text: REPLAY_ONLY_ASSISTANT_PLACEHOLDER });
    }
    if (content.length > 0) messages.push({ role: "assistant", content });
    if (toolContent.length > 0) messages.push({ role: "tool", content: toolContent });
  }
  return { sourceBlockId: block.sourceMessageId, messages, isProjectionEmpty: messages.length === 0 };
}

export function materializeSummaryInputBlocks(blocks: readonly CompactionSourceBlock[]) {
  return blocks.map((block) => materializeSummaryInputBlock(block));
}
