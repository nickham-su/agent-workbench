import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunStatusResponse, AgentTerminalResultCode } from "@agent-workbench/shared";
import { agentRunTerminalMessageKey, isSilentAgentRunTerminal } from "./agentRunTerminalPresentation.js";

const codes: AgentTerminalResultCode[] = [
  "run_completed", "subtask_completed", "compaction_completed", "compaction_not_needed",
  "compaction_no_progress", "compaction_oversized_tail", "compaction_media_requires_resend",
  "compaction_pending_tools", "compaction_failed", "compaction_provider_unavailable",
  "compaction_conflict", "context_limit_recovery_exhausted", "context_limit_media_requires_resend",
  "run_cancelled", "run_enqueue_failed", "run_failed", "run_startup_recovery_failed", "subtask_failed",
];

const userCompleted: AgentRunStatusResponse = {
  workspaceId: "ws", sessionId: "session", runId: "run", runKind: "user",
  status: "completed", code: "run_completed", detail: null, updatedAt: 1,
};

test("全部冻结 terminal code 都有稳定的 i18n 映射", () => {
  for (const code of codes) assert.match(agentRunTerminalMessageKey(code), /^agent\.runTerminal\./);
});

test("仅正常 user completed 静默，manual 和失败/取消必须消费", () => {
  assert.equal(agentRunTerminalMessageKey("unknown" as AgentTerminalResultCode), "agent.runTerminal.run_failed");
  assert.equal(isSilentAgentRunTerminal(userCompleted), true);
  assert.equal(isSilentAgentRunTerminal({ ...userCompleted, runKind: "manual_compaction", code: "compaction_completed" }), false);
  assert.equal(isSilentAgentRunTerminal({ ...userCompleted, status: "failed", code: "run_failed" }), false);
});
