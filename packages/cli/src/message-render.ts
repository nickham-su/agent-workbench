import { CliError } from "./errors.js";
import { displayBody } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { LayoutPart, MessageView } from "./messages.js";

const terminal = (message: MessageView) => ["completed", "failed", "cancelled"].includes(message.status);
function invalid(): never { throw new CliError(6, "消息身份、内容布局或正文不是合法追加，无法继续证明输出完整。", { code: "RESPONSE_INVALID", phase: "follow" }); }

/** Validate raw layout, including invisible parts, before deciding whether to display it. */
export function assertMessageAppend(previous: MessageView, next: MessageView): void {
  if (previous.id !== next.id || previous.type !== next.type || previous.depth !== next.depth
    || previous.previousMessageId !== next.previousMessageId || previous.originRunId !== next.originRunId
    || previous.originSessionId !== next.originSessionId || next.updatedRevision < previous.updatedRevision
    || next.layoutParts.length < previous.layoutParts.length) invalid();
  if (terminal(previous) && (next.status !== previous.status || next.layoutParts.length !== previous.layoutParts.length)) invalid();
  for (let index = 0; index < previous.layoutParts.length; index++) {
    const old = previous.layoutParts[index]; const part = next.layoutParts[index];
    if (!part || part.id !== old.id || part.position !== old.position || part.type !== old.type
      || part.updatedRevision < old.updatedRevision) invalid();
    if (old.type === "text") {
      if (part.type !== "text" || !part.text.startsWith(old.text)
        || ((index < previous.layoutParts.length - 1 || terminal(previous)) && part.text !== old.text)) invalid();
    } else if (old.type === "image") {
      if (part.type !== "image" || part.attachmentId !== old.attachmentId || part.mediaType !== old.mediaType || part.filename !== old.filename) invalid();
    } else if (part.type !== "hidden" || part.kind !== old.kind) invalid();
  }
  const oldEnd = previous.layoutParts.at(-1)?.position ?? -1;
  for (const part of next.layoutParts.slice(previous.layoutParts.length)) if (part.position <= oldEnd) invalid();
  // A revision is a version, not permission to silently mutate an accepted version.
  if (next.updatedRevision === previous.updatedRevision
    && (next.status !== previous.status || JSON.stringify(next.layoutParts) !== JSON.stringify(previous.layoutParts))) invalid();
}

function partBody(part: LayoutPart, sealed: boolean): string | null {
  if (part.type === "hidden") return null;
  if (part.type === "image") return `[图片 attachmentId=${escapeDisplayText(part.attachmentId)} mediaType=${part.mediaType} filename=${escapeDisplayText(part.filename)}]`;
  let text = part.text;
  if (!sealed && text.length) {
    const last = text.charCodeAt(text.length - 1);
    if (last === 13 || (last >= 0xd800 && last <= 0xdbff)) text = text.slice(0, -1);
  }
  return displayBody(text);
}

/** One normalization for snapshots and streaming; only the flush boundary differs. */
export function messageBody(message: MessageView, mode: "follow" | "snapshot"): string {
  return message.layoutParts.map((part, index) => partBody(part,
    mode === "snapshot" || terminal(message) || index < message.layoutParts.length - 1))
    .filter((value): value is string => value !== null).join("\n");
}
function messageHeader(message: MessageView): string {
  return `${message.type === "user" ? "用户消息" : "助手回复"}${message.status === "streaming" ? "（生成中）" : ""}：\n`;
}
function messageFooter(message: MessageView): string {
  const label = message.status === "completed" ? "已完成" : message.status === "failed" ? "失败" : "已取消";
  return `\n—— 本条${message.type === "user" ? "消息" : "回复"}${label} ——\n消息 ID：${escapeDisplayText(message.id)}\n`;
}
export interface MessageRenderState {
  raw: MessageView;
  writtenBody: string;
  headerWritten: boolean;
  footerWritten: boolean;
  outputMode: "follow" | "snapshot";
  businessSealed: boolean;
  pendingTail: string;
  localFlushComplete: boolean;
}

/** Output progress is committed only after the actual Writable callback succeeds. */
export class MessageRenderer {
  readonly states = new Map<string, MessageRenderState>();
  readonly released = new Set<string>();
  /** Retired identities need replay protection, never another retained draft body. */
  private readonly supersededIds = new Set<string>();
  constructor(private readonly write: (text: string) => Promise<void>, private readonly mode: "follow" | "snapshot") {}
  async message(message: MessageView): Promise<void> {
    if (this.supersededIds.has(message.id)) invalid();
    let state = this.states.get(message.id);
    if (state) {
      if (state.localFlushComplete && this.mode === "snapshot") invalid();
      assertMessageAppend(state.raw, message);
    } else {
      state = { raw: message, writtenBody: "", headerWritten: false, footerWritten: false,
        outputMode: this.mode, businessSealed: terminal(message), pendingTail: "", localFlushComplete: false };
      this.states.set(message.id, state);
    }
    const body = messageBody(message, this.mode);
    if (!body.startsWith(state.writtenBody)) invalid();
    if (!state.headerWritten) { await this.write(messageHeader(message)); state.headerWritten = true; }
    const suffix = body.slice(state.writtenBody.length);
    if (suffix) { await this.write(suffix); state.writtenBody = body; }
    if (terminal(message) && !state.footerWritten) {
      // ID cannot enter the stream until all body callbacks above have completed.
      await this.write(messageFooter(message));
      state.footerWritten = true; this.released.add(message.id);
    } else if (this.mode === "snapshot" && !terminal(message)) {
      await this.write("\n—— 本条回复仍在生成；以上为当前快照 ——\n");
    }
    state.raw = message;
    state.businessSealed = terminal(message);
    const last = message.layoutParts.at(-1);
    const tail = last?.type === "text" ? last.text.slice(-1) : "";
    const code = tail.charCodeAt(0);
    state.pendingTail = this.mode === "follow" && !terminal(message) && (tail === "\r" || code >= 0xd800 && code <= 0xdbff) ? tail : "";
    state.localFlushComplete = this.mode === "snapshot";
  }
  /** Caller must first prove the legal same-Run replacement and validate its whole stage. */
  async supersedeDraft(messageId: string): Promise<void> {
    if (this.supersededIds.has(messageId) || this.released.has(messageId)) invalid();
    const state = this.states.get(messageId);
    if (state) {
      if (state.footerWritten || terminal(state.raw)) invalid();
      if (state.headerWritten) await this.write("\n—— 上一段草稿已作废，正在重试 ——\n");
    }
    // Commit retirement only after the separator callback succeeds. A failed write
    // leaves the old state intact; success drops raw/layout/body/tail references.
    this.states.delete(messageId);
    this.supersededIds.add(messageId);
  }
}
