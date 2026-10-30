import { AgentApi, type ApiDependencies } from "./agent-api.js";
import { writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { CliIO } from "./token-input.js";

export interface ReadCommandDependencies extends ApiDependencies { io: CliIO; json?: boolean; }
export async function listWorkspaces(dependencies: ReadCommandDependencies): Promise<void> {
  const items = await (await AgentApi.connect(dependencies)).workspaces();
  const human = items.map((item) => `Workspace ID：${escapeDisplayText(item.id)}\n名称：${escapeDisplayText(item.name)}\n`).join("\n") + `工作区总数：${items.length}\n`;
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "workspace list", { items, count: items.length }, human, { phase: "discover", effect: "not_applicable" });
}
export async function listAgents(workspaceId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const items = await (await AgentApi.connect(dependencies)).agents(workspaceId);
  const human = `Workspace：${escapeDisplayText(workspaceId)}\n` + items.map((item) => `Agent ID：${escapeDisplayText(item.id)}\n名称：${escapeDisplayText(item.name)}\n用途：${escapeDisplayText(item.summary)}\n`).join("\n") + `Agent 总数：${items.length}\n`;
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "agent list", { workspaceId, items, count: items.length }, human, { phase: "discover", effect: "not_applicable", context: { workspaceId } });
}
export async function showSession(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const data = await (await AgentApi.connect(dependencies)).session(workspaceId, sessionId);
  const human = Object.entries(data).map(([key, value]) => `${key}：${key === "createdAt" || key === "updatedAt" ? new Date(value as number).toISOString() : escapeDisplayText(String(value))}`).join("\n") + "\n";
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "session show", data, human, { phase: "status", effect: "not_applicable", context: { workspaceId, sessionId } });
}
export async function sessionStatus(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const state = await (await AgentApi.connect(dependencies)).runState(workspaceId, sessionId);
  const data = { workspaceId, sessionId, status: state.status };
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "session status", data,
    `Workspace：${escapeDisplayText(workspaceId)}\nSession ID：${escapeDisplayText(sessionId)}\n状态：${state.status}\n`, { phase: "status", effect: "not_applicable", context: { workspaceId, sessionId } });
}
