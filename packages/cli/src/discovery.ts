import { AgentApi, type ApiDependencies } from "./agent-api.js";
import { writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { CliIO } from "./token-input.js";

export interface ReadCommandDependencies extends ApiDependencies { io: CliIO; }
export async function listWorkspaces(dependencies: ReadCommandDependencies): Promise<void> {
  const items = await (await AgentApi.connect(dependencies)).workspaces();
  const human = items.map((item) => `Workspace ID：${escapeDisplayText(item.id)}\n名称：${escapeDisplayText(item.name)}\n`).join("\n") + `工作区总数：${items.length}\n`;
  await writeSuccess(dependencies.io, human, { phase: "discover", effect: "not_applicable" });
}
export async function listAgents(workspaceId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const items = await (await AgentApi.connect(dependencies)).agents(workspaceId);
  const human = `Workspace：${escapeDisplayText(workspaceId)}\n` + items.map((item) => `Agent ID：${escapeDisplayText(item.id)}\n名称：${escapeDisplayText(item.name)}\n用途：${escapeDisplayText(item.summary)}\n`).join("\n") + `Agent 总数：${items.length}\n`;
  await writeSuccess(dependencies.io, human, { phase: "discover", effect: "not_applicable", context: { workspaceId } });
}
export async function showSession(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const data = await (await AgentApi.connect(dependencies)).session(workspaceId, sessionId);
  const fields = { "Session ID": data.id, Workspace: data.workspaceId, "类型": data.kind, "标题": data.title,
    "Fork 来源 Session": data.forkedFromSessionId ?? "无",
    "创建时间": new Date(data.createdAt).toISOString(), "最近更新时间": new Date(data.updatedAt).toISOString() };
  const human = Object.entries(fields).map(([key, value]) => `${key}：${escapeDisplayText(String(value))}`).join("\n") + "\n";
  await writeSuccess(dependencies.io, human, { phase: "status", effect: "not_applicable", context: { workspaceId, sessionId } });
}
export async function sessionStatus(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const state = await (await AgentApi.connect(dependencies)).runState(workspaceId, sessionId);
  await writeSuccess(dependencies.io,
    `Workspace：${escapeDisplayText(workspaceId)}\nSession ID：${escapeDisplayText(sessionId)}\n状态：${state.status}\n`, { phase: "status", effect: "not_applicable", context: { workspaceId, sessionId } });
}
