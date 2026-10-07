import type { AgentForkSessionRequest, AgentSessionRecord } from "@agent-workbench/shared";

type ForkSession = (request: AgentForkSessionRequest) => Promise<AgentSessionRecord>;

/** 将时间线消息 Fork 的请求构造与成功通知保持为可独立验证的窄操作。 */
export async function runAgentSessionForkAction(input: {
  sourceSessionId: string;
  sourceMessageId: string;
  fork: ForkSession;
  onForked: (session: AgentSessionRecord) => void;
}) {
  const result = await input.fork({
    fromSessionId: input.sourceSessionId,
    fromMessageId: input.sourceMessageId,
  });
  input.onForked(result);
}
