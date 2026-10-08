export type ClockHealth = "normal" | "warning" | "uncertain" | "unavailable";
export type ClockSnapshot = { health: ClockHealth; offset: number | null; rtt: number | null; lastSuccess: number | null; retrying: boolean; serverNow: number | null; deviceNow: number };
const CLOCK_DRIFT_WARNING_MS = 60_000;
/** Server's epoch is sampled at t0..t1. The estimate is display-only, never a scheduling input. */
export class ServerClock {
  private lastSuccess: number | null = null;
  private offset: number | null = null;
  private rtt: number | null = null;
  private retrying = false;
  constructor(private readonly now: () => number = Date.now) {}
  /** The caller can revoke a pending sample before it changes the shared estimate. */
  async sync(fetchTime: () => Promise<{ now: number; protocolVersion: 1 }>,
    canCommit: () => boolean = () => true): Promise<ClockSnapshot> {
    const t0 = this.now();
    try {
      const response = await fetchTime();
      const t1 = this.now();
      if (response.protocolVersion !== 1 || !Number.isSafeInteger(response.now)) throw new Error("Invalid server time");
      if (canCommit()) {
        this.rtt = Math.max(0, t1 - t0);
        this.offset = response.now - (t0 + t1) / 2;
        this.lastSuccess = t1;
        this.retrying = false;
      }
    } catch { if (canCommit()) this.retrying = true; }
    return this.snapshot();
  }
  markFailure() { this.retrying = true; }
  snapshot(): ClockSnapshot {
    const deviceNow = this.now();
    const age = this.lastSuccess === null ? Infinity : Math.max(0, deviceNow - this.lastSuccess);
    const health: ClockHealth = age >= 120_000 ? "unavailable" : this.retrying || (this.rtt ?? Infinity) > 2000 ? "uncertain" : Math.abs(this.offset ?? 0) >= CLOCK_DRIFT_WARNING_MS ? "warning" : "normal";
    return { health, offset: this.offset, rtt: this.rtt, lastSuccess: this.lastSuccess, retrying: this.retrying && age < 120_000,
      serverNow: age < 120_000 && this.offset !== null ? deviceNow + this.offset : null, deviceNow };
  }
}
/** Visibility recovery requests immediately; a successful sync resets the 30-second cadence. */
export class ClockPoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private visible = false;
  private generation = 0;
  private latestRequest = 0;
  constructor(private readonly clock: ServerClock, private readonly fetchTime: () => Promise<{now: number; protocolVersion: 1}>,
    private readonly onUpdate: (snapshot: ClockSnapshot) => void,
    // Native browser timers require their global receiver; never store them unbound as methods.
    private readonly every: (fn: () => void, ms: number) => ReturnType<typeof setInterval> = (fn, ms) => globalThis.setInterval(fn, ms),
    private readonly clear: (id: ReturnType<typeof setInterval>) => void = (id) => globalThis.clearInterval(id)) {}
  private notify() {
    try { this.onUpdate(this.clock.snapshot()); }
    catch { this.clock.markFailure(); } // The clock must never break the host view's lifecycle.
  }
  private stopTimers() {
    const interval = this.interval, ticker = this.ticker;
    this.interval = this.ticker = null;
    // Attempt both clears even if a timer adapter fails; subsequent activation can retry.
    for (const id of [interval, ticker]) if (id !== null) {
      try { this.clear(id); } catch { this.clock.markFailure(); }
    }
  }
  private fail() {
    this.clock.markFailure();
    this.visible = false;
    this.generation++;
    this.stopTimers();
    this.notify();
  }
  private async request() {
    if (!this.visible) return;
    const generation = this.generation;
    const requestId = ++this.latestRequest;
    const current = () => this.visible && generation === this.generation && requestId === this.latestRequest;
    try {
      const snapshot = await this.clock.sync(this.fetchTime, current);
      if (!current()) return;
      this.onUpdate(snapshot);
      if (!snapshot.retrying) this.startInterval();
    } catch {
      if (current()) this.fail();
    } // Includes clock adapter, update, and timer-reset failures.
  }
  private startInterval() {
    if (this.interval !== null) this.clear(this.interval);
    const generation = this.generation;
    this.interval = this.every(() => { if (this.visible && generation === this.generation) void this.request(); }, 30_000);
  }
  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.generation++;
    if (!visible) { this.stopTimers(); return; }
    try {
      this.startInterval();
      const generation = this.generation;
      this.ticker = this.every(() => { if (this.visible && generation === this.generation) this.notify(); }, 1000);
      void this.request();
    } catch { this.fail(); }
  }
  dispose() { this.visible = false; this.generation++; this.stopTimers(); }
}
