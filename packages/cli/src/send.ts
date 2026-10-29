import { randomUUID } from "node:crypto";
import { AgentApi, selectAgent, sessionRecord } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, isRecord, responseError, withErrorDetails, type ErrorContext } from "./errors.js";
import { imageFormData, prepareInput, preparePayload, type InputOptions, type PreparedInput } from "./input.js";
import { writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { TokenInput } from "./token-input.js";
import { encodeId, isId } from "./validation.js";

export interface SendOptions { workspaceId: string; sessionId?: string; agentId?: string; }
export interface PreparedSend { input: PreparedInput; clientRequestId: string; }
export interface SendAcceptance {
  workspaceId: string; sessionId: string; agentId: string; messageId: string; runId: string;
  clientRequestId: string; sessionCreated: boolean; accepted: true; deduplicated: false;
}
const isPathId = (value: unknown): value is string => isId(value) && value !== "." && value !== "..";
/** Called before even constructing the config store. Final selected-Agent size is checked again before create. */
export async function prepareSend(options: SendOptions & InputOptions, stdin: TokenInput): Promise<PreparedSend> {
  const input = await prepareInput(options, stdin);
  const clientRequestId = randomUUID();
  preparePayload(input, options.workspaceId, options.agentId ?? "", clientRequestId);
  return { input, clientRequestId };
}

/** Acceptance is separate from rendering so follow can reuse this exact one-shot write path. */
export async function acceptSend(options: SendOptions, prepared: PreparedSend, dependencies: ReadCommandDependencies): Promise<{ api: AgentApi; data: SendAcceptance }> {
  const { workspaceId } = options;
  const { input, clientRequestId } = prepared;
  let sessionId = options.sessionId;
  const context = (): ErrorContext => ({ workspaceId, clientRequestId, ...(sessionId ? { sessionId } : {}) });
  try {
    const api = await AgentApi.connect(dependencies);
    const agent = selectAgent(await api.agents(workspaceId), options.agentId);
    const payload = preparePayload(input, workspaceId, agent.id, clientRequestId);
    // Construct multipart before create as well; uploads never reopen the original local files.
    const formData = input.images.length ? imageFormData(input, payload) : undefined;
    if (sessionId !== undefined) {
      const session = await api.session(workspaceId, sessionId);
      if (session.kind !== "primary") throw new CliError(2, "只能向主会话发送消息；子会话仅允许读取。", { phase: "send", effect: "not_sent" });
    } else {
      const session = await api.json("/api/agent/sessions", {
        method: "POST", body: { workspaceId }, phase: "create", context: context(),
        validate: (value) => {
          if (!isRecord(value) || !isPathId(value.id)) throw responseError("创建会话响应身份无效。");
          const record = sessionRecord(value, workspaceId, value.id);
          if (record.kind !== "primary") throw responseError("创建会话响应不是主会话。");
          return record;
        }, identity: (value) => ({ sessionId: value.id })
      });
      sessionId = session.id;
    }
    const accepted = await api.json(`/api/agent/sessions/${encodeId(sessionId)}/messages`, {
      method: "POST", ...(formData ? { formData } : { body: payload }), phase: "send", context: context(),
      validate: (value) => {
        if (!isRecord(value) || value.sessionId !== sessionId || !isPathId(value.messageId) || !isPathId(value.runId) || typeof value.deduplicated !== "boolean") throw responseError("发送响应身份或结构无效，无法确认完整受理信息。");
        return { sessionId: value.sessionId as string, messageId: value.messageId, runId: value.runId, deduplicated: value.deduplicated };
      },
      identity: (value) => ({ sessionId: value.sessionId, messageId: value.messageId, runId: value.runId, ...(value.deduplicated ? {} : { agentId: agent.id }) })
    });
    if (accepted.deduplicated) throw new CliError(6, "收到无法证明原 Agent 身份的去重响应，已停止；不要自动重发。", {
      phase: "send", effect: "accepted", context: { ...context(), messageId: accepted.messageId, runId: accepted.runId }
    });
    return { api, data: { workspaceId, sessionId, agentId: agent.id, messageId: accepted.messageId, runId: accepted.runId,
      clientRequestId, sessionCreated: options.sessionId === undefined, accepted: true, deduplicated: false } };
  } catch (error) { throw withErrorDetails(error, { phase: "send", effect: "not_sent", context: context() }); }
}
export async function sendMessage(options: SendOptions, prepared: PreparedSend, dependencies: ReadCommandDependencies): Promise<void> {
  const { data } = await acceptSend(options, prepared, dependencies);
  const human = `已受理，不代表后台执行成功。\n` + Object.entries(data).map(([key, value]) => `${key}：${escapeDisplayText(String(value))}`).join("\n") + "\n";
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "session send", data, human, { phase: "send", effect: "accepted", context: { workspaceId: data.workspaceId, sessionId: data.sessionId, agentId: data.agentId, messageId: data.messageId, runId: data.runId, clientRequestId: data.clientRequestId } });
}
