import type { AgentApi } from "./agent-api.js";
import { CliError } from "./errors.js";
import { completeHistory, projectMessage, type HistoryFrame, type MessageView, type TimelineMessage } from "./messages.js";

export function timelineChanged(): CliError { return new CliError(6, "固定锚点或已输出消息不再属于同一可见分支。", { code: "TIMELINE_CHANGED", phase: "follow", effect: "not_applicable" }); }
export function incomplete(): CliError { return new CliError(6, "无法证明本次消息范围与最终正文完整，已停止本地观察。", { code: "OBSERVATION_INCOMPLETE", phase: "follow" }); }
export function ordered(frame: HistoryFrame): TimelineMessage[] { return [...frame.messages.values()].sort((a, b) => a.depth - b.depth); }
export async function loadThrough(api: AgentApi, frame: HistoryFrame, anchor: string | null): Promise<void> {
  try { await completeHistory(api, frame, anchor === null ? { mode: "last", count: Number.MAX_SAFE_INTEGER } : { mode: "after", messageId: anchor }); }
  catch (error) { if (error instanceof CliError && error.exitCode === 6) throw timelineChanged(); throw error; }
}
export function assertSameRecord(old: TimelineMessage, next: TimelineMessage): void {
  if (old.id !== next.id || old.depth !== next.depth || old.previousMessageId !== next.previousMessageId
    || old.originSessionId !== next.originSessionId || old.originRunId !== next.originRunId || old.type !== next.type
    || next.updatedRevision < old.updatedRevision) throw timelineChanged();
}
export function assertRetained(previous: HistoryFrame, next: HistoryFrame, ids: Iterable<string>): void {
  for (const id of ids) {
    const old = previous.messages.get(id); const current = next.messages.get(id);
    if (!old || !current || current.status === "superseded") throw timelineChanged();
    assertSameRecord(old, current);
  }
}
export function assertVisible(frame: HistoryFrame, messages: Iterable<MessageView>): void {
  for (const previous of messages) {
    const current = frame.messages.get(previous.id);
    if (!current || !projectMessage(current)) throw timelineChanged();
  }
}
export function assertFinal(messages: Iterable<MessageView>): void {
  for (const message of messages) if (message.status === "streaming") throw incomplete();
}
