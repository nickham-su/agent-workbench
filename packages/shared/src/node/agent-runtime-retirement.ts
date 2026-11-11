/** Reliable notification ONLY for executions whose real finally has already exited.
 * Reservations bound active + pending identities; never drop an unacknowledged exit.
 * Process exit remains the Manager's independent, incarnation-specific proof.
 */
export type RuntimeRetirementIdentity = { workspaceId: string; sessionId: string; runId: string; runtimeInstanceId: string };
export const MAX_RUNTIME_RETIREMENTS = 1024;
type Entry = { identity: RuntimeRetirementIdentity; pending: boolean; attempts: number; due: number };
export class AgentRuntimeRetirementNotifier {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  constructor(private readonly send: (identity: RuntimeRetirementIdentity) => Promise<{ retired: boolean }>,
    private readonly warn: () => void, private readonly retryBaseMs = 100) {}
  private key(input: RuntimeRetirementIdentity) { return JSON.stringify([input.runtimeInstanceId, input.workspaceId, input.sessionId, input.runId]); }
  get size() { return this.entries.size; }
  reserve(input: RuntimeRetirementIdentity) {
    const key = this.key(input);
    if (this.entries.has(key)) return;
    if (this.entries.size >= MAX_RUNTIME_RETIREMENTS) throw new Error("AGENT_RUNTIME_RETIREMENT_CAPACITY");
    const {workspaceId, sessionId, runId, runtimeInstanceId} = input;
    this.entries.set(key, { identity: {workspaceId, sessionId, runId, runtimeInstanceId}, pending: false, attempts: 0, due: 0 });
  }
  releaseUnstarted(input: RuntimeRetirementIdentity) {
    const key = this.key(input);
    if (!this.entries.get(key)?.pending) this.entries.delete(key);
  }
  notifyExited(input: RuntimeRetirementIdentity) {
    this.reserve(input);
    const entry = this.entries.get(this.key(input))!;
    entry.pending = true;
    this.schedule();
  }
  private schedule() {
    if (this.sending || this.timer) return;
    const next = [...this.entries.values()].filter(e => e.pending).sort((a,b) => a.due - b.due)[0];
    if (!next) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flushOne(); }, Math.max(0, next.due - Date.now()));
    this.timer.unref?.();
  }
  private async flushOne() {
    const entry = [...this.entries.values()].find(e => e.pending && e.due <= Date.now());
    if (!entry) { this.schedule(); return; }
    this.sending = true;
    try {
      const response = await this.send(entry.identity);
      if (!response.retired) throw new Error("AGENT_RUNTIME_RETIREMENT_UNCONFIRMED");
      this.entries.delete(this.key(entry.identity));
    } catch {
      if (entry.attempts === 0) this.warn();
      entry.due = Date.now() + Math.min(5000, this.retryBaseMs * 2 ** Math.min(entry.attempts++, 6));
    } finally { this.sending = false; this.schedule(); }
  }
  async drain(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.entries.size && Date.now() < deadline) {
      this.schedule();
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    return this.entries.size === 0;
  }
}
