import axios from "axios";
import type { CreateScheduledTaskRequest, ReplaceScheduledTaskRequest, ScheduledExecution, ScheduledSource, ScheduledTask } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import { ScheduledApiError } from "./scheduledUi.js";
export { ScheduledApiError } from "./scheduledUi.js";

async function request<T>(call: () => Promise<{data: T}>): Promise<T> {
  try { return (await call()).data; }
  catch (error) {
    if (!axios.isAxiosError(error)) throw error;
    const data = error.response?.data as {code?: unknown; details?: {executionId?: unknown}} | undefined;
    throw new ScheduledApiError(typeof data?.code === "string" ? data.code : "REQUEST_FAILED", error.response?.status ?? 0,
      typeof data?.details?.executionId === "string" ? data.details.executionId : null);
  }
}
export function scheduledApi(workspaceId: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/scheduled-tasks`;
  const taskUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: (params: {status: "all" | "enabled" | "paused"; q?: string; cursor?: string}) => request<{items: ScheduledTask[]; nextCursor: string | null}>(() => apiClient.get(base, {params})),
    detail: (id: string) => request<{task: ScheduledTask}>(() => apiClient.get(taskUrl(id))),
    create: (body: CreateScheduledTaskRequest) => request<{task: ScheduledTask}>(() => apiClient.post(base, body)),
    replace: (id: string, body: ReplaceScheduledTaskRequest) => request<{task: ScheduledTask}>(() => apiClient.put(taskUrl(id), body)),
    delete: (id: string) => request<void>(() => apiClient.delete(taskUrl(id))),
    setEnabled: (id: string, enabled: boolean) => request<{task: ScheduledTask}>(() => apiClient.post(`${taskUrl(id)}/${enabled ? "enable" : "pause"}`, {})),
    run: (id: string) => request<{execution: ScheduledExecution}>(() => apiClient.post(`${taskUrl(id)}/run`, {})),
    history: (id: string, params: {result: "all" | "completed" | "failed" | "skipped"; triggerType: "all" | "scheduled" | "manual"; cursor?: string}) => request<{items: ScheduledExecution[]; nextCursor: string | null}>(() => apiClient.get(`${taskUrl(id)}/executions`, {params})),
    readyAgents: () => request<{agentIds: string[]}>(() => apiClient.get(`${base}/ready-agents`)),
    validateSource: (sessionId: string, messageId: string) => request<{source: ScheduledSource}>(() => apiClient.post(`${base}/validate-source`, {sessionId, messageId})),
    serverTime: () => request<{now: number; protocolVersion: 1}>(() => apiClient.get(`${base}/server-time`))
  };
}
