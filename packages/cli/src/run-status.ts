import { isAgentTerminalCodeAllowed, type AgentRunKind, type AgentRunStatusResponse, type AgentTerminalResultCode } from "@agent-workbench/shared";
import type { AgentApi } from "./agent-api.js";
import { isRecord, responseError } from "./errors.js";
import { encodeId, isId, isTimestamp } from "./validation.js";

export type ObservedRun = AgentRunStatusResponse;
export function parseRun(value: unknown, workspaceId: string, sessionId: string, runId: string, expectedKind?: AgentRunKind): ObservedRun {
  if (!isRecord(value) || value.workspaceId !== workspaceId || value.sessionId !== sessionId || value.runId !== runId
    || (value.runKind !== "user" && value.runKind !== "subtask" && value.runKind !== "manual_compaction") || (expectedKind && value.runKind !== expectedKind)
    || !isTimestamp(value.updatedAt) || value.detail !== null) throw responseError("指定 Run 的响应身份或结构无效。");
  const runKind = value.runKind as AgentRunKind;
  if (value.status === "running" && value.code === null) return { workspaceId, sessionId, runId, runKind, updatedAt: value.updatedAt, status: "running", code: null, detail: null };
  if ((value.status === "completed" || value.status === "failed" || value.status === "cancelled") && typeof value.code === "string"
    && isAgentTerminalCodeAllowed(runKind, value.status, value.code as AgentTerminalResultCode)) {
    return { workspaceId, sessionId, runId, runKind, updatedAt: value.updatedAt, status: value.status, code: value.code as AgentTerminalResultCode, detail: null };
  }
  throw responseError("指定 Run 的状态与终态结果码不符合公开契约。");
}
export async function readRun(api: AgentApi, workspaceId: string, sessionId: string, runId: string, expectedKind?: AgentRunKind): Promise<ObservedRun> {
  if (!isId(runId) || runId === "." || runId === "..") throw responseError("指定 Run 的响应标识不能构成有效路径段。");
  return api.json(`/api/agent/sessions/${encodeId(sessionId)}/runs/${encodeId(runId)}?${new URLSearchParams({ workspaceId })}`, {
    phase: "follow", context: { workspaceId, sessionId, runId }, validate: (value) => parseRun(value, workspaceId, sessionId, runId, expectedKind)
  });
}
