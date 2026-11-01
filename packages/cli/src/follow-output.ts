import type { ErrorContext, CliExitCode } from "./errors.js";
import { CliError, withErrorDetails } from "./errors.js";
import type { MessageView } from "./messages.js";
import { MessageRenderer } from "./message-render.js";
import { writeText } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { CliIO } from "./token-input.js";
import type { ObservedRun } from "./run-status.js";
import type { FollowLifetime } from "./follow-lifetime.js";

export class FollowOutput {
  readonly emitted = new Map<string, MessageView>();
  readonly renderer: MessageRenderer;
  get released(): ReadonlySet<string> { return this.renderer.released; }
  started = false;
  private ended = false;
  constructor(private readonly io: CliIO, private readonly lifetime: FollowLifetime,
    readonly identity: ErrorContext & { workspaceId: string; sessionId: string }, readonly runId: string | null) {
    this.renderer = new MessageRenderer((text) => this.lifetime.wait(writeText(this.io.stdout, text)), "follow");
  }
  async metadata(command: string, extra: Record<string, unknown> = {}): Promise<void> {
    this.lifetime.check();
    const fields: [string, unknown][] = [["Workspace", this.identity.workspaceId], ["Session ID", this.identity.sessionId]];
    if (this.runId) fields.push(["Run ID", this.runId]);
    if (this.identity.agentId) fields.push(["Agent ID", this.identity.agentId]);
    if (this.identity.clientRequestId) fields.push(["clientRequestId", this.identity.clientRequestId]);
    // Only send acceptance identifies this as a user message, never an assistant pointer.
    if (command === "session send" && this.identity.messageId) fields.push(["用户消息 ID", this.identity.messageId]);
    if (typeof extra.sessionCreated === "boolean") fields.push(["sessionCreated", extra.sessionCreated]);
    const title = command === "session compact" ? "压缩请求已受理，正在执行。" : command === "session send"
      ? "请求已受理，正在执行。" : this.runId ? "正在读取并监听当前任务。" : "查询时没有活动任务，进行一次历史收尾。";
    this.started = true;
    await this.lifetime.wait(writeText(this.io.stdout, title + "\n" + fields.map(([key, value]) => `${key}：${escapeDisplayText(String(value))}`).join("\n") + "\n"));
  }
  async message(message: MessageView, _source: "history" | "follow"): Promise<void> {
    await this.renderer.message(message);
    this.emitted.set(message.id, message);
  }
  /** The coordinator must validate the proof and complete rebuild before calling. */
  async supersedeDraft(messageId: string): Promise<void> {
    await this.renderer.supersedeDraft(messageId);
    this.emitted.delete(messageId);
  }
  async terminal(outcome: string, complete: boolean, exitCode: CliExitCode, run: ObservedRun | null): Promise<void> {
    if (this.ended || !this.started || exitCode === 141) return;
    if (complete) this.lifetime.check();
    this.ended = true;
    const known = run && run.status !== "running" ? run : null;
    const result = known?.status === "completed" ? "执行成功" : known?.status === "failed" ? "执行失败"
      : known?.status === "cancelled" ? "执行已取消" : outcome === "no_active_run" ? "查询时没有活动任务"
      : outcome === "interrupted" ? "监听已中断；后台任务未因此取消" : "本地观察结束；后台任务未因此取消";
    const text = `监听结束：${result}；outcome=${outcome}${known ? `；runStatus=${known.status}；resultCode=${known.code}` : ""}；消息读取${complete ? "完整" : "不完整"}；complete=${complete}；exitCode=${exitCode}\n`;
    const output = writeText(this.io.stdout, text);
    if (complete) await this.lifetime.wait(output);
    else {
      // Failure terminals remain best effort after abort, never an unbounded pipe wait.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([output, new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); })]); }
      finally { clearTimeout(timer); }
    }
  }
  error(error: unknown): CliError {
    const context = { workspaceId: this.identity.workspaceId, sessionId: this.identity.sessionId,
      ...(this.identity.agentId ? { agentId: this.identity.agentId } : {}),
      ...(this.identity.clientRequestId ? { clientRequestId: this.identity.clientRequestId } : {}),
      ...(this.runId === null ? {} : { runId: this.runId }) };
    const safe = withErrorDetails(this.lifetime.failure(error), { phase: "follow", context });
    const { messageId: _unreleased, ...safeContext } = safe.details.context ?? {};
    return new CliError(safe.exitCode, safe.message, { ...safe.details, context: safeContext,
      effect: this.identity.clientRequestId ? "accepted" : safe.details.effect ?? "not_applicable" }, safe.retryEvidence);
  }
}
