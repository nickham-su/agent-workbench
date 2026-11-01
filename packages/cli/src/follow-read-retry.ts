import type { Writable } from "node:stream";
import { CliError } from "./errors.js";
import type { FollowLifetime } from "./follow-lifetime.js";
import { writeDiagnostic } from "./output.js";

const delays = [1000, 2000, 4000] as const;
function retryable(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  const evidence = error.retryEvidence;
  return evidence?.kind === "transport" || evidence?.kind === "request_timeout"
    || (evidence?.kind === "http_status" && [429, 502, 503, 504].includes(evidence.status));
}

/** Opt-in capability owned by one follow lifetime, never by the HTTP transport. */
export class FollowReadRetry {
  private diagnosticsAvailable = true;
  constructor(private readonly lifetime: FollowLifetime, private readonly stderr: Writable) {}

  /** AgentApi invokes this around exactly one GET, including validation/renewal. */
  async read<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.lifetime.check();
      let value: T;
      try { value = await this.lifetime.wait(request()); }
      catch (error) {
        this.lifetime.check(); // Local cancellation owns the error, even after a 503.
        if (attempt === delays.length || !retryable(error)) throw error;
        if (attempt === 0) await this.report("读取暂时失败，正在有限重试。\n");
        this.lifetime.check();
        await this.lifetime.delay(delays[attempt]);
        this.lifetime.check();
        continue;
      }
      if (attempt > 0) await this.report("读取已恢复。\n");
      this.lifetime.check();
      return value;
    }
  }
  private async report(text: string): Promise<void> {
    if (this.diagnosticsAvailable) this.diagnosticsAvailable = await writeDiagnostic(this.stderr, text, this.lifetime.signal);
  }
}
