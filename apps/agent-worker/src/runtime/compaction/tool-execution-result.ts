import type { CompactionToolExecutionResult, CompactionToolResultOutput } from "./types.js";

// Keep these literals byte-for-byte aligned with RuntimeTranscriptProjector.
// This Worker-only helper avoids coupling compaction planning to API runtime code.
export const UNKNOWN_TOOL_EXECUTION_RESULT = [
  "Tool execution outcome is unknown because the runtime was interrupted.",
  "The operation may or may not have completed and may have produced side effects.",
  "Inspect the current workspace state before deciding whether to retry or take another action.",
].join("\n");
export const CANCELLED_TOOL_EXECUTION_RESULT = "工具调用在执行前被取消，未执行";
export const FAILED_TOOL_EXECUTION_RESULT = "工具调用失败，未提供额外错误信息。";
export const EMPTY_COMPLETED_TOOL_EXECUTION_RESULT = "工具调用已成功完成，但未返回文本结果。";

function reliableText(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

/** Exact semantic counterpart of API RuntimeTranscriptProjector.projectToolExecutionResult(). */
export function projectCompactionToolExecutionResult(execution: CompactionToolExecutionResult): CompactionToolResultOutput {
  const error = reliableText(execution.error);
  const preview = reliableText(execution.resultPreview);
  switch (execution.status) {
    case "unknown":
      return { type: "error-text", value: preview ? `${UNKNOWN_TOOL_EXECUTION_RESULT}\n\nReliable result preview:\n${preview}` : UNKNOWN_TOOL_EXECUTION_RESULT };
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
