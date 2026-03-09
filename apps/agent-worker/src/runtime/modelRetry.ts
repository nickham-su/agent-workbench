// 模型重试判定工具.
//
// 约定:
// - 文本 delta: 任何非空文本都视为已开始输出
// - tool-call: 一旦产生了有效 tool-call,为避免重复执行带来副作用,视为已开始输出
// - assistant 续写仅允许“最近一次、已有文本、且没有 tool-call”的 failed assistant 进入 prompt

export function chunkStartsVisibleOutput(chunk: unknown, availableToolNames: ReadonlySet<string>): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const value = chunk as Record<string, unknown>;
  const type = String(value.type || "");

  if (type === "text-delta") {
    const delta = String(value.text || "");
    return delta.length > 0;
  }

  if (type === "tool-call") {
    const rawName = String((value as any).toolName || "").trim();
    if (!rawName) return false;
    return availableToolNames.has(rawName);
  }

  // 注意: 不把 error/finish 视为“可见输出”,避免仅 error chunk 的失败无法重试。
  return false;
}

export function buildRetryMessages(params: {
  baseMessages: Array<Record<string, unknown>>;
  text: string;
  toolCalls: number;
  retryCount: number;
  maxRetries: number;
}) {
  if (!shouldRetryAfterPartialText({ text: params.text, toolCalls: params.toolCalls, retryCount: params.retryCount, maxRetries: params.maxRetries })) {
    return params.baseMessages;
  }
  return [...params.baseMessages, { role: "assistant", content: params.text }];
}

export function shouldRetryAfterPartialText(params: {
  text: string;
  toolCalls: number;
  retryCount: number;
  maxRetries: number;
}) {
  const text = String(params.text || "").trim();
  if (!text) return false;
  if (!Number.isFinite(params.maxRetries) || params.maxRetries <= 0) return false;
  if (!Number.isFinite(params.retryCount) || params.retryCount < 0) return false;
  if (params.retryCount >= params.maxRetries) return false;
  return params.toolCalls <= 0;
}
