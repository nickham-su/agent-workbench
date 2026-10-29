import { randomUUID } from "node:crypto";
import { AgentApi, runState, selectAgent, sessionRecord } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, isRecord, responseError, withErrorDetails, type ErrorContext, type CliExitCode } from "./errors.js";
import { followAccepted } from "./follow.js";
import type { FollowOptions } from "./follow-lifetime.js";
import { writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import { encodeId, isId } from "./validation.js";

function controlResult(value: unknown, workspaceId: string, sessionId: string) {
  if (!isRecord(value) || value.ok !== true) throw responseError("会话控制响应结构无效。");
  return { session: sessionRecord(value.session, workspaceId, sessionId), runState: runState(value.runState, workspaceId, sessionId) };
}
export async function cancelSession(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies): Promise<void> {
  const context = { workspaceId, sessionId };
  try {
    const api = await AgentApi.connect(dependencies);
    if ((await api.session(workspaceId, sessionId)).kind !== "primary") throw new CliError(2, "CLI 只允许取消主会话，子会话仅允许读取。", { phase: "cancel", effect: "not_sent" });
    const result = await api.json(`/api/agent/sessions/${encodeId(sessionId)}/cancel`, {
      method: "POST", body: { workspaceId }, phase: "cancel", context, validate: (value) => controlResult(value, workspaceId, sessionId)
    });
    const data = { workspaceId, sessionId, requested: true, status: result.runState.status };
    await writeSuccess(dependencies.io, Boolean(dependencies.json), "session cancel", data,
      "已提交主会话取消：作用于服务端处理时的当前执行及活动后代；不回滚文件。\n预查与提交存在竞态，不保证是此前观察到的 Run。\n", { phase: "cancel", effect: "accepted", context });
  } catch (error) { throw withErrorDetails(error, { phase: "cancel", effect: "not_sent", context }); }
}
interface CompactAcceptance {
  workspaceId: string; sessionId: string; agentId: string; runId: string; clientRequestId: string;
  accepted: true; scheduled: true; deduplicated: false;
}
export async function acceptCompact(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies) {
  const clientRequestId = randomUUID();
  const context: ErrorContext = { workspaceId, sessionId, clientRequestId };
  try {
    const api = await AgentApi.connect(dependencies);
    const session = await api.session(workspaceId, sessionId);
    if (session.kind !== "primary") throw new CliError(2, "只有主会话允许手动压缩。", { phase: "compact", effect: "not_sent" });
    if ((await api.runState(workspaceId, sessionId)).status !== "idle") throw new CliError(6, "会话正在运行，不能手动压缩；不排队。", { code: "HTTP_REJECTED", serviceCode: "SESSION_RUNNING", phase: "compact", effect: "not_sent" });
    const agent = selectAgent(await api.agents(workspaceId));
    const result = await api.json(`/api/agent/sessions/${encodeId(sessionId)}/compact`, {
      method: "POST", body: { workspaceId, clientRequestId, agentId: agent.id }, phase: "compact", context,
      validate: (value) => {
        const result = controlResult(value, workspaceId, sessionId);
        if (!isRecord(value) || !isId(value.runId) || value.runId === "." || value.runId === ".." || typeof value.scheduled !== "boolean"
          || (value.skippedReason !== undefined && value.skippedReason !== "deduplicated")
          || (value.scheduled ? value.skippedReason !== undefined : value.skippedReason !== "deduplicated")) throw responseError("压缩响应身份或受理状态无效。");
        return { ...result, runId: value.runId, scheduled: value.scheduled };
      }, identity: (value) => ({ runId: value.runId, ...(value.scheduled ? { agentId: agent.id } : {}) })
    });
    if (!result.scheduled) throw new CliError(6, "收到无法证明原 Agent 身份的压缩去重响应，已停止；这不表示无需压缩。", { phase: "compact", effect: "accepted", context: { ...context, runId: result.runId } });
    const data: CompactAcceptance = { workspaceId, sessionId, agentId: agent.id, runId: result.runId, clientRequestId, accepted: true, scheduled: true, deduplicated: false };
    return { api, data, anchor: session.headMessageId };
  } catch (error) { throw withErrorDetails(error, { phase: "compact", effect: "not_sent", context }); }
}
export async function compactSession(workspaceId: string, sessionId: string, options: FollowOptions, dependencies: ReadCommandDependencies): Promise<CliExitCode> {
  if (options.follow) return followAccepted("session compact", async (signal) => {
    const { api, data, anchor } = await acceptCompact(workspaceId, sessionId, { ...dependencies, signal });
    return { api, identity: { workspaceId, sessionId, agentId: data.agentId, runId: data.runId, clientRequestId: data.clientRequestId }, anchor };
  }, options, dependencies);
  const { data } = await acceptCompact(workspaceId, sessionId, dependencies);
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "session compact", data,
    "已启动手动压缩 Run（不是排队），不代表已经改变上下文；原消息历史和工作区文件不删除。\n"
    + Object.entries(data).map(([key, value]) => `${key}：${escapeDisplayText(String(value))}`).join("\n") + "\n", { phase: "compact", effect: "accepted", context: { workspaceId, sessionId, runId: data.runId, agentId: data.agentId, clientRequestId: data.clientRequestId } });
  return 0;
}
