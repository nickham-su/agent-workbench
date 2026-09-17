import type { AgentGlobalPromptItem } from "@agent-workbench/shared/internal-contracts/agent-api-session";

export type AgentSlashSendAction =
  { kind: "compact" } | { kind: "send"; text: string };

/**
 * 发送时的 slash 语义。候选选择仅负责编辑器内容，不能作为发送语义的唯一来源：
 * 非展开的全局 prompt 必须在这里以精确命令重新展开。
 */
export function resolveAgentSlashSendAction(params: {
  text: string;
  promptCommands: ReadonlyMap<string, AgentGlobalPromptItem>;
}): AgentSlashSendAction {
  const text = params.text.trim();
  const normalized = text.toLowerCase();

  // 内建命令优先，不能被同名自定义 prompt 覆盖。
  if (normalized === "/compact") return { kind: "compact" };
  if (!normalized.startsWith("/")) return { kind: "send", text };

  const command = normalized.slice(1);
  const prompt = params.promptCommands.get(command);
  // 未知命令或带参数的 slash 都是普通消息，保持用户原文。
  if (!prompt || command.includes(" ")) return { kind: "send", text };
  if (prompt.expandOnSelect === false)
    return { kind: "send", text: prompt.prompt };
  return { kind: "send", text };
}
