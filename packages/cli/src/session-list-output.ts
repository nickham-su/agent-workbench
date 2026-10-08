import type { AgentSessionQueryResponse } from "@agent-workbench/shared/contracts/agent-session-query";

/** Keep user-controlled text on one visible line without truncating its content. */
export function escapeDisplayText(value: string): string {
  const escapes: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  return value.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) =>
    escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function renderSessionList(response: AgentSessionQueryResponse, duration: string): string {
  const lines = [
    `Workspace：${escapeDisplayText(response.workspaceId)}`,
    `筛选：最近 ${duration}；类型 ${response.kind}；状态 ${response.status}`,
    `更新时间范围：${new Date(response.updatedFrom).toISOString()} 至 ${new Date(response.updatedTo).toISOString()}（含两端）`,
    `匹配总数：${response.total}`,
    ""
  ];
  for (const item of response.items) {
    lines.push(
      `Session ID：${escapeDisplayText(item.id)}`,
      `标题：${item.title.length === 0 ? "（空标题）" : escapeDisplayText(item.title)}`,
      `类型：${item.kind}`,
      `状态：${item.status}`,
      `最近更新时间：${new Date(item.updatedAt).toISOString()}`,
      `用户消息累计数：${item.userMessageCount}`,
      `已完成助手消息累计数：${item.completedAssistantMessageCount}`,
      ""
    );
  }
  lines.push(`查询结束：已输出 ${response.total} 个 Session。`, "");
  return lines.join("\n");
}
