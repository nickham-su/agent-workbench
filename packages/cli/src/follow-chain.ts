import { assertMessageAppend } from "./message-render.js";
import { CliError } from "./errors.js";
import type { HistoryFrame, MessageView, TimelineMessage } from "./messages.js";

export function timelineChanged(): CliError { return new CliError(6, "固定锚点或已输出消息不再属于同一可见分支。", { code: "TIMELINE_CHANGED", phase: "follow", effect: "not_applicable" }); }
export function incomplete(): CliError { return new CliError(6, "无法证明本次消息范围与最终正文完整，已停止本地观察。", { code: "OBSERVATION_INCOMPLETE", phase: "follow" }); }
export function ordered(frame: HistoryFrame): TimelineMessage[] { return [...frame.messages.values()].sort((a, b) => a.depth - b.depth); }
export function assertSameRecord(old: TimelineMessage, next: TimelineMessage): void {
  if (next.status === "superseded") throw timelineChanged();
  assertMessageAppend(old, next);
  if (old.id !== next.id || old.depth !== next.depth || old.previousMessageId !== next.previousMessageId || old.replacesMessageId !== next.replacesMessageId
    || old.originSessionId !== next.originSessionId || old.originRunId !== next.originRunId || old.type !== next.type
    || next.updatedRevision < old.updatedRevision) throw timelineChanged();
}
export function assertFinal(messages: Iterable<MessageView>): void {
  for (const message of messages) if (message.status === "streaming") throw incomplete();
}
