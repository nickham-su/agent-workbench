import type { AgentRunStatusResponse, AgentTerminalResultCode } from "@agent-workbench/shared";

/**
 * terminal code 的唯一 Web 映射入口。仅返回本地化 key，绝不把服务端 detail 作为提示正文。
 * detail 仍保留在 DTO 中供未来受控诊断视图使用，但普通 toast 不展示它。
 */
const TERMINAL_MESSAGE_KEYS: Record<AgentTerminalResultCode, string> = {
  run_completed: "agent.runTerminal.run_completed",
  subtask_completed: "agent.runTerminal.subtask_completed",
  compaction_completed: "agent.runTerminal.compaction_completed",
  compaction_not_needed: "agent.runTerminal.compaction_not_needed",
  compaction_no_progress: "agent.runTerminal.compaction_no_progress",
  compaction_oversized_tail: "agent.runTerminal.compaction_oversized_tail",
  compaction_media_requires_resend: "agent.runTerminal.compaction_media_requires_resend",
  compaction_pending_tools: "agent.runTerminal.compaction_pending_tools",
  compaction_failed: "agent.runTerminal.compaction_failed",
  compaction_provider_unavailable: "agent.runTerminal.compaction_provider_unavailable",
  compaction_conflict: "agent.runTerminal.compaction_conflict",
  context_limit_recovery_exhausted: "agent.runTerminal.context_limit_recovery_exhausted",
  context_limit_media_requires_resend: "agent.runTerminal.context_limit_media_requires_resend",
  run_cancelled: "agent.runTerminal.run_cancelled",
  run_enqueue_failed: "agent.runTerminal.run_enqueue_failed",
  run_failed: "agent.runTerminal.run_failed",
  run_startup_recovery_failed: "agent.runTerminal.run_startup_recovery_failed",
  subtask_failed: "agent.runTerminal.subtask_failed",
};

export function agentRunTerminalMessageKey(code: AgentTerminalResultCode | null) {
  return typeof code === "string"
    ? TERMINAL_MESSAGE_KEYS[code as AgentTerminalResultCode] ?? "agent.runTerminal.run_failed"
    : "agent.runTerminal.run_failed";
}

/** 常规用户 Run 的正常完成由对话内容呈现，恢复轮询不额外打扰用户。 */
export function isSilentAgentRunTerminal(run: AgentRunStatusResponse) {
  return run.runKind === "user" && run.status === "completed" && run.code === "run_completed";
}
