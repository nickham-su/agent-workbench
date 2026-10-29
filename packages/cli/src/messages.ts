import type { AgentMessageStatus, AgentMessageType, AgentSessionRecord } from "@agent-workbench/shared";
import { AgentApi, sessionRecord } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, isRecord, responseError, withErrorDetails } from "./errors.js";
import { displayBody, writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import { encodeId, isCount, isId, isTimestamp, validateId } from "./validation.js";

export type VisiblePart = { type: "text"; text: string } | { type: "image"; attachmentId: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; filename: string };
export interface MessageView {
  id: string; type: AgentMessageType; status: AgentMessageStatus; originSessionId: string | null; originRunId: string | null;
  previousMessageId: string | null; depth: number; updatedRevision: number; createdAt: number; updatedAt: number; parts: VisiblePart[];
}
/** Internal chain records keep even invisible rows, but never reasoning or tool input. */
export interface TimelineMessage extends MessageView { replacesMessageId: string | null; }
export interface TimelinePage { session: AgentSessionRecord; timelineReset: boolean; messages: TimelineMessage[]; hasMore: boolean; nextBeforeMessageId: string | null; }
export type MessageSelection = { mode: "last"; count: number } | { mode: "after"; messageId: string };
export interface HistoryFrame {
  workspaceId: string; sessionId: string;
  /** Immutable first snapshot: its revision remains the future follow delta watermark. */
  initial: TimelinePage;
  messages: Map<string, TimelineMessage>;
  hasMore: boolean; nextBeforeMessageId: string | null;
}
const nullableId = (value: unknown): value is string | null => value === null || isId(value);
const messageTypes = new Set(["user", "assistant", "system", "compaction", "runtime"]);
const messageStatuses = new Set(["streaming", "completed", "failed", "cancelled", "superseded"]);
export function parseMessage(value: unknown, workspaceId: string): TimelineMessage {
  if (!isRecord(value) || !isId(value.id) || value.workspaceId !== workspaceId || !nullableId(value.previousMessageId)
    || !nullableId(value.replacesMessageId) || !nullableId(value.originSessionId) || !nullableId(value.originRunId)
    || !isCount(value.depth) || !isCount(value.updatedRevision) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || !messageTypes.has(value.type as string) || !messageStatuses.has(value.status as string) || !Array.isArray(value.parts)) throw responseError("消息响应身份或结构无效。");
  if (value.type === "compaction" && (value.status !== "completed" || value.previousMessageId === null || value.replacesMessageId !== null || !nullableId(value.retainedFromMessageId)
    || value.parts.length !== 1 || !isRecord(value.parts[0]) || value.parts[0].type !== "text" || value.parts[0].position !== 0 || typeof value.parts[0].text !== "string" || !value.parts[0].text)) throw responseError("压缩消息结构无效。");
  const ids = new Set<string>();
  const positions = new Set<number>();
  const parts: { position: number; part: VisiblePart }[] = [];
  for (const item of value.parts) {
    if (!isRecord(item) || !isId(item.id) || item.messageId !== value.id || !isCount(item.position) || !isCount(item.updatedRevision)
      || !isTimestamp(item.createdAt) || !isTimestamp(item.updatedAt) || ids.has(item.id) || positions.has(item.position)) throw responseError("消息内容身份、顺序或版本无效。");
    ids.add(item.id); positions.add(item.position);
    if (item.type === "text" || item.type === "reasoning") {
      if (typeof item.text !== "string") throw responseError("消息文本结构无效。");
      if (item.type === "text") parts.push({ position: item.position, part: { type: "text", text: item.text } });
    } else if (item.type === "image") {
      if (!isId(item.attachmentId) || !["image/png", "image/jpeg", "image/webp"].includes(item.mediaType as string) || typeof item.filename !== "string" || !item.filename) throw responseError("消息图片结构无效。");
      parts.push({ position: item.position, part: { type: "image", attachmentId: item.attachmentId, mediaType: item.mediaType as "image/png" | "image/jpeg" | "image/webp", filename: item.filename } });
    } else if (item.type === "tool_call") {
      if (!isId(item.toolName) || !isRecord(item.input) || !nullableId(item.providerToolCallId)) throw responseError("消息工具部分结构无效。");
    } else throw responseError("消息包含未知内容类型。");
  }
  return { id: value.id, type: value.type as AgentMessageType, status: value.status as AgentMessageStatus,
    originSessionId: value.originSessionId, originRunId: value.originRunId, previousMessageId: value.previousMessageId,
    replacesMessageId: value.replacesMessageId, depth: value.depth, updatedRevision: value.updatedRevision,
    createdAt: value.createdAt, updatedAt: value.updatedAt, parts: parts.sort((a, b) => a.position - b.position).map((item) => item.part) };
}
export function projectMessage(message: TimelineMessage): MessageView | null {
  if (message.status === "superseded" || (message.type !== "user" && message.type !== "assistant")
    || (message.type === "user" ? !message.parts.length : !message.parts.some((part) => part.type === "image" || part.text.trim()))) return null;
  const { replacesMessageId: _replaced, ...view } = message;
  return view;
}
export function parseTimeline(value: unknown, workspaceId: string, sessionId: string): TimelinePage {
  if (!isRecord(value) || typeof value.timelineReset !== "boolean" || !Array.isArray(value.messages) || !Array.isArray(value.toolExecutions)
    || typeof value.hasMore !== "boolean" || !nullableId(value.nextBeforeMessageId)) throw responseError("消息分页响应结构无效。");
  const session = sessionRecord(value.session, workspaceId, sessionId);
  const messages = value.messages.map((message: unknown) => parseMessage(message, workspaceId));
  const ids = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (ids.has(message.id) || (i > 0 && message.depth <= messages[i - 1].depth)) throw responseError("消息页包含重复 ID 或顺序异常。");
    ids.add(message.id);
  }
  if (value.hasMore && (!messages.length || value.nextBeforeMessageId !== messages[0].id)) throw responseError("消息分页缺少有效的前进游标。");
  if (!messages.length && value.nextBeforeMessageId !== null) throw responseError("空消息页携带无效游标。");
  return { session, messages, timelineReset: value.timelineReset, hasMore: value.hasMore, nextBeforeMessageId: value.nextBeforeMessageId };
}
export type TimelineRequest = { mode: "snapshot" | "before" | "delta"; beforeMessageId?: string; sinceRevision?: number; knownHeadMessageId?: string; knownContextRootMessageId?: string; knownContextRootIsNull?: true; limit?: number; };
export async function readTimeline(api: AgentApi, workspaceId: string, sessionId: string, request: TimelineRequest): Promise<TimelinePage> {
  const query = new URLSearchParams({ workspaceId, mode: request.mode, limit: String(request.limit ?? 100) });
  for (const [key, value] of Object.entries(request)) if (key !== "mode" && key !== "limit" && value !== undefined) query.set(key, String(value));
  return api.json(`/api/agent/sessions/${encodeId(sessionId)}/timeline?${query}`, { phase: "history", context: { workspaceId, sessionId }, validate: (value) => parseTimeline(value, workspaceId, sessionId) });
}
export async function readMessage(api: AgentApi, workspaceId: string, sessionId: string, messageId: string): Promise<TimelineMessage> {
  return api.json(`/api/agent/sessions/${encodeId(sessionId)}/messages/${encodeId(messageId)}?${new URLSearchParams({ workspaceId })}`, {
    phase: "history", context: { workspaceId, sessionId }, validate: (value) => {
      if (!isRecord(value)) throw responseError("消息详情响应无效。");
      const message = parseMessage(value.message, workspaceId);
      if (message.id !== messageId) throw responseError("消息详情响应 ID 不一致。");
      return message;
    }
  });
}
function changed(message = "消息分支或分页游标已变化，未输出不完整结果。"): CliError { return new CliError(6, message, { code: "TIMELINE_CHANGED", phase: "history", effect: "not_applicable" }); }
function checkChain(messages: TimelineMessage[]): void {
  for (let i = 1; i < messages.length; i++) if (messages[i].previousMessageId !== messages[i - 1].id || messages[i].depth <= messages[i - 1].depth) throw changed();
}
export async function startHistory(api: AgentApi, workspaceId: string, sessionId: string, initial?: TimelinePage): Promise<HistoryFrame> {
  const page = initial ?? await readTimeline(api, workspaceId, sessionId, { mode: "snapshot" });
  checkChain(page.messages);
  if (page.timelineReset || (page.session.headMessageId === null ? page.messages.length > 0 || page.hasMore : page.messages.at(-1)?.id !== page.session.headMessageId)) throw changed("首消息快照的 head 与内容不一致。");
  if (!page.hasMore && page.messages.length && page.messages[0].previousMessageId !== null) throw changed("消息快照缺少链首前缀。");
  return { workspaceId, sessionId, initial: page, messages: new Map(page.messages.map((message) => [message.id, message])), hasMore: page.hasMore, nextBeforeMessageId: page.nextBeforeMessageId };
}
export function selectHistory(frame: HistoryFrame, selection: MessageSelection): MessageView[] | null {
  const raw = [...frame.messages.values()].sort((a, b) => a.depth - b.depth);
  if (selection.mode === "after") {
    const index = raw.findIndex((message) => message.id === selection.messageId);
    return index < 0 ? null : raw.slice(index + 1).map(projectMessage).filter((message) => message !== null);
  }
  const visible = raw.map(projectMessage).filter((message) => message !== null);
  return visible.length >= selection.count || !frame.hasMore ? visible.slice(-selection.count) : null;
}
/** Finish only this fixed-head prefix. Page session revisions never overwrite initial.revision. */
export async function completeHistory(api: AgentApi, frame: HistoryFrame, selection: MessageSelection): Promise<MessageView[]> {
  for (;;) {
    const selected = selectHistory(frame, selection);
    if (selected !== null) return selected;
    if (!frame.hasMore) throw new CliError(6, "消息锚点不属于此会话的当前可见分支。", { code: "ANCHOR_NOT_FOUND", phase: "history", effect: "not_applicable" });
    const cursor = frame.nextBeforeMessageId;
    const oldest = [...frame.messages.values()].reduce((a, b) => a.depth < b.depth ? a : b);
    if (!cursor || cursor !== oldest.id) throw changed();
    let page: TimelinePage;
    try { page = await readTimeline(api, frame.workspaceId, frame.sessionId, { mode: "before", beforeMessageId: cursor }); }
    catch (error) {
      if (error instanceof CliError && error.exitCode === 6) throw changed();
      throw error;
    }
    if (page.timelineReset || page.session.revision < frame.initial.session.revision || !page.messages.length) throw changed();
    checkChain(page.messages);
    const newest = page.messages.at(-1)!;
    if (newest.id !== oldest.previousMessageId || newest.depth >= oldest.depth || page.messages.some((message) => frame.messages.has(message.id))) throw changed();
    if (!page.hasMore && page.messages[0].previousMessageId !== null) throw changed();
    // A changed current head may be an append OR a revert. Prove H0 is still visible.
    if (page.session.headMessageId !== frame.initial.session.headMessageId && frame.initial.session.headMessageId !== null) {
      try {
        const head = await readMessage(api, frame.workspaceId, frame.sessionId, frame.initial.session.headMessageId);
        const original = frame.messages.get(head.id)!;
        if (head.previousMessageId !== original.previousMessageId || head.depth !== original.depth || head.updatedRevision < original.updatedRevision) throw changed();
      } catch (error) { if (error instanceof CliError && error.exitCode === 6) throw changed(); throw error; }
    }
    for (const message of page.messages) frame.messages.set(message.id, message);
    frame.hasMore = page.hasMore;
    frame.nextBeforeMessageId = page.nextBeforeMessageId;
  }
}
export function parseMessageSelection(options: { last?: string; after?: string }): MessageSelection {
  if ((options.last !== undefined) === (options.after !== undefined)) throw new CliError(2, "--after 与 -n/--last 必须恰好选择一个。");
  if (options.after !== undefined) return { mode: "after", messageId: validateId(options.after, true) };
  const count = Number(options.last);
  const match = /^[1-9][0-9]*$/.exec(options.last!);
  if (!match || match[0] !== options.last || !Number.isSafeInteger(count)) throw new CliError(2, "-n/--last 必须是无前导零的正安全整数。");
  return { mode: "last", count };
}
export function renderMessage(message: MessageView): string {
  const body = message.parts.map((part) => part.type === "text" ? displayBody(part.text) : `[图片 attachmentId=${escapeDisplayText(part.attachmentId)} mediaType=${part.mediaType} filename=${escapeDisplayText(part.filename)}]`).join("\n");
  return `Message ID：${escapeDisplayText(message.id)}；type=${message.type}；status=${message.status}\n${body}\n`;
}
export async function listMessages(workspaceId: string, sessionId: string, selection: MessageSelection, dependencies: ReadCommandDependencies): Promise<void> {
  try {
    const api = await AgentApi.connect(dependencies);
    const frame = await startHistory(api, workspaceId, sessionId);
    const items = await completeHistory(api, frame, selection);
    const data = { workspaceId, sessionId, selection, items, count: items.length, complete: true };
    await writeSuccess(dependencies.io, Boolean(dependencies.json), "session messages", data,
      items.map(renderMessage).join("\n") + `消息快照结束：已输出 ${items.length} 条普通消息。\n`, { phase: "history", effect: "not_applicable", context: { workspaceId, sessionId } });
  } catch (error) { throw withErrorDetails(error, { phase: "history", effect: "not_applicable", context: { workspaceId, sessionId } }); }
}
