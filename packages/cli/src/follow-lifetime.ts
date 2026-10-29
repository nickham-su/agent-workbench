import type { Writable } from "node:stream";
import { CliError } from "./errors.js";
import { parseDuration } from "./validation.js";

export interface FollowOptions { follow?: boolean; followTimeoutMs?: number; }
export function parseFollowOptions(options: { follow?: boolean; followTimeout?: string }): FollowOptions {
  if (options.followTimeout !== undefined && !options.follow) throw new CliError(2, "--follow-timeout 只能与 -f/--follow 一起使用。");
  return { follow: Boolean(options.follow), ...(options.followTimeout === undefined ? {} : { followTimeoutMs: parseDuration(options.followTimeout, 90 * 86400, "整体监听时限") * 1000 }) };
}
/** Owns only this local observation: never sends a remote cancellation. */
export class FollowLifetime {
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: number;
  private stopped?: CliError;
  readonly signal = this.controller.signal;
  private readonly interrupt = () => this.stop(new CliError(130, this.activity === "download" ? "已中断本地下载。" : "已中断本地监听，后台执行不会因此取消。"));
  private readonly terminate = () => this.stop(new CliError(143, this.activity === "download" ? "已终止本地下载。" : "已终止本地监听，后台执行不会因此取消。"));
  private readonly externalAbort = () => this.interrupt();
  private readonly outputError = (error: NodeJS.ErrnoException) => this.stop(new CliError(error.code === "EPIPE" ? 141 : 6, "输出已中断，已停止本地调用。"));
  constructor(private readonly stdout: Writable, private readonly external?: AbortSignal, private readonly activity: "follow" | "download" = "follow") {
    process.on("SIGINT", this.interrupt); process.on("SIGTERM", this.terminate);
    stdout.on("error", this.outputError);
    external?.addEventListener("abort", this.externalAbort, { once: true });
    if (external?.aborted) this.externalAbort();
  }
  begin(timeoutMs?: number): void {
    if (timeoutMs === undefined) return;
    this.deadline = performance.now() + timeoutMs;
    const arm = () => {
      const remaining = this.deadline! - performance.now();
      if (remaining <= 0) { this.stop(new CliError(10, "整体监听时限已耗尽，后台执行不会因此取消。")); return; }
      this.timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    };
    arm();
  }
  private stop(error: CliError): void {
    if (this.stopped) return;
    this.stopped = error;
    this.controller.abort();
  }
  check(): void {
    if (!this.stopped && this.deadline !== undefined && performance.now() >= this.deadline) this.stop(new CliError(10, "整体监听时限已耗尽，后台执行不会因此取消。"));
    if (this.stopped) throw this.stopped;
  }
  failure(error: unknown): unknown {
    if (!this.stopped) return error;
    return new CliError(this.stopped.exitCode, this.stopped.message, {
      ...(error instanceof CliError ? error.details : {}), ...this.stopped.details,
      // Resolve an absent stop code from errors.ts, never inherit the superseded cause's code.
      code: this.stopped.details.code
    });
  }
  async wait<T>(operation: Promise<T>): Promise<T> {
    try { this.check(); } catch (error) { void operation.catch(() => {}); throw error; }
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.stopped!);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try { const value = await Promise.race([operation, interrupted]); this.check(); return value; }
    finally { this.signal.removeEventListener("abort", onAbort); }
  }
  async delay(milliseconds = 1000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await this.wait(new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })); }
    finally { clearTimeout(timer); }
  }
  dispose(): void {
    clearTimeout(this.timer);
    process.removeListener("SIGINT", this.interrupt); process.removeListener("SIGTERM", this.terminate);
    this.stdout.removeListener("error", this.outputError);
    this.external?.removeEventListener("abort", this.externalAbort);
  }
}
