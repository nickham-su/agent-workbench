import type { ErrorContext, CliExitCode } from "./errors.js";
import { CliError, withErrorDetails } from "./errors.js";
import { renderMessage, type MessageView } from "./messages.js";
import { writeEvent, writeText } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { CliIO } from "./token-input.js";
import type { ObservedRun } from "./run-status.js";
import type { FollowLifetime } from "./follow-lifetime.js";

export class FollowOutput {
  readonly emitted = new Map<string, MessageView>();
  private readonly announced = new Set<string>();
  private readonly finished = new Set<string>();
  started = false;
  private ended = false;
  constructor(private readonly io: CliIO, private readonly json: boolean, private readonly lifetime: FollowLifetime,
    readonly identity: ErrorContext & { workspaceId: string; sessionId: string }, readonly runId: string | null) {}
  async metadata(command: string, extra: Record<string, unknown> = {}): Promise<void> {
    this.lifetime.check();
    const data = { command, ...this.identity, runId: this.runId, ...extra };
    this.started = true;
    await this.lifetime.wait(this.json ? writeEvent(this.io, { type: "metadata", ...data })
      : writeText(this.io.stdout, Object.entries(data).map(([key, value]) => `${key}：${escapeDisplayText(String(value))}`).join("\n") + "\n"));
  }
  async message(message: MessageView, source: "history" | "follow"): Promise<void> {
    const old = this.emitted.get(message.id);
    if (old && old.updatedRevision >= message.updatedRevision) return;
    if (this.json) await this.lifetime.wait(writeEvent(this.io, { type: "message", op: "upsert", source, message }));
    else if (message.status === "streaming") {
      if (!this.announced.has(message.id)) await this.lifetime.wait(writeText(this.io.stdout, `Message ID：${escapeDisplayText(message.id)}；生成中（尚非最终正文）\n`));
      this.announced.add(message.id);
    } else if (!this.finished.has(message.id)) {
      await this.lifetime.wait(writeText(this.io.stdout, renderMessage(message)));
      this.finished.add(message.id);
    }
    this.emitted.set(message.id, message);
  }
  async terminal(outcome: string, complete: boolean, exitCode: CliExitCode, run: ObservedRun | null): Promise<void> {
    if (this.ended || !this.started || exitCode === 141) return;
    if (complete) this.lifetime.check();
    this.ended = true;
    const data = { workspaceId: this.identity.workspaceId, sessionId: this.identity.sessionId, runId: this.runId, outcome,
      runStatus: run && run.status !== "running" ? run.status : null, resultCode: run && run.status !== "running" ? run.code : null, complete, exitCode };
    // Failure terminals are best effort after abort; do not wait forever on a blocked pipe.
    const output = this.json ? writeEvent(this.io, { type: "terminal", ...data })
      : writeText(this.io.stdout, `监听结束：${outcome}；complete=${complete}；exitCode=${exitCode}${data.resultCode ? `；resultCode=${data.resultCode}` : ""}\n`);
    if (complete) await this.lifetime.wait(output);
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([output, new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); })]); }
      finally { clearTimeout(timer); }
    }
  }
  error(error: unknown): CliError {
    const context = { ...this.identity, ...(this.runId === null ? {} : { runId: this.runId }) };
    const safe = withErrorDetails(this.lifetime.failure(error), { phase: "follow", context });
    return new CliError(safe.exitCode, safe.message, { ...safe.details, effect: this.identity.clientRequestId ? "accepted" : safe.details.effect ?? "not_applicable" });
  }
}
