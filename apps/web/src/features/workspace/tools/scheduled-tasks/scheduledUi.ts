export class ScheduledApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly executionId: string | null) { super(code); }
}


export function normalizeTaskSearch(input: string): string {
  return [...input.trim()].slice(0, 100).join("");
}

export type ScheduledErrorAction = "refreshList" | "wait" | "stopWrites" | "revalidateSource" | "keepForm" | "refreshHistory" | "retry";
export type ScheduledErrorPresentation = { text: string; action: ScheduledErrorAction };
/** Never render raw server/Provider error text, identifiers, prompts or unknown response codes. */
export function scheduledErrorPresentation(error: unknown): ScheduledErrorPresentation {
  if (!(error instanceof ScheduledApiError)) return { text: "操作失败，请稍后重试。", action: "retry" };
  switch (error.code) {
    case "SCHEDULE_INVALID": return { text: "计划或输入有误，请检查并重试。", action: "keepForm" };
    case "TASK_TRIGGER_MODE_INVALID": return { text: "执行上下文设置有误，请检查来源后重试。", action: "revalidateSource" };
    case "SOURCE_MESSAGE_INVALID":
    case "SOURCE_UNAVAILABLE": return { text: "来源消息无法使用，请重新校验来源 ID。", action: "revalidateSource" };
    case "SCHEDULED_TASK_NOT_FOUND": return { text: "任务已不存在或不在当前 Workspace，已返回列表。", action: "refreshList" };
    case "CURSOR_INVALID": return { text: "列表位置已失效，已从第一页重新加载。", action: "refreshList" };
    case "TASK_EXECUTION_ALREADY_ACTIVE": return { text: "该任务已有执行正在进行，请等待结束。", action: "refreshHistory" };
    case "TASK_DELETE_EXECUTION_ACTIVE": return { text: "该任务正在执行，请等待结束后再删除。", action: "wait" };
    case "WORKSPACE_DELETING": return { text: "Workspace 正在删除，已停止任务写操作。", action: "stopWrites" };
    case "AGENT_NOT_READY": return { text: "Agent 或其默认模型目前不可用，请检查配置后重试。", action: "keepForm" };
    case "AGENT_WORKER_UNAVAILABLE": return { text: "执行环境暂不可用，请查看执行历史后重试。", action: "refreshHistory" };
    case "SESSION_ID_CONFLICT": return { text: "执行会话已发生变化，请查看执行历史。", action: "refreshHistory" };
    default: return { text: error.status === 404 ? "资源已不可用，请刷新列表。" : "操作失败，请稍后重试。", action: error.status === 404 ? "refreshList" : "retry" };
  }
}
