import { AgentApi, sessionRecord } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, isRecord, responseError, withErrorDetails } from "./errors.js";
import { writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import { isId } from "./validation.js";

/** Fork exactly the head observed by the read; the server owns boundary validation. */
export async function forkSession(workspaceId: string, sessionId: string, dependencies: ReadCommandDependencies, unlisted = false): Promise<void> {
  const context = { workspaceId, sessionId };
  try {
    const api = await AgentApi.connect(dependencies);
    const source = await api.session(workspaceId, sessionId);
    if (source.kind !== "primary") throw new CliError(2, "只有主会话允许 Fork；子会话仅允许读取。", { phase: "fork", effect: "not_sent" });
    const expectedVisibility = unlisted || source.visibility === "unlisted" ? "unlisted" : "listed";
    const fromMessageId = source.headMessageId;
    if (fromMessageId === null) throw new CliError(2, "源会话没有可 Fork 的消息。", { phase: "fork", effect: "not_sent" });
    const session = await api.json("/api/agent/sessions/fork", {
      method: "POST", body: { fromSessionId: sessionId, fromMessageId, ...(unlisted ? { visibility: "unlisted" } : {}) },
      phase: "fork", context,
      validate: (value) => {
        if (!isRecord(value) || !isId(value.id) || value.id === "." || value.id === ".." || value.id === sessionId) {
          throw responseError("Fork 会话响应身份无效。");
        }
        const record = sessionRecord(value, workspaceId, value.id);
        if (record.kind !== "primary" || record.forkedFromSessionId !== sessionId
          || record.forkedFromMessageId !== fromMessageId || record.headMessageId !== fromMessageId
          || record.visibility !== expectedVisibility) {
          throw responseError("Fork 会话响应来源或消息边界无效。");
        }
        return record;
      },
      identity: (value) => ({ sessionId: value.id, messageId: fromMessageId })
    });
    const fields = {
      Workspace: workspaceId,
      "Session ID": session.id,
      "来源 Session ID": sessionId,
      "Fork 消息 ID": fromMessageId,
      "会话可见性": session.visibility
    };
    await writeSuccess(dependencies.io,
      "Fork 会话已创建。\n" + Object.entries(fields).map(([key, value]) => `${key}：${escapeDisplayText(value)}`).join("\n") + "\n",
      { phase: "fork", effect: "accepted", context: { workspaceId, sessionId: session.id, messageId: fromMessageId } });
  } catch (error) { throw withErrorDetails(error, { phase: "fork", effect: "not_sent", context }); }
}
