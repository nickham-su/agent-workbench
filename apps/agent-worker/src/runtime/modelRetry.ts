// 模型重试判定工具.
//
// 约定:
// - 仅当本次请求已经产生了“可见输出”时,才禁止自动重试
// - 文本 delta: 任何非空文本都视为已开始输出
// - tool-call: 一旦产生了有效 tool-call,为避免重复执行带来副作用,视为已开始输出

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
