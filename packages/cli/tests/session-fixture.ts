import type { AgentSessionQueryResponse } from "@agent-workbench/shared/contracts/agent-session-query";
import { parseSessionListOptions, type SessionListQuery } from "../src/session-query.js";

export const defaultQuery = parseSessionListOptions({ workspace: "workspace-example", updatedWithin: "24h" });
export const renewedValue = "v1.cmVuZXdlZC10ZXN0.c2lnbmF0dXJl";
export const renewedHeader = `awb_session=${renewedValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;

export function queryResponse(query: SessionListQuery = defaultQuery, total = 1): AgentSessionQueryResponse {
  const updatedTo = Date.UTC(2026, 0, 2);
  return {
    workspaceId: query.workspaceId, updatedWithinSeconds: query.updatedWithinSeconds,
    updatedFrom: updatedTo - query.updatedWithinSeconds * 1000, updatedTo,
    kind: query.kind, status: query.status, total,
    items: Array.from({ length: total }, (_, index) => ({
      id: `session-${String(total - index).padStart(4, "0")}`,
      title: "示例会话", kind: query.kind === "subtask" ? "subtask" : "primary",
      status: query.status === "running" ? "running" : "idle",
      createdAt: Date.UTC(2025, 11, 31), updatedAt: updatedTo,
      userMessageCount: 2, completedAssistantMessageCount: 8
    }))
  };
}
